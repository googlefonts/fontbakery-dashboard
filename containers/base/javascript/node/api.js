#! /usr/bin/env node
"use strict";
// this is expected to run in nodejs
/* global require, module */
/* jshint esnext:true */

const express = require('express')
  , http = require('http')
  , socketio = require('socket.io')
  , path = require('path')
  , bodyParser = require('body-parser')
  , messages_pb = require('protocolbuffers/messages_pb')
  , { getSetup } = require('./util/getSetup')
  , { IOOperations } = require('./util/IOOperations')
  , { CacheClient }  = require('./util/CacheClient')
  , ROOT_PATH = __dirname.split(path.sep).slice(0, -1).join(path.sep)
  ;


/**
 * Using a class here, so state variables are managed not on module level
 * Initialization starts the server.
 *
 */
function Server(logging, portNum,  amqpSetup, dbSetup, cacheSetup) {
    this._log = logging;
    this._portNum = portNum;

    // familytests_id => data
    this._collectionFamilyDocs = new Map();
    // collectionId => data
    this._collectionSubscriptions = new Map();
    // socket.id => data
    this._collectionConsumers = new Map();
    // familytests_id => familyDoc
    this._familyDocs = new Map();
    this._dashboardSubscription = null; // an object if there are consumers

    this.__updateCollectionFamilyDoc = this._updateCollectionFamilyDoc.bind(this);

    this._app = express();
    this._server = http.createServer(this._app);
    this._sio = socketio(this._server);

    this._cache = new CacheClient(logging, cacheSetup.host, cacheSetup.port
                            , messages_pb, 'fontbakery.dashboard');


    this._dbSetup = dbSetup;

    this._io = new IOOperations(logging, dbSetup, amqpSetup);

    this._collectionQueueName = 'init_collecton_test_queue';

    // Start serving when the database and rabbitmq queue is ready
    Promise.all([
                 this._io.init()
               , this._cache.waitForReady()
               ])
    //.then(function(resources) {
    //    // [r, amqp] = resources[0] ;
    //}.bind(this))
    .then(this._listen.bind(this))
    .catch(function(err) {
        this._log.error('Can\'t initialize server.', err);
        process.exit(1);
    }.bind(this));

    var serveStandardClient = this.fbIndex.bind(this);
    this._app.get('/', serveStandardClient);
    // this._app.get('/collections', serveStandardClient); // currently index "mode"
    // probably dashboard is later index, or a more general landing page
    this._app.get('/drag-and-drop', serveStandardClient);
    this._app.get('/dashboard', serveStandardClient);

    this._app.use('/browser', express.static('browser'));
    this._app.get('/report/:id', this.fbFamilyReport.bind(this));

    this._app.use('/runchecks', bodyParser.raw(
                    {type: 'application/octet-stream', limit: '15mb'}));
    this._app.post('/runchecks', this.fbDNDReceive.bind(this));

    // AJAX returns JSON array of collection-test links
    this._app.get('/collection-reports', this.fbCollectionsGetLinks.bind(this));

    // report document
    this._app.get('/collection-report/:id', this.fbCollectionReport.bind(this));

    this._sio.on('connection', this.fbSocketConnect.bind(this));
}

var _p = Server.prototype;

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
    return res.sendFile('browser/html/client.html',
                                                    {root: ROOT_PATH});
};

/**
 * GET AJAX
 *
 * return a JSON array of collection-test links: {id:, created:, href: }}
 */
_p.fbCollectionsGetLinks = function(req, res) {
    // query the db
    // for collection-test-docs
    this._io.query(this._dbSetup.tables.collection)
        .group('collection_id')
        .max('date')
        .ungroup()
        .merge(row => {
            return {
                date: row('reduction')('date')
              , collection_id: row('reduction')('collection_id')
            };
        })
        .without('group', 'reduction')
        .run()
        .then(function answer(items) {
            res.setHeader('Content-Type', 'application/json');
            items.forEach(function (item) {
                        item.href = 'collection-report/' + encodeURIComponent(item.collection_id);});
            res.send(JSON.stringify(items));
        });
};

_p._fbCheckIndexExists = function(dbTable, indexName, req, res, next) {
    var id = decodeURIComponent(req.param('id'));
    this._log.debug('_fbCheckIndexExists:', id);
    return this._io.query(dbTable).getAll(id, {index: indexName}).count()
        .then(function(found) {
            if(found)
                // This is the same client as the index page,
                // after the id was returned
                return this.fbIndex(req, res, next);
            // answer 404: NotFound
            return res.status(404).send('Not found');
        }
        .bind(this))
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
_p.fbFamilyReport = function(req, res, next) {
    return this._fbCheckIndexExists(this._dbSetup.tables.family, 'id', req, res, next);
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
    return this._fbCheckIndexExists(this._dbSetup.tables.collection, 'collection_id', req, res, next);
};

_p._getFilesMessage = function(buffer) {
    var filesMessage = messages_pb.Files.deserializeBinary(
                                                new Uint8Array(buffer))
        // reconstruct the filesMessage to have all files sorted by name
        // and to discard duplicates (which is possible with this message
        // format
      , newMessage = new messages_pb.Files()
      , i, l, file, seen = new Set()
      , files = filesMessage.getFilesList()
      , newFilesList = []
      ;
    for(i=0,l=files.length;i<l;i++) {
        file = files[i];
        if(seen.has(file.getName())) {
            // either our client is broken OR another bogus client sends
            // messages. The second case could also be a malicious pen
            // test style request. Hence, a warning that we shouldn't see
            // if everything is fine.
            this._log.warning('Incoming filesMessage had a duplicate entry "'
                                + file.getName() +'"');
            continue;
        }
        newFilesList.push(file);
    }
    newFilesList.sort((fileA, fileB)=> {
        var a=fileA.getName()
          , b=fileB.getName()
          ;
        if(a === b) return 0;
        return a > b ? 1 : -1;
    });
    newMessage.setFilesList(newFilesList);
    return newMessage;
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

    function dispatchJob(cacheKey, docid) {
        //jshint validthis:true
        return this._io.dispatchFamilyJob(cacheKey, docid)
            .then(() => {
                this._log.debug('did dispatchFamilyJob, returning ', docid);
                return docid;
            });
    }

    function onSuccess(docid) {
        //jshint validthis:true
        this._log.debug('Sending DND receive response:', docid);
        res.setHeader('Content-Type', 'application/json');
        res.send(JSON.stringify({docid: docid, url: 'report/' + encodeURIComponent(docid)}));
    }

    function makeDoc(cacheKey) {
        // jshint validthis:true
        return this._io.getDocId(cacheKey.getHash())// cacheKey => [created, docid]
            .then(created_docid => { // [created, docid] => docid
                var [created, docid] = created_docid;
                if(created)
                    return dispatchJob.call(this, cacheKey, docid); // cacheKey, docid => docid
                // no need to dispatch, does already exist!
                // but cache needs cleaning!
                return this._cache.purge(cacheKey).then(()=> docid); // => docid
            })
            .then(onSuccess.bind(this)) // onSuccess: docid => nothing
            .error(next)
            ;
    }

    var filesMessage = this._getFilesMessage(req.body.buffer);
    // get the cache key and create the doc:
    return this._cache.put([filesMessage]) // => [cacheKey]
        // only the first item is interesting/present because we only
        // put one message into: `[filesMessage]`
        .then(cacheKeys=>cacheKeys[0])// [cacheKey] => cacheKey
        .then(makeDoc.bind(this))
        ;
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
        this._log.info('fbSocketConnect socket', socket.id ,'subscription '
                                            + 'requested for', type, data);

        if(typeof data.id !== 'string')
            // this is actually required
            data.docid = '';
        if(type === 'report')
            this._subscribeToFamilytestReport(socket, data);
        else if(type === 'collection') {
            this._subscribeToCollectionReport(socket, data);
            // do this only once on connect.
            socket.on('disconnecting', (reason) => {
                // jshint unused:vars
                this._log.debug('socket', socket.id ,'disconnecting from collections');
                this._unsubscribeFromCollections(socket.id);
            });
        }
        else if(type === 'dashboard') {
            this._subscribeToDashboard(socket, data);
            socket.on('disconnecting', (reason) => {
                // jshint unused:vars
                this._log.debug('socket', socket.id ,'disconnecting from dashboard');
                this._unsubscribeFromDashboard(socket.id);
            });
        }
    }
    socket.on('subscribe-report', data => onSubscribe.call(this, 'report', data));
    socket.on('subscribe-collection', data => onSubscribe.call(this, 'collection', data));
    socket.on('subscribe-dashboard', data => onSubscribe.call(this, 'dashboard', data));
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
_p._updateFamilytestReport = function(cursor, socket, data) {
    var channel = 'changes';
    socket.emit(channel, data);
    // This is a simple familytest subscription, we don't organize these
    // to talk to multiple sockets yet. Even if we did, the reason for
    // closing here is sufficient (but then not the means).
    if(data.new_val && data.new_val.finished) {
         // don't use close=true if only the namespace needs closing
         // but currentltly the client is only subscribed to one of
         // this kind at a time.
        this._closeCursor(cursor);
        var close=true;
        socket.disconnect(close);
    }
};

/**
 * data.docid is the rethink db document UUID.
 */
_p._subscribeToFamilytestReport = function(socket, data) {
    return this._io.query(this._dbSetup.tables.family)
        .get(data.id)
        .changes({includeInitial: true, squash: 1})
        .run((err, cursor) => {
            if(err)
                this._raiseUnhandledError('Can\'t acquire change feed.', err);
            cursor.each((err, data) => {
                if(err)
                    this._raiseUnhandledError('Change feed cursor error:', err);
                this._updateFamilytestReport(cursor, socket, data);
            });
        }, {cursor: true});
};

_p._makeCollectionSubscription = function(collectionId) {
    var collectionSubscription = this._collectionSubscriptions.get(collectionId);
    if(!collectionSubscription) {
        collectionSubscription = {
            consumers: new Set() // [socket.id, ...]
          , documents: new Map() // key (family_name?) : {new_val: data}
          , collectionCursor: null
        };
        // It's important to set this synchronous now
        this._collectionSubscriptions.set(collectionId, collectionSubscription);
        // This returns a promise, but we don't have a use for
        // it here. Sending the initial data will not fail if there's
        // nothing yet to send!
        this._initCollectionSubscriptions(collectionId);
    }
    return collectionSubscription;
};

_p._updateCollectionFamilyDoc = function(familytests_id, data) {
    var doc = this._collectionFamilyDocs.get(familytests_id);
    doc.data = data;
    for(let [collectionId, family_names] of doc.subscriptions) {
        for(let family_name of family_names) {
            this._mergeFamilyDocIntoCollectionDoc(collectionId, family_name, doc.data);
            // and update the clients
            this._sendCollectionDocChange(collectionId, family_name);
        }
    }
};

_p._unsubscribeFromCollectionFamilyDoc = function(familytests_id, collectionId, family_name) {
    var doc = this._collectionFamilyDocs.get(familytests_id)
     , family_names = doc.subscriptions.get(collectionId)
     ;

    family_names.delete(family_name);
    if(!family_names.size || !this._collectionSubscriptions.has(collectionId))
        doc.subscriptions.delete(collectionId);
    if(!doc.subscriptions.size) {
        doc.unsubscribe();
        this._collectionFamilyDocs.delete(familytests_id);
    }
};



// this subscribes to merge the changed results into the
// collectionId.documents.get(family_name)
// also, close the cursor if familytests_id.finished is set!
_p._subscribeToCollectionFamilyDoc = function(familytests_id, collectionId
                                                        , family_name) {
    var doc = this._collectionFamilyDocs.get(familytests_id);
    if(!doc) {
        doc = {
            unsubscribe: null
          , subscriptions: new Map() // collectionId: Set([family_name, ...])
        };
        this._collectionFamilyDocs.set(familytests_id, doc);
    }

    if(!doc.subscriptions.has(collectionId))
        doc.subscriptions.set(collectionId, new Set());
    doc.subscriptions.get(collectionId).add(family_name);

    if(!doc.unsubscribe) {
        // called immediately if there is already data
        let callback = this.__updateCollectionFamilyDoc;
        doc.unsubscribe = this._subscribeToFamilyDoc(familytests_id
                                            , callback, familytests_id);
    }
};

_p._unsubscribeFromFamilyDoc = function(subscription) {
    var familytests_id = subscription.familytests_id
      , familyDoc = this._familyDocs.get(familytests_id)
      ;
    familyDoc.subscriptions.delete(subscription);
    if(!familyDoc.subscriptions.size) {
        if(familyDoc.cursor) {
           this._closeCursor(familyDoc.cursor);
           familyDoc.cursor = null;
        }
        this._familyDocs.delete(familytests_id);
    }
};

function _callbackFamilyDocSubscubscriber(subscription, data) {
    var args = subscription.args.slice();
    args.push(data);
    subscription.callback.apply(null, args);
}

_p._subscribeToFamilyDoc = function(familytests_id, callback/*, args ... */) {
    var familyDoc = this._familyDocs.get(familytests_id)
      , subscription = {
            familytests_id: familytests_id
          , callback: callback
          , args: []
        }
        , subscriptions
        , args = subscription.args, i, l
        ;
    for(i=2,l=arguments.length;i<l;i++)
        args.push(arguments[i]);

    if(!familyDoc) {
        familyDoc = {
            subscriptions: subscriptions = new Set()
          , cursor: null
          , data: null
        };

        this._familyDocs.set(familytests_id, familyDoc);

        this._io.query(this._dbSetup.tables.family)
            // getAll and pluck are possible: use getAll here instead of get!
            .getAll(familytests_id)
            // if total is falsy we don't use it and print "N/A" in the client
            .merge(doc => {return {
                    total: doc('tests').count().default(null)
                  , '#fonts': doc('iterargs')('font').count().default(null)
                };
            })
            // more?
            .pluck('id', 'results', 'finished', 'created', 'started'
                 , 'exception', 'total' , '#fonts')
            .merge({type: 'familytest'})
            .changes({includeInitial: true, squash: 2 /* updates in 2 seconds intervals */})
            .run((err, cursor) => {
                if(err)
                    this._raiseUnhandledError('Can\'t acquire change feed.', err);
                // i'd rather prefer to have just cursor for the complete
                // table, but I don't want to download the vast
                // includeInitial data of this table and then keep it in
                // memory forever. We could maybe fetch initial data on
                // request, and at the same time start to record the
                // change notifications for these docks, until no longer
                // needed. But, it can still be complicated in a race between
                // these versions to determine which is the more current
                // one.
                familyDoc.cursor = cursor;
                cursor.each((err, data) => {
                    if(err)
                        this._raiseUnhandledError('Change feed cursor error:', err);
                    // this._log.debug('familytests_id', familytests_id, 'change:', data );
                    familyDoc.data = data;
                    subscriptions.forEach(subscription => {
                        _callbackFamilyDocSubscubscriber(subscription, familyDoc.data);
                    });

                    if(data.new_val && data.new_val.finished && familyDoc.cursor) {
                        if(familyDoc.cursor) {
                            this._closeCursor(familyDoc.cursor);
                            familyDoc.cursor = null;
                        }
                    }
                });

            }, {cursor: true});
    }
    familyDoc.subscriptions.add(subscription);
    if(familyDoc.data)
        _callbackFamilyDocSubscubscriber(subscription, familyDoc.data);
    return this._unsubscribeFromFamilyDoc.bind(this, subscription);
};

// This triggers no change notifications itself, but it implies that
// change notifications are needed!
_p._mergeFamilyDocIntoCollectionDoc = function(collectionId, family_name
                                                                , data) {
     var collectionSubscription = this._collectionSubscriptions.get(collectionId)
       , doc = collectionSubscription.documents.get(family_name)
       ;
    if(!doc.new_val)
        doc.new_val = {};

    for(let k in data.new_val) {
        if(k === 'id') continue; // don't override the CollectionDoc.id
        doc.new_val[k] = data.new_val[k];
    }
};

_p._updateCollectionDoc = function(collectionId, data_new_val) {
    // data is a collectiontests row
    // this collection *MAY* have documents already
    var collectionSubscription = this._collectionSubscriptions.get(collectionId)
      , family_name = data_new_val.family_name
      , familytests_id = data_new_val.familytests_id
      , doc, changed = false
      , old_familytests_id
      ;
    doc = collectionSubscription.documents.get(family_name);
    if(!doc) {
        // this is initial, an insert
        changed = true;
        collectionSubscription.documents.set(family_name, {
            new_val: data_new_val
        });
    }
    else if(doc.new_val.familytests_id !== familytests_id
                && doc.new_val.date < data_new_val.date) {
        // is an update
        // new data has another familytests_id and an older date!
        // the collection doc is never changed itself ATM, so just
        // checking for doc.new_val.id !=data_new_val.id should also
        // suffice, heh? the date check is to make a good guess in race
        // conditions
        changed = true;
        old_familytests_id = doc.new_val.familytests_id;
        doc.new_val = data_new_val;
        this._unsubscribeFromCollectionFamilyDoc(old_familytests_id
                                            , collectionId, family_name);
    }
    // when familytests_id "id" for this family changes we
    // need to unsubscribe and resubscribe to a new id
    if(changed) {
        // now subscribe this to familytests_id
        // this may also merge into the doc now
        this._subscribeToCollectionFamilyDoc(familytests_id
                                            , collectionId, family_name);
        // and update the clients
        this._sendCollectionDocChange(collectionId, family_name);
    }
};

_p._raiseUnhandledError = function(message, err) {
    this._log.error(message, err);
    throw err;
};

_p.subscribeCollectionChanges = function(collectionId) {
    var collectionSubscriptions = this._collectionSubscriptions.get(collectionId);

    return this._io.query(this._dbSetup.tables.collection)
        .getAll(collectionId, {index: 'collection_id'})
        .changes({squash: 1})
        .run((err, cursor) => {
            if(err)
                this._raiseUnhandledError('Can\'t acquire change feed.', err);
            collectionSubscriptions.collectionCursor = cursor;
            cursor.each((err, data) => {
                if(err)
                    this._raiseUnhandledError('Change feed cursor error:', err);
                this._updateCollectionDoc(collectionId, data.new_val);
            });
        }, {cursor: true});
};

_p._primeCollectionSubscription = function(collectionId) {
    return this._io.query(this._dbSetup.tables.collection)
        .getAll(collectionId, {index: 'collection_id'})
        .group('family_name')
        // use this for "time travelling". Each group will skip(n)
        // the latest n items. Which should make the time travelling
        // change a lot (all families) per skip. Maybe not optimal
        // when getting to the "end of time", but we'll see how it feels.
        // .orderBy(r.desc('date')).skip(0)
        .max('date') // only the most current entries in each group
        .run()
        .then(collectionRows => {
            collectionRows.forEach((row) => {
                this._updateCollectionDoc(collectionId, row.reduction);
            });
        })
        ;
};

_p._sendCollectionDocChange = function(collectionId, family_name) {
    var collectionSubscription = this._collectionSubscriptions.get(collectionId)
      , doc = collectionSubscription.documents.get(family_name)
      , channel = 'changes'
      ;
    collectionSubscription.consumers.forEach(socketId => {
        let consumer = this._collectionConsumers.get(socketId);
        consumer.socket.emit(channel, doc);
    });
};

_p._sendInitialCollectionSubscription = function(collectionId, socketId) {
    var collectionSubscription = this._collectionSubscriptions.get(collectionId)
      , consumer = this._collectionConsumers.get(socketId)
      , channel = 'changes'
      ;
    // if there is any data, it is ready to emit!
    for(let [/*family_name*/, doc] of collectionSubscription.documents)
        // jshint unused:vars
        consumer.socket.emit(channel, {new_val: doc.new_val});

};

_p._initCollectionSubscriptions = function(collectionId) {
    // First subscribe to the change feed and then prime the collection
    // Handling either case must be graceful then if the doc already exists.
    // Otherwise we may miss some updates!
    return this.subscribeCollectionChanges(collectionId)
        .then(() => this._primeCollectionSubscription(collectionId))
        ;
};

    // A) let's get a head start with a none change feed traditional query
    //      and merge in the familytest data -> that stuff does change, so
    //      we can't merge it as a head start and have to get a change feed
    //      for each, then we can hand-merge and send updates

    // B) fill the state for the collectionId

    // C) start monitoring for changes for collectionId, but only upate
    //    the collection state when necessary

_p._makeCollectionConsumer = function(socket) {
    var consumer = this._collectionConsumers.get(socket.id);
    if(!consumer) {
        consumer = {
            socket: socket
          , subscriptions: new Set()
        };
        this._collectionConsumers.set(socket.id, consumer);
    }
    return consumer;
};

/**
 * This must to unsubscribe the socket from the collectionSubscription
 * and if the collectionSubscription has no consumers anymore,
 *      unsubscribe it from its collectionests change feed
 *      and unsubscribe from all of its CollectionFamilyDoc subscriptions
 *          if one of these has no consumers anymore
 *              unsubscribe it from its familytests change feed
 *              and then delete it
 *      and then delete it
 */
_p._unsubscribeFromCollections = function(socketId) {
    var consumer = this._collectionConsumers.get(socketId);
    for(let collectionId of consumer.subscriptions)
        this._unsubscribeFromCollection(socketId, collectionId);
};

_p._clearCollectionConsumers = function(collectionId) {
    // assert !this._collectionSubscriptions.has(collectionId);
    for(let [socketId, consumer] in this._collectionConsumers)
        if(consumer.subscriptions.has(collectionId))
            this._unsubscribeFromCollection(socketId, collectionId);
};

_p._unsubscribeFromCollection = function(socketId, collectionId) {
    var consumer = this._collectionConsumers.get(socketId)
      , collectionSubscription = this._collectionSubscriptions.get(collectionId)
      ;
    consumer.subscriptions.delete(collectionId);
    // delete the subscriber from the collection change feed
    collectionSubscription.consumers.delete(socketId);
    if(!collectionSubscription.consumers.size) {
        // if no consumers are left, close the change feeds
        this._closeCursor(collectionSubscription.collectionCursor);
        this._collectionSubscriptions.delete(collectionId);
        for(let [family_name, doc] in collectionSubscription.documents)
            this._unsubscribeFromCollectionFamilyDoc(doc.new_val.familytests_id
                                            , collectionId, family_name);
        // NOTE: this is important, otherwise the recursive call never ends:
        // assert !consumer.subscriptions.has(collectionId)
        this._clearCollectionConsumers(collectionId);
    }
    if(!consumer.subscriptions.size)
        this._collectionConsumers.delete(socketId);
};

_p._closeCursor = function(cursor) {
    if(cursor)
        cursor.close()
        .then(()=>this._log.debug('A cursor has been closed.'))
        .catch(this._io.r.Error.ReqlDriverError, (err) => {
            this._log.error('An error occurred on cursor close', err);
        });
};

_p._subscribeToCollectionReport = function(socket, data) {
    // TODO: clean this up and describe what happens here!
    //       there are no super easy al-in-one change feeds ...
    // NOTE: we can't do a changes on the query above, because of the
    // group, but it should be possible to do a changes like this:
    //     this._io.query(this._dbSetup.tables.collection)
    //         .getAll(collectionId, {index: 'collection_id'})
    //         .changes({include_initial: true})
    // And then always react when new items are created: `item.type === "add"`
    // we would receive the full table for the family_name and would
    // have to do the .group('family_name').max('date') on our own :-/
    // e.g. cancel the old changes subscription and make a new one
    // It's important to note that in this table items are always only created,
    // never updated or deleted
    // This has *many* indications:
    // a) we would have a real live-collection view. Without changes
    //       on collectiontests we only get the latest docs on load time
    //       which might be a bit unexpected when everything else is live
    // b) we should probably subscribe on changes of the familytests docs
    //    one by one, not all at once, then we can swap out the stream when
    //    a newer doc for a particular `family_name` comes in (`item.type === "add"`)
    // c) additionally, we may still need a way to pin a collectiontest to a
    //    fixed version. Maybe we must add some sort of "tags" or "named_collection"
    //    feature. That can be done with a "multiple" index AFAIK. But that
    //    would also potentially grow over time. Since we already have a
    //    specific collectionId index, it wouldn't be too bad, probably.
    //    We could add to it, when the collection requests a new check
    //    (we dismiss this now when the doc exists). Or, make it an explicit
    //    feature (add this to a "named collection" ...), so a user can pin
    //    a collection when time-traveling and revisit this later.
    var collectionId = data.id
      , consumer, collectionSubscription
      ;

    // Can be subscribed to other collections as well
    // and most probably will be in the future, for the full dashboard!
    consumer = this._makeCollectionConsumer(socket);
    if(consumer.subscriptions.has(collectionId))
        // just a small sanity test, we may eventually just return here.
        // Could be a client bug/feature thing but right now it seems
        // just wrong.
        throw new Error('Assertion failed socket.id: '+socket.id+' has '
                        + 'already subscribed to collectionId: '
                        + collectionId);

    consumer.subscriptions.add(collectionId);
    collectionSubscription = this._makeCollectionSubscription(collectionId);
    collectionSubscription.consumers.add(socket.id);
    // won't send if there's nothing yet to send
    this._sendInitialCollectionSubscription(collectionId, socket.id);
};


_p._unsubscribeFromDashboard = function(socketId) {
    var consumers = this._dashboardSubscription.consumers
      , consumer = consumers.get(socketId)
      ;
    consumer.unsubscribe_callbacks.forEach(unsubscribe => unsubscribe());
    consumers.delete(socketId);

    if(!consumers.length) {
        this._closeCursor(this._dashboardSubscription.cursor);
        this._dashboardSubscription = null;
    }
};

_p._updateDashboardCollectionDoc = function(doc) {
    var collectionDocs = this._dashboardSubscription.collectionDocs
      , consumers = this._dashboardSubscription.consumers
      , key = [doc.collection_id, doc.family_name].join('...')
      , current = collectionDocs.get(key)
      ;
    // Do this check, because of us not using includeInitial
    // and the "priming" request
    if(current && current.date >= doc.date)
        // this is old
        return;

    collectionDocs.set(key, doc);
    // send updates to each consumers;
    consumers.forEach((consumer) => {
        this._sendToDashboardConsumer(consumer, doc);
    });
};

_p._sendToDashboardConsumer = function(consumer, collectiontest_data) {
    var channel = 'changes'
      , familytests_id = collectiontest_data.familytests_id
      ;

    this._log.debug('_sendToDashboardConsumer collectiontest_data'
        , collectiontest_data.collection_id, collectiontest_data.family_name);
    consumer.socket.emit(channel, collectiontest_data);

    if(!(consumer.unsubscribe_callbacks.has(familytests_id))) {
        // callback: called immediately if there is already data
        let callback = data => {
                this._log.debug('send familytests', data.new_val.id);
                consumer.socket.emit(channel, data.new_val);
            }
            // will send cached docs immediately
          , unsubscribe = this._subscribeToFamilyDoc(familytests_id, callback)
          ;
        consumer.unsubscribe_callbacks.set(familytests_id, unsubscribe);
    }
};

_p._subscribeToDashboard = function(socket, data) {
    var consumer;
    if(!this._dashboardSubscription) {
        this._dashboardSubscription = {
            cursor: null
          , consumers: new Map()
          , collectionDocs: new Map()
        };
        // init the cursor
        this._io.query(this._dbSetup.tables.collection)
        .merge({type: 'collectiontest'})
        .changes({squash: 1})
        .run((err, cursor) => {
            if(err)
                this._raiseUnhandledError('Can\'t acquire change feed.', err);
            this._dashboardSubscription.cursor = cursor;
            cursor.each((err, data) => {
                if(err)
                    this._raiseUnhandledError('Change feed cursor error:', err);
                this._updateDashboardCollectionDoc(data.new_val);
            });
        }, {cursor: true})
        .then(() => {
            // prime the cache
            return this._io.query(this._dbSetup.tables.collection)
                .group({index: 'collection_family'})
                .max('date')// only the most current entries in each group
                .merge({type: 'collectiontest'})
                .run()
                .then(collectionRows => {
                    collectionRows.forEach((row) => {
                        this._updateDashboardCollectionDoc(row.reduction);
                    });
                });
        })
        ;
    }

    consumer = this._dashboardSubscription.consumers.get(socket.id);
    if(consumer) {
        // is already subscribed ... ?
        // reset the consumer: unsbscribe all
        // also this is what we to do on a hang up, see _unsubscribeFromDashboard
        consumer.unsubscribe_callbacks.forEach(unsubscribe => unsubscribe());
        consumer.unsubscribe_callbacks = new Map();
    }
    else {
        consumer = {
            socket: socket
          , unsubscribe_callbacks: new Map()
        };
        this._dashboardSubscription.consumers.set(socket.id, consumer);
    }

    // send all existing, cached collection docs to the new consumer
    // and set up familytest subscriptions
    this._dashboardSubscription.collectionDocs.forEach(data => {
        this._sendToDashboardConsumer(consumer, data);
    });
};

if (typeof require != 'undefined' && require.main==module) {
    var setup = getSetup();
    setup.logging.info('Init server ...');
    setup.logging.log('Loglevel', setup.logging.loglevel);
    setup.logging.debug('Loglevel', setup.logging.loglevel);
    // storing in global scope, to make it available for inspection
    // in the debugger.
    global.server = new Server(setup.logging, 3000, setup.amqp, setup.db, setup.cache);
}
