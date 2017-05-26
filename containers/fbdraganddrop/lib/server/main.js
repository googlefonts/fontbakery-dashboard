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

/**
 * Using a class here, so state variables are managed not on module level
 * Initialization starts the server.
 *
 */
function Server(portNum,  amqpSetup, rethinkSetup) {
    this._portNum = portNum;
    this._dbName = rethinkSetup.db;
    this._dbTable = 'draganddrop';
    this._app = express();
    this._server = http.createServer(this._app);
    this._sio = socketio(this._server);


    this._r = rethinkdbdash(rethinkSetup);
    this._amqpConnection = null;
    // Start serving when the database and rabbitmq queue is ready
    Promise.all([
            this._initDB()
          , this._initAmqp()
    ]).then(this.listen.bind(this))
    .catch(function(err){
        console.error('Can\'t initialize server.', err)
        process.exit(1);
    });

    this._app.get('/', this.fbDNDIndex.bind(this));
    this._app.use('/static', express.static('lib/static'));
    this._app.get('/report/:docid', this.fbDNDReport.bind(this));

    this._app.use('/runchecks',bodyParser.raw(
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
            // it's not an error if the table already exists
            console.error('Error while initializing database.', err);
            throw err;
        });
};

_p._initAmqp = function() {
    return amqplib.connect('amqp://' + amqpSetup.host)
            .then(function(connection) {
                this._amqpConnection = connection;
            }.bind(this))
                        .error(function(err) {
                // it's not an error if the table already exists
                console.error('Error while connecting to queue.', err);
                throw err;
            });
};

_p.listen = function() {
    this._server.listen(this._portNum);
};

/**
 * GET
 *
 * CLIENT
 *  : say hello
 *  : initiate the d'n'd interface
 *  : post fonts
 *      : then init socketio connection for docid
 *        // change url to docid url
 *        // open socketio connecion with answer from post
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

/**
 * GET docid
 *
 * Loads the report page client, which receives its information via socket.io
 *
 * SERVER
 *   : test if docid exists
 * CLIENT
 *   :
 */
_p.fbDNDReport = function(req, res) {
    var docid = req.param('docid');

    console.log('fbDNDReport docid:', docid);
    // TODO: if there's no docid with docid return 404

    // at the client:
    // <script src="/socket.io/socket.io.js"></script>
    // The js library is at this route automatically

    // this is the same as the index page after the docid was returned
    // so maybe we need to initialize the client with the docid
    // or something that is specific
    return this.fbDNDIndex(req, res);
};

/**
 * Straight copy from the clients Controller.js
 */
function mergeArrays(arrays) {
    var jobSize = arrays.reduce(function(prev, cur){
                                return prev + cur.byteLength; }, 0)
      , result, i, l, offset
      ;
    result = new Uint8Array(jobSize);
    for(i=0,l=arrays.length,offset=0; i<l;offset+=arrays[i].byteLength, i++)
        result.set(new Uint8Array(arrays[i]), offset);
    return result.buffer;
}

_p._onDocCreated = function(req, res, dbResponse) {
    console.error('dbResponse', dbResponse, Array.from(arguments).slice(3));
    var docid = dbResponse.generated_keys[0];
    res.setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify({docid: docid, url: 'report/' + docid}));



    this._amqpConnection.createChannel(function(err, channel) {
        if(err) {
            console.err('Can\'t create channel.', err);
            return;
        }
        var exchange = ''
          , routingKey = 'drag_and_drop_queue'
          , options = {
                        // TODO: do we need persistence here?
                        persistent: true
                    }
            // a buffer
          , content
            // expecting doc id to be only ASCII chars
          , docidArray = Uint8Array.from(docid,
                                function(chr){ return chr.charCodeAt(0);})
          , docidLen = new Uint32Array(1)
          ;
        docidLen[0] = docidArray.byteLength;
        content = mergeArrays([docidLen, docidArray, req.body]);
        channel.publish(exchange, routingKey, content.buffer, options);

    });
};

/**
 * POST AJAX
 * SERVER
 *   : create a testrun document => docid
 *   : with an in-progress status for each fontfile
 *   : with an in-progress status for the testrun document (?)
 *   : dispatch job for worker
 *   : return docid OR maybe the new URL? because we want to use
 *         also the browser history.pushState api. Ideally the server
 *         would send how to change urls to the client, because the browser
 *         must do the static urls.
 */
_p.fbDNDReceive = function(req, res) {
    var files = this.unpack(req.body)
      , doc = {
           isFinished: false
         , files: files.map(function(file){return {filename: file[0].filename};})
        }
      ;


    this._r.table(this._dbTable)
           .insert(doc)
            .run()
            .then(this._onDocCreated.bind(this, req, res))
            .error(function(err) {
                console.error('Creating a doc failed ', err);
            });
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
        console.log('changes subscription requested for', data);
        // simple sanitation, all strings are valid requests so far
        if(typeof data.docid !== 'string')
            // this is actually required
            data.docid = '';
        this._subscribeToDoc(socket, data);
    }.bind(this));



    // We don't listen to client sent events at this point
    // socket.on('event', function(data){});

//    var changeFeed = this._r. QUERY(docid) .change; //( . . . this.fbDNDRethinkChangeFeed.bind(this) ).run();
//  this._sockets.set(socket, changeFeed);


//    socket.on('disconnect', function(){
//        var changeFeed = this._sockets.get(socket);
//        changeFeed.close();
//
//        // don't use close=true if only the namespace needs closing
//        // var close=true
//        // socket.disconnect(close)
//
//        this._sockets.remove(socket);
//    });
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
_p._fbDNDRethinkChangeFeed = function(cursor, socket, channel, data) {
    socket.emit(channel, data);
    if(data.isFinished) {
        // don't use close=true if only the namespace needs closing
        cursor.close(console.error.bind(console));
        var close=true;
        socket.disconnect(close);
    }
};

/**
 * data.docid is the rethink db document UUID.
 */
_p._subscribeToDoc = function(socket, data) {
    this._r.table(this._dbTable)
        .get(data.docid)
        .changes({includeInitial: true, squash:true})
        .run(function(err, cursor) {
            if (err) {
                // TODO: Handle error
                console.error('subscribing to changes failed', err);
                return;
            }

            cursor.on("error", function(error) {
                // Handle error, loggong it should suffice in this case
                // I dont't expect this actually to be a problem for the
                // beginning.
                console.error('cursor error for docid', data.docid, error);
            });

            // calls socket.emit('changes', message)
            // let's hope this cursor is removed when the socket changes
            cursor.each(this._fbDNDRethinkChangeFeed.bind(this
                                        , cursor, socket, 'changes'));
        }.bind(this));
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
      ;

    new Server(3000, amqpSetup, rethinkSetup);
}


