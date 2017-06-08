#! /usr/bin/env node
"use strict";
// this is expected to run in nodejs
/* global require, module */
/* jshint esnext:true */

const express = require('express')
  , http = require('http')
  , socketio = require('socket.io')
  , rethinkdbdash = require('rethinkdbdash')
  , path = require('path')
  , bodyParser = require('body-parser')
  , StringDecoder = require('string_decoder').StringDecoder
  // https://github.com/squaremo/amqp.node
  , amqplib = require('amqplib')
  ;

var ROOT_PATH = __dirname.split(path.sep).slice(0, -1).join(path.sep);

function Logging(loglevel) {
    this._numericLoglevel = this._levels[loglevel];
}
Logging.prototype._levels = {};

([
  , ['DEBUG', 10, console.info]
  , ['INFO', 20, console.info]
  , ['WARNING', 30, console.warn]
  , ['ERROR', 40, console.error]
  , ['CRITICAL', 50, console.error]
]).forEach(function(setup) {
    // method names: debug, info, warning, etc..
    var loglevel = setup[0]
      , method = loglevel.toLowerCase()
      , numeric = setup[1]
      , log = setup[2]
      ;
    Logging.prototype._levels[loglevel] = numeric;
    Logging.prototype[method] = function() {
        if(numeric < this._numericLoglevel)
            return;
        var args = [loglevel], i, l;
        for(i=0,l=arguments.length;i<l;i++)
            args.push(arguments[i]);
        log.apply(null, args);
    };
});

/**
 * Using a class here, so state variables are managed not on module level
 * Initialization starts the server.
 *
 */
function Server(logging, portNum,  amqpSetup, rethinkSetup) {
    this._log = logging;
    this._portNum = portNum;
    this._dbName = rethinkSetup.db;
    this._dbTable = 'draganddrop';
    this._app = express();
    this._server = http.createServer(this._app);
    this._sio = socketio(this._server);

    this._r = rethinkdbdash(rethinkSetup);

    this._amqpConnection = null;
    this._queueName = 'drag_and_drop_queue';
    // Start serving when the database and rabbitmq queue is ready
    Promise.all([
                 this._initDB()
               , this._initAmqp()
               ])
    .then(this._listen.bind(this))
    .catch(function(err) {
        this._log.error('Can\'t initialize server.', err);
        process.exit(1);
    }.bind(this));

    this._app.get('/', this.fbDNDIndex.bind(this));
    this._app.use('/static', express.static('lib/static'));
    this._app.get('/report/:docid', this.fbDNDReport.bind(this));

    this._app.use('/runchecks', bodyParser.raw(
                    {type: 'application/octet-stream', limit: '15mb'}));
    this._app.post('/runchecks', this.fbDNDReceive.bind(this));
    this._sio.on('connection', this.fbDNDSocketConnect.bind(this));
}

var _p = Server.prototype;

_p._initDB = function() {
    var createDatabase, createTable;

    createDatabase = function() {
        return this._r.dbCreate(this._dbName)
            .run()
            //.then(function(response) {/* pass */})
            .error(function(err){
                if (err.message.indexOf('already exists') !== -1)
                    return;
                throw err;
            });

    }.bind(this);

    createTable = function() {
        return this._r.tableCreate(this._dbTable)
            .run()
            //.then(function(response) {/* pass */})
            .error(function(err){
            if (err.message.indexOf('already exists') !== -1)
                return;
            throw err;
        });
    }.bind(this);

    return createDatabase()
        .then(createTable)
        .error(function(err) {
            // It's not an error if the table already exists
            this._log.warning('Error while initializing database.', err);
            throw err;
        }.bind(this));
};

_p._initAmqp = function() {
    return amqplib.connect('amqp://' + amqpSetup.host)
            .then(function(connection) {
                process.once('SIGINT', connection.close.bind(connection));

                this._amqpConnection = connection;
            }.bind(this))
            .catch(function(err) {
                this._log.error('Error while connecting to queue.', err);
                throw err;
            }.bind(this));
};

_p._listen = function() {
    this._server.listen(this._portNum);
    this._log.info('Listening to port', this._portNum);
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
_p.fbDNDIndex = function(req, res) {
    return res.sendFile('static/html/drag-and-drop-client.html',
                                                    { root: ROOT_PATH});
};


/**
 * This is almost a copy of the clients Controller.unpack method
 */
_p.unpack = function(data) {
    var offset = 0, head, json, font, decoder
        , result = []
        ;

    while(offset < data.byteLength) {
        head = new DataView(data.buffer, offset, 8);
        head = [head.getUint32(0, true), head.getUint32(4, true)];
        offset += 8;

        json = new Uint8Array(data.buffer, offset, head[0]);
        offset += json.byteLength;
        decoder = new StringDecoder('utf8');
        json = JSON.parse(decoder.write(Buffer.from(json)));

        font = new Uint8Array(data.buffer, offset, head[1]);
        offset += font.byteLength;

        result.push([json, font]);
    }
    return result;
};

_p._query = function() {
    return this._r.table(this._dbTable);
};

/**
 * GET docid
 *
 * Loads the report page client, which receives its information via socket.io
 *
 * SERVER
 *   : test if docid exists
 * CLIENT
 *   : same as fbDNDIndex on success
 */
_p.fbDNDReport = function(req, res, next) {
    var docid = req.param('docid');
    return this._query().getAll(docid).count()
        .then(function(found) {
            if(found)
                // This is the same client as the index page,
                // after the docid was returned
                return this.fbDNDIndex(req, res, next);
            // answer 404: NotFound
            return res.status(404).send('Not found');
        }.bind(this))
        .catch(next);
};

/**
 * Almost straight copy from the clients Controller.js
 */
function mergeArrays(arrays) {
    var jobSize = arrays.reduce(function(prev, cur) {
                                return prev + cur.byteLength; }, 0)
      , result, i, l, offset
      ;
    result = new Buffer(jobSize);
    for(i=0,l=arrays.length,offset=0; i<l;offset+=arrays[i].byteLength, i++)
        result.set(new Buffer(arrays[i].buffer), offset);
    return result;
}

_p._onCreateAMQPChannel = function  (docid, payload, channel) {
    this._log.debug('_onCreateAMQPChannel', docid);
    var options = {
            // TODO: do we need persistent here?
            persistent: true
            // this? , deliveryMode: true
        }
        // a buffer
      , content
        // expecting doc id to be only ASCII chars, because serializing
        // higher unicode is not that straight forward.
      , docidArray = Uint8Array.from(docid,
                            function(chr){ return chr.charCodeAt(0);})
      , docidLen = new Uint32Array(1)
      ;
    docidLen[0] = docidArray.byteLength;
    this._log.debug('docidLen is', docidArray.byteLength
                                                , 'for docid:', docid);

    content = mergeArrays([docidLen, docidArray, payload]);
    function onAssert() {
        // jshint validthis:true
        this._log.info('sendToQueue doc', docid, 'queue', this._queueName
                                        , content.byteLength, 'Bytes');
        return channel.sendToQueue(this._queueName, content, options);
    }
    return channel.assertQueue(this._queueName, {durable: true})
           .then(onAssert.bind(this))
           .finally(function(){ channel.close(); })
           ;
};

_p._onDocCreated = function(req, res, next, dbResponse) {
    this._log.debug('_onDocCreated','dbResponse', dbResponse);
    var docid = dbResponse.generated_keys[0]
      , payload = req.body
      ;

    this._log.debug('creating amqp channel');
    return this._amqpConnection.createChannel()
        .then(this._onCreateAMQPChannel.bind(this, docid, payload))
        .then(function(){ return docid; })
        .catch(function(err) {
            this._log.warning('Can\'t create channel.', err);
            throw err;
        }.bind(this));
};

/**
 * POST AJAX, a blob
 * SERVER
 *   : create a testrun document => docid
 *   : dispatch job to worker
 *   : return docid and the new URL. Because we want to use
 *         also the browser history.pushState api. Ideally the server
 *         would send how to change urls to the client, because the browser
 *         must do the static urls (though the client has at the moment some
 *         understanding of this url when the site is visited directly, which
 *         is not optimal)
 */
_p.fbDNDReceive = function(req, res, next) {

    // var files = this.unpack(req.body)
    var doc = {
           isFinished: false
         , created: new Date()
        }
      ;
    function success(docid) {
        //jshint validthis:true
        this._log.debug('Sending response:', docid);
        res.setHeader('Content-Type', 'application/json');
        res.send(JSON.stringify({docid: docid, url: 'report/' + docid}));
    }
    this._query().insert(doc)
            .run()
            .then(this._onDocCreated.bind(this, req, res, next))
            .then(success.bind(this))
            .error(function(err) {
                this._log.error('Creating a doc failed ', err);
                next(err);
            }.bind(this));
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
 * this._sio.on('connection', this.fbDNDSocketConnect.bind(this));
 *
 */
_p.fbDNDSocketConnect = function(socket) {
    // wait for docid request ...
    socket.on('subscribe-changes', function (data) {
        this._log.info('fbDNDSocketConnectchanges subscription requested for', data);
        // simple sanitation, all strings are valid requests so far
        if(typeof data.docid !== 'string')
            // this is actually required
            data.docid = '';
        this._subscribeToDoc(socket, data);
    }.bind(this));
};

/**
 *  rethink chnangefeed
 *  : on change
 *      socketio send change info
 *      if doc is finished:
 *          close socket
 *          close changefeed
 *  : on error
 *      close socket
 *      close changefeed
 *  : on end/close
 *      close socket
 *      close changefeed
 */
_p._fbDNDRethinkChangeFeed = function(cursor, socket, channel, err, data) {
    if (err) {
        // TODO: Handle error
        this._log.error('Fail receivng change feed data.', err);
        return;
    }
    socket.emit(channel, data);
    if(data.newVal && data.newVal.isFinished) {
        // don't use close=true if only the namespace needs closing
        cursor.close(this._log.error.bind(this._log));
        var close=true;
        socket.disconnect(close);
    }
};

/**
 * data.docid is the rethink db document UUID.
 */
_p._subscribeToDoc = function(socket, data) {
    this._query().get(data.docid)
        .changes({includeInitial: true, squash: 0.3})
        .run(function(err, cursor) {
            if(err) {
                this._log.error('Can\'t acquire change feed.', err);
                throw err;
            }
            cursor.each(this._fbDNDRethinkChangeFeed.bind(this
                                        , cursor, socket, 'changes'));
        }.bind(this), {cursor: true});
};


if (typeof require != 'undefined' && require.main==module) {

    var rethinkSetup = {
            host: process.env.RETHINKDB_DRIVER_SERVICE_HOST
          , port: process.env.RETHINKDB_DRIVER_SERVICE_PORT
          , db: 'fontbakery'
        }
      , amqpSetup = {
            host: process.env.RABBITMQ_SERVICE_SERVICE_HOST
                        || process.env.BROKER
                        || 'amqp://localhost'
        }
      , logging = new Logging(process.env.FONTBAKERY_LOG_LEVEL || 'INFO')
      ;

    logging.info('Init server ...');
    new Server(logging, 3000, amqpSetup, rethinkSetup);
}


