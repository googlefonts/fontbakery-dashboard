#! /usr/bin/env node
"use strict";
// this is expected to run in nodejs
/* global require */
/* jshint esnext:true */

const express = require('express')
  , http = require('http')
  , socketio = require('socket.io')
  , path = require('path')
  , messages_pb = require('protocolbuffers/messages_pb')
  , { IOOperations } = require('./util/IOOperations')
  , { CacheClient }  = require('./util/CacheClient')
  , { ReportsClient } = require('./util/ReportsClient')
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
function _BaseServer(logging, portNum, amqpSetup, dbSetup, cacheSetup
                                , reportsSetup) {
    //jshint validthis:true
    this._log = logging;
    this._portNum = portNum;
    this._app = express();
    this._httpServer = http.createServer(this._app);
    this._sio = socketio(this._httpServer);

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
                ()=>new IOOperations(this._log, dbSetup, amqpSetup)
              , 'init'
            ]
        ]
      , ['cache', [
                ()=>new CacheClient(
                                this._log
                              , cacheSetup.host, cacheSetup.port
                              , messages_pb, 'fontbakery.dashboard')
              , 'waitForReady'
            ]
        ]
      , ['reports', [()=>new ReportsClient(
                                this._log, reportsSetup.host
                              , reportsSetup.port)
              , 'waitForReady'
            ]
        ]
    ]);
    this._DIResourcesCache = new Map();
    this._DIResourcesCache.set('*app:/', this._app); // root express app
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
    if(!this._DIResourcesCache.has(key)) {
        if(name === '*app') {
            // a special case
            // name is e.g. : *app:/dispatcher
            let subApp = express();
            this._app.get(appLocation, subApp); // register with root app
            this._DIResourcesCache.set(key, subApp);
        }
        else if (this._DIResourceBuilders.has(key)) {
            let [builder, initFunc] = this._DIResourceBuilders.get(key)
              , resource = builder.call(this)
              ;
            // initFinc is e.g. 'waitForReady' for gRPC clients
            if(initFunc)
                promise = resource[initFunc]();
            this._DIResourcesCache.set(key, resource);
        }
        else
            throw new Error('Don\'t know how to get resource named "'+name+'".');
    }
    return [this._DIResourcesCache.get(key), promise];
};

_p._initService = function(appLocation, Constructor, dependencies) {
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
    this._socketListeners.push(eventName, eventHandler, disconnectHandler);
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
_p._socketOnSubscribe = function(socket, eventName, handler, data) {
    this._log.info('_onSocketConnect: socket', socket.id ,'subscription '
                                        + 'requested for', eventName, data);
    if(typeof data.id !== 'string')
        // this is actually required (historically)
        // ??? why can't we fix this with an error?
        // and at the position where data.id is actually needed/evaluated?
        data.id = '';
    handler.call(this, socket, data);
};

_p._socketOnDisconnect = function(socket, eventName, handler, reason) {
    this._log.debug('socket:', socket.id
                        , 'disconnecting from:', eventName
                        , 'reason:', reason);
    handler.call(this, socket);
};


_p._subscribeToSocketEvent = function(socket, eventName
                                    , eventHandler, disconnectHandler) {
    socket.on(eventName, data=>this._socketOnSubscribe(
                socket, eventName, eventHandler, data));
    if(disconnectHandler)
        socket.on('disconnecting',reason=>this._socketOnDisconnect(
                socket, eventName, disconnectHandler, reason));
};

_p._onSocketConnect = function(socket) {
    // wait for docid request ...
    // extracting [HEAD, ...TAIL] from the values of this._socketListeners
    for(let [eventName, ...handlers] of this._socketListeners)
        this._subscribeToSocketEvent(socket, eventName, ...handlers);
};

exports._BaseServer = _BaseServer;
