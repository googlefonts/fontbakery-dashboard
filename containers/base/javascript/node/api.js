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
  // https://github.com/squaremo/amqp.node
  , amqplib = require('amqplib')
  , messages_pb = require('protocolbuffers/messages_pb')
  , { getSetup } = require('./util/getSetup')
  , { CacheClient }  = require('./CacheClient')
  ;

var ROOT_PATH = __dirname.split(path.sep).slice(0, -1).join(path.sep);


/**
 * Using a class here, so state variables are managed not on module level
 * Initialization starts the server.
 *
 */
function Server(logging, portNum,  amqpSetup, rethinkSetup, cacheSetup) {
    this._log = logging;
    this._portNum = portNum;
    this._dbName = rethinkSetup.db;
    this._dbDNDTable = 'draganddrop';
    this._dbCollectionTable = 'collectiontests';
    this._app = express();
    this._server = http.createServer(this._app);
    this._sio = socketio(this._server);

    this._cache = new CacheClient(logging, cacheSetup.host, cacheSetup.port
                            , messages_pb, 'proto.fontbakery.dashboard');

    this._r = rethinkdbdash(rethinkSetup);

    this._amqpConnection = null;
    this._dndQueueName = 'fontbakery-worker-distributor';
    this._collectionQueueName = 'init_collecton_test_queue';

    // Start serving when the database and rabbitmq queue is ready
    Promise.all([
                 this._initDB()
               , this._initAmqp(amqpSetup)
               ])
    .then(this._listen.bind(this))
    .catch(function(err) {
        this._log.error('Can\'t initialize server.', err);
        process.exit(1);
    }.bind(this));

    this._app.get('/', this.fbIndex.bind(this));
    this._app.use('/browser', express.static('browser'));
    this._app.get('/report/:docid', this.fbDNDReport.bind(this));

    this._app.use('/runchecks', bodyParser.raw(
                    {type: 'application/octet-stream', limit: '15mb'}));
    this._app.post('/runchecks', this.fbDNDReceive.bind(this));

    this._app.get('/collection', this.fbIndex.bind(this));
    // JSON array of collection-test links
    this._app.get('/collection-reports', this.fbCollectionGetReports.bind(this));
    // report document
    this._app.get('/collection-report/:docid', this.fbCollectionReport.bind(this));
    // start a testrun
    this._app.use('/runcollectionchecks', bodyParser.json());// understands Content-Type: application/json
    this._app.post('/runcollectionchecks', this.fbCollectionCreateTest.bind(this));

    this._sio.on('connection', this.fbSocketConnect.bind(this));
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

    createTable = function(dbTable) {
        return this._r.tableCreate(dbTable)
            .run()
            //.then(function(response) {/* pass */})
            .error(function(err){
            if (err.message.indexOf('already exists') !== -1)
                return;
            throw err;
        });
    }.bind(this);

    return createDatabase()
        .then(createTable.bind(this, this._dbDNDTable))
        .then(function(){
            return this._query(this._dbDNDTable)
                .indexCreate(this._dbCollectionTable + '_id')
                .run()
                .error(function(err){
                    if (err.message.indexOf('already exists') !== -1)
                        return;
                    throw err;
                });
        }.bind(this))
        .then(createTable.bind(this, this._dbCollectionTable))
        .error(function(err) {
            // It's not an error if the table already exists
            this._log.warning('Error while initializing database.', err);
            throw err;
        }.bind(this));
};

_p._initAmqp = function(amqpSetup) {
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
_p.fbIndex = function(req, res) {
    return res.sendFile('browser/html/drag-and-drop-client.html',
                                                    { root: ROOT_PATH});
};

/**
 * GET AJAX
 *
 * return a JSON array of collection-test links: {id:, created:, href: }}
 */
_p.fbCollectionGetReports = function(req, res) {
    // query the db
    // for collection-test-docs
    this._query(this._dbCollectionTable).pluck('id', 'created')
        .run()
        .then(function answer(items) {
            res.setHeader('Content-Type', 'application/json');
            items.forEach(function (item){
                        item.href = 'collection-report/' + item.id;});
            res.send(JSON.stringify(items));
        });
};


/**
 * POST AJAX, the secret
 *
 * FIXME: *Unencrypted!* for now, we'll need SSL, and proper authentication/authorization
 *
 * SERVER
 *   : create a collection-test document => docid
 *   : dispatch job to the job-creating worker
 *   : return docid and the new URL.
 */
_p.fbCollectionCreateTest = function(req, res, next) {
    this._log.info('fbCollectionCreateTest');
    var doc = {created: new Date()}
      , secret = req.body.secret // parsed JSON
      ;

    res.setHeader('Content-Type', 'application/json');

    // FIXME: this is BAD security! See googlefonts/fontbakery-dashboard#46
    if(!('COLLECTION_AUTH_SECRET' in process.env))
        throw new Error ('COLLECTION_AUTH_SECRET is not set');
    if(secret !== process.env.COLLECTION_AUTH_SECRET) {
        this._log.debug('Wrong secret.');
        return res.status(403).send(JSON.stringify(null));
    }

    function success(docid) {
        //jshint validthis:true
        this._log.debug('Sending  rollection-receive response:', docid);
        res.send(JSON.stringify({docid: docid, url: 'collection-report/' + docid}));
    }

    function dispatchCollectionJob(dbResponse) {
        //jshint validthis:true
        this._log.debug('_onCollectionTestDocCreated','dbResponse', dbResponse);
        var docid = dbResponse.generated_keys[0]
          , dispatcher = this._dispatchCollectionJob.bind(this, docid)
        ;
        return this._dispatchJob(docid, dispatcher);
    }

    this._dbInsertDoc(this._dbCollectionTable, doc, next
            , dispatchCollectionJob.bind(this)
            , success.bind(this)
    );
};

_p._dbInsertDoc = function(dbTable, doc, next, onCreated, success) {
    this._query(dbTable).insert(doc)
            .run()
            .then(onCreated)
            .then(success)
            .error(function(err) {
                this._log.error('Creating a doc failed ', err);
                next(err);
            }.bind(this));
};

_p._query = function(dbTable) {
    return this._r.table(dbTable);
};

_p._fbCheckDocId = function(dbTable, req, res, next) {
    var docid = req.param('docid');
    this._log.debug('_fbCheckDocId:', docid);
    return this._query(dbTable).getAll(docid).count()
        .then(function(found) {
            if(found)
                // This is the same client as the index page,
                // after the docid was returned
                return this.fbIndex(req, res, next);
            // answer 404: NotFound
            return res.status(404).send('Not found');
        }.bind(this))
        .catch(next);
};

/**
 * GET docid
 *
 * Loads the report page client, which receives its information via socket.io
 *
 * SERVER
 *   : test if docid exists
 * CLIENT
 *   : same as fbIndex on success
 */
_p.fbDNDReport = function(req, res, next) {
    return this._fbCheckDocId(this._dbDNDTable, req, res, next);
};

/**
 * GET docid
 *
 * Loads the collection-wide test report page client, which receives
 * its information via socket.io
 *
 * SERVER
 *   : test if docid exists
 * CLIENT
 *   : same as fbIndex on success
 */
_p.fbCollectionReport = function(req, res, next) {
    return this._fbCheckDocId(this._dbCollectionTable, req, res, next);
};

_p._dispatchCollectionJob = function  (docid, channel) {
     var message = JSON.stringify({docid: docid})
        // expecting doc id to be only ASCII chars, because serializing
        // higher unicode is not that straight forward.
       , messageArray = Uint8Array.from(message,
                            function(chr){ return chr.charCodeAt(0);})
       , messageBuffer = new Buffer(messageArray.buffer)
       ;
    this._log.debug('_dispatchCollectionJob:', docid);
    return this._sendAMQPMessage(channel, this._collectionQueueName, messageBuffer);
};

_p._dispatchDNDJob = function  (docid, payload, channel) {
    this._log.debug('_dispatchDNDJob:', docid);
    var files = messages_pb.Files.deserializeBinary(
                                        new Uint8Array(payload.buffer));
    function getMessageBuffer(cacheKey) {
        var job = new messages_pb.FamilyJob();
        job.setDocid(docid);
        job.setType(messages_pb.FamilyJob.JobType.ORIGIN);
        job.setCacheKey(cacheKey);
        return new Buffer(job.serializeBinary());
    }

    return this._cache.put([files])
             // only the first item is interesting/present
            .then(Array.prototype.shift.call.bind(Array.prototype.shift))
            .then(getMessageBuffer)
            .then(this._sendAMQPMessage.bind(this, channel, this._dndQueueName))
            ;
};

_p._sendAMQPMessage = function (channel, queueName, message) {
    var options = {
            // TODO: do we need persistent here/always?
            persistent: true // same as deliveryMode: true or deliveryMode: 2
        }
        ;
    function onAssert() {
        // jshint validthis:true
        this._log.info('sendToQueue: ', queueName);
        return channel.sendToQueue(queueName, message, options);
    }
    return channel.assertQueue(queueName, {durable: true})
           .then(onAssert.bind(this))
           .finally(function(){ channel.close(); })
           ;
};

_p._dispatchJob = function(docid, dispatcher) {
    this._log.debug('creating amqp channel');
    return this._amqpConnection.createChannel()
        .then(dispatcher)
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

    var doc = {created: new Date()};
    function success(docid) {
        //jshint validthis:true
        this._log.debug('Sending DND receive response:', docid);
        res.setHeader('Content-Type', 'application/json');
        res.send(JSON.stringify({docid: docid, url: 'report/' + docid}));
    }

    function dispatchJob(req, dbResponse) {
        //jshint validthis:true
        this._log.debug('dispatchJob','dbResponse', dbResponse);
        var docid = dbResponse.generated_keys[0]
          , payload = req.body
          , dispatcher = this._dispatchDNDJob.bind(this, docid, payload)
          ;
        return this._dispatchJob(docid, dispatcher);
    }

    this._dbInsertDoc(this._dbDNDTable, doc, next
            , dispatchJob.bind(this, req)
            , success.bind(this)
            );
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
 * this._sio.on('connection', this.fbSocketConnect.bind(this));
 *
 */
_p.fbSocketConnect = function(socket) {
    // wait for docid request ...

    function onSubscribe(type, data) {
        //jshint validthis: true
        this._log.info('fbSocketConnect subscription requested'
                                                +' for', type, data);
        // simple sanitation, all strings are valid requests so far
        if(typeof data.docid !== 'string')
            // this is actually required
            data.docid = '';
        if(type === 'report')
            this._subscribeToReportDoc(socket, data);
        else if(type === 'collection')
            this._subscribeToCollectionReportsDoc(socket, data);
    }

    socket.on('subscribe-report', onSubscribe.bind(this, 'report'));
    socket.on('subscribe-collection', onSubscribe.bind(this, 'collection'));
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
_p._fbRethinkChangeFeed = function(cursor, socket, channel, err, data) {
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
_p._subscribeToReportDoc = function(socket, data) {
    var query = this._query(this._dbDNDTable).get(data.docid);
    this._subscribeToQuery(socket, query);
};

_p._subscribeToCollectionReportsDoc = function(socket, data) {
    // This would have been nice but it is not currently possible!
    // var query = this._query(this._dbCollectionTable).get(data.docid).merge({
    //     reports: this._query(this._dbDNDTable)
    //         .getAll(this._r.row('id'), {index: this._dbCollectionTable + '_id'})
    //         .pluck('id', 'created', 'family', 'results').coerceTo('array')
    // });
    // Let's for now only get the reports data:
    // This works, but changes are per document, we'll have to manually
    // apply them at the right positions, in the client. Will work though.
    var query = this._query(this._dbCollectionTable).get(data.docid);
    this._subscribeToQuery(socket, query);

    query = this._query(this._dbDNDTable)
        .getAll(data.docid, {index: this._dbCollectionTable + '_id'})
        .map(function (doc) {
            return doc.merge({total: doc('tests').count()});
        })
        .pluck('id', 'created', 'family_dir', 'results', 'total')
        ;
    this._subscribeToQuery(socket, query);
};

_p._subscribeToQuery = function(socket, query) {
        query.changes({includeInitial: true, squash: 1})
            .run(function(err, cursor) {
            if(err) {
                this._log.error('Can\'t acquire change feed.', err);
                throw err;
            }
            cursor.each(this._fbRethinkChangeFeed.bind(this
                                        , cursor, socket, 'changes'));
        }.bind(this), {cursor: true});
};

if (typeof require != 'undefined' && require.main==module) {
    var setup = getSetup();
    setup.logging.info('Init server ...');
    new Server(setup.logging, 3000, setup.amqp, setup.rethink, setup.cache);
}
