#! /usr/bin/env node
"use strict";
/* jshint esnext:true, node:true */

const express = require('express')
  , http = require('http')
  , socketio = require('socket.io')
  , path = require('path')
  , messages_pb = require('protocolbuffers/messages_pb')
  , { IOOperations } = require('./util/IOOperations')
  , { CacheClient }  = require('./util/CacheClient')
  , { ReportsClient } = require('./util/ReportsClient')
  , { DispatcherProcessManagerClient } = require('./util/DispatcherProcessManagerClient')
  , { GitHubAuthClient } = require('./util/GitHubAuthClient')
  , ROOT_PATH = __dirname.split(path.sep).slice(0, -1).join(path.sep)
  ;


/**
 * Using a class here, so state variables are managed not on module level
 * Initialization starts the server.
 *
 * NOTE: this is in a state of rewrite to better separate the concerns
 * of providing resources and connection to the outside word versus the
 * actual business logic implementation.
 * The sub-apps and this are rather tightly coupled.
 */
function _BaseServer(logging, portNum, setup) {
    //jshint validthis:true
    this._log = logging;
    this._portNum = portNum;
    this._app = express();
    this._httpServer = http.createServer(this._app);
    this._sio = socketio(this._httpServer);
    this._socketListeners = [];

    var serveStandardClient = this.fbIndex.bind(this);
    Object.defineProperty(this, 'serveStandardClient', {
        value: serveStandardClient
    });

    // dependency injection resources
    //         name: [builder, initFunctionName]
    this._DIResourceBuilders = new Map([
        ['server', [()=>this, null]]
      , ['log', [()=>this._log, null]]
      , ['io', [
                ()=>new IOOperations(this._log, setup.db, setup.amqp)
              , 'init'
            ]
        ]
      , ['cache', [
                ()=>new CacheClient(
                                this._log
                              , setup.cache.host, setup.cache.port
                              , messages_pb, 'fontbakery.dashboard')
              , 'waitForReady'
            ]
        ]
      , ['reports', [()=>new ReportsClient(
                                this._log, setup.reports.host
                              , setup.reports.port)
              , 'waitForReady'
            ]
        ]
      , ['dispatcher', [
                ()=>new DispatcherProcessManagerClient(
                                this._log
                              , setup.dispatcher.host
                              , setup.dispatcher.port)
              , 'waitForReady'
            ]
        ]
      , ['ghauth', [
                ()=>new GitHubAuthClient(
                                this._log
                              , setup.gitHubAuth.host
                              , setup.gitHubAuth.port)
              , 'waitForReady'
            ]
        ]
    ]);
    this._resources = new Map();
    this._resources.set('*app:/', this._app); // root express app
    var promises;
    [this._services, promises] = this._initServices();

    // Start serving when the database and rabbitmq queue is ready
    Promise.all(promises)
    .then(this._listen.bind(this))
    .catch(function(err) {
        this._log.error('Can\'t initialize server.', err);
        process.exit(1);
    }.bind(this));

    this._sio.on('connection', this._onSocketConnect.bind(this));
}

var _p = _BaseServer.prototype;

_p._serviceDefinitions = [];

_p._getServiceDependency = function(appLocation, name) {
    var promise = null;
    let key = name === '*app'
                        ? [name, appLocation].join(':')
                        : name
                        ;
    if(!this._resources.has(key)) {
        if(name === '*app') {
            // a special case
            // name is e.g. : *app:/dispatcher
            let subApp = express();
            this._app.use(appLocation, subApp); // register with root app
            this._resources.set(key, subApp);
        }
        else if (this._DIResourceBuilders.has(key)) {
            let [builder, initFunc] = this._DIResourceBuilders.get(key)
              , resource = builder.call(this)
              ;
            // initFunc is e.g. 'waitForReady' for gRPC clients
            if(initFunc)
                promise = resource[initFunc]();
            this._resources.set(key, resource);
        }
        else
            throw new Error('Don\'t know how to acquire resource named "'+name+'".');
    }
    return [this._resources.get(key), promise];
};

_p._initService = function(appLocation, Constructor, dependencies) {
    this._log.info('Initializing service', Constructor.name, 'at', appLocation);
    var service
      , promises = []
      , args = []
      ;
    for(let name of dependencies) {
        let [dependency, promise] = this._getServiceDependency(appLocation, name);
        args.push(dependency);
        if(promise)
            promises.push(promise);
    }
    service = new Constructor(...args);
    return [service, promises];
};

_p._initServices = function() {
    var services = []
      , promises = []
      ;
    for(let definition of this._serviceDefinitions) {
        let [service, promises_] = this._initService(...definition);
        services.push(service);
        promises.push(...promises_);
    }
    return [services, promises];
};

_p._listen = function() {
    this._httpServer.listen(this._portNum);
    this._log.info('Listening to port', this._portNum);
};

_p.registerSocketListener = function(eventName, eventHandler, disconnectHandler){
    this._socketListeners.push([eventName, eventHandler, disconnectHandler]);
};

/**
 * GET
 *
 * CLIENT
 *  : say hello
 *  : initiate the d'n'd interface to post fonts
 *        on success
 *        change url to docid url
 *        init socketio connection for docid (with answer from post)
 */
_p.fbIndex = function(req, res, next) {
    // jshint unused:vars
    return res.sendFile('browser/html/client.html',
                                                    {root: ROOT_PATH});
};

/**
 * socketio connect
  SERVER
    : on connect
        test if docid exists
        create rethinkdb change feed for docid
        store change feed and connection together
    : on disconnect
        (implicitly: close socket)
        close changefeed
    : on error???
        close changefeed
        close socket
 *
 * wrap in:
 *
 * this._sio.on('connection', this._onSocketConnect.bind(this));
 *
 */
_p._socketOnSubscribe = function(socket, eventName, handler, ...data_callback) {
    var [data, ...moredata_callback] = data_callback;
    this._log.info('_onSocketConnect: socket', socket.id ,'subscription '
                                        + 'requested for', eventName, data, ...moredata_callback);
    if(typeof data === 'object' && typeof data.id !== 'string')
        // this is actually required (historically)
        // ??? why can't we fix this with an error?
        // and at the position where data.id is actually needed/evaluated?
        // FIXME: this should be fixed where it is expected.
        // execute-dispatcher-process already uses a string for sessionId
        // in the prosition of the data argument ...
        data.id = '';
    handler.call(this, socket, data, ...moredata_callback);
};

_p._socketOnDisconnect = function(socket, reason) {
    for(let [eventName, , disconnectHandler] of this._socketListeners) {
        if(!disconnectHandler)
            continue;
        this._log.debug('socket:', socket.id
                        , 'disconnecting from:', eventName
                        , 'reason:', reason);
        disconnectHandler.call(this, socket);
    }
};


_p._subscribeToSocketEvent = function(socket, eventName, eventHandler) {
    socket.on(eventName, (...data_callback)=>this._socketOnSubscribe(
                socket, eventName, eventHandler, ...data_callback));
};

_p._onSocketConnect = function(socket) {
    // wait for docid request ...
    // extracting [HEAD, ...TAIL] from the values of this._socketListeners
    for(let [eventName, eventHandler, ] of this._socketListeners) {
        if(!eventHandler)
            continue;
        this._subscribeToSocketEvent(socket, eventName, eventHandler);
    }
    socket.on('disconnecting',reason=>this._socketOnDisconnect(socket, reason));
};

function RootService(server, app, logging) {
    this._server = server;
    this._app = app;
    this._log = logging;
    // the client decides what to serve here as default
    this._app.get('/', this._server.serveStandardClient);
    this._app.use('/browser', express.static('browser'));
}

exports._BaseServer = _BaseServer;
exports.RootService = RootService;
