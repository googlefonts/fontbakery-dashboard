#! /usr/bin/env node
"use strict";
/* jshint esnext:true, node:true */

const path = require('path')
  , fs = require('fs')
  , bodyParser = require('body-parser')

  , marked = require('marked')

  , { ReportsQuery, ReportIds, Files } = require('protocolbuffers/messages_pb')
  , { Timestamp } = require('google-protobuf/google/protobuf/timestamp_pb.js')

  , { getSetup } = require('./util/getSetup')
  , ROOT_PATH = __dirname.split(path.sep).slice(0, -1).join(path.sep)
  , { _BaseServer, RootService } = require('./_BaseServer')
  ;

const FontBakeryServer = (function() {

function FontBakeryServer(...args) {
    this._serviceDefinitions = [
        ['/', RootService, ['server', '*app', 'log']]
      , ['/', DashboardAPIService, ['server', '*app', 'log', 'io', 'cache', 'reports']]
    ];
    _BaseServer.call(this, ...args);
}

_p = FontBakeryServer.prototype = Object.create(_BaseServer.prototype);

return FontBakeryServer;

})();


/**
 * TODO: historically this hosts the logic of many parts of the dashboard.
 * To simplify reading and understanding of these parts, it would be nice
 * to break this up into separated subApps:
 *      - fontbakery report
 *      - fontbakery dashboard + collection (they are similar, but only if
 *        they share data structures, otherwise they can be separated)
 *      - fontbakery drag and drop
 *      - status reports
 */
function DashboardAPIService(server, app, logging,  io, cache, reports) {
    this._server = server;
    this._app = app;
    this._log = logging;
    this._io = io;
    this._cache = cache;
    this._reports = reports;

    // familytests_id => data
    this._collectionFamilyDocs = new Map();
    // collectionId => data
    this._collectionSubscriptions = new Map();
    // socket.id => data
    this._collectionConsumers = new Map();
    // familytests_id => familyDoc
    this._familyDocs = new Map();
    this._dashboardSubscription = null; // an object if there are consumers
    this._familyDocsSubscriptionCursor = null;

    this.__updateCollectionFamilyDoc = this._updateCollectionFamilyDoc.bind(this);

    var serveStandardClient = this._server.serveStandardClient;

    // these just need to exist, they serve the normal client
    this._app.get('/collections', serveStandardClient); // currently index "mode"
    // probably dashboard is later index, or a more general landing page
    this._app.get('/drag-and-drop', serveStandardClient);
    this._app.get('/dashboard', serveStandardClient);


    this._app.get('/report/:id', this.fbFamilyReport.bind(this));

    this._app.use('/runchecks', bodyParser.raw(
                    {type: 'application/octet-stream', limit: '15mb'}));
    this._app.post('/runchecks', this.fbDNDReceive.bind(this));

    // AJAX returns JSON array of collection-test links
    this._app.get('/collection-reports', this.fbCollectionsGetLinks.bind(this));


    // report document
    this._app.get('/collection-report/:id', this.fbCollectionReport.bind(this));


    // landing page => the normal client
    this._app.get('/status', serveStandardClient); // currently index "mode"
    // much like this.fbCollectionsGetLinks.bind(this));
    this._app.get('/status-reports', this.fbStatusReportsGetList.bind(this));
    // This is for pagination requests; the info needed is not obvious,
    // but used for an optimized database request.
    this._app.get('/status-reports/:lastItemReported/:lastItemId/:previous'
                                   , this.fbStatusReportsGetList.bind(this));


    // status report document (client renders into html for now);
    this._app.get('/status-report/:id', this.fbStatusReport.bind(this));

    this._server.registerSocketListener('subscribe-report'
            , this._subscribeToFamilytestReport.bind(this)/* , no disconnect! */);
    this._server.registerSocketListener('subscribe-collection'
            , this._subscribeToCollectionReport.bind(this)
            , this._disconectFromCollections.bind(this));
    this._server.registerSocketListener('subscribe-dashboard'
            , this._subscribeToDashboard.bind(this)
            , this._disconnectFromDashboard.bind(this));


}

var _p = DashboardAPIService.prototype;

_p.fbSendServsersideRenderedPage = function(htmlSnipped, req, res, next) {
    fs.readFile(path.join(ROOT_PATH, 'browser/html/client.html'), (err, page) => {
        if (err) {
            next(err);
            return;
        }
        res.send(page.toString().replace(
                    '<!-- server side include marker -->', htmlSnipped));
    });
};

/**
 * GET AJAX
 *
 * return a JSON array of collection-test links: {id:, created:, href: }}
 */
_p.fbCollectionsGetLinks = function(req, res, next) {
    // query the db
    // for collection-test-docs
    this._io.query('collection')
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
        .then(items => {
            items.forEach(item =>
                item.href = 'collection-report/' + encodeURIComponent(item.collection_id));
            return items;
        })
        .then(items=>_sendAsJson(res, items))
        .then(null, next)
        ;
};

function _sendAsJson(res, items) {
    res.setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify(items));
}

/**
 * Get a Timestamp message from a JavaScript Date instance
 */
//function timestampFromDate(date){
//    var ts = new Timestamp();
//    ts.fromDate(date);
//    return ts;
//}


/**
 * Respond with a JSON array of StatusReport data.
 */
_p.fbStatusReportsGetList = function(req, res, next) {
    var reportsQuery = new ReportsQuery();
    // we have an autoscroll/load feature for these links,
    // so this is filter is not really needed but left here commented out,
    // as an example, if we want to filter stuff in the future:
    // Make a DATE filter:
    // min value two months in the past.
    // I.e. show the reports not older than min date
    // let date = new Date()
    //   , filter = new ReportsQuery.Filter()
    //   ;
    // date.setMonth(date.getMonth() - 2); // two month in the past
    // filter.setType(ReportsQuery.Filter.Type.DATE);
    // filter.setMinMaxDatesList([timestampFromDate(date)]);// just one means only min-date
    // reportsQuery.getFiltersMap().set('reported', filter);
    if('lastItemReported' in req.params) {
        let { lastItemReported, lastItemId, previous } = req.params
          , pagination = new ReportsQuery.Pagination()
          , reported = new Timestamp()
          ;
        reported.fromDate(new Date(lastItemReported));
        pagination.setItemReported(reported);
        pagination.setItemId(lastItemId);
        pagination.setPreviousPage(previous === 'true');
        reportsQuery.setPagination(pagination);
    }
    // that's the default, but for documentation …
    reportsQuery.setIncludeData(false);

    this._reports.query(reportsQuery)
        //translate into json for the client
        .then(reports=>reports.map(report=>{
            var result = report.toObject(false);
            // special service for the client:
            // Do this in the client? This way, the client doesn't need
            // to know about the date format returned by report.toObject
            // thus, I prefer this.
            for (let key of ['started', 'finished', 'reported']) {
                if(!result[key]) continue;
                let seconds = result[key].seconds
                  , nanos = result[key].nanos
                  ;
                result[key] = new Date((seconds * 1000) + (nanos / 1000000));
            }
            return result;
        }))
        .then(items=>_sendAsJson(res, items))
        .then(null, next)
        ;
};

function _renderStatusReportDoc(doc) {
    var result = []
      , renderRow = (items, headColumnTag, tailColumnsTag)=>{
            var result = [];
            for(let i=0,l=items.length;i<l;i++) {
                let item = items[i]
                  , tag = (i===0 ? headColumnTag : tailColumnsTag)
                  ;
                result.push('<'+tag+'>', marked(item), '</'+tag+'>\n');
            }
            return result;
        }
      ;
    // It would be much nicer and safer to have the browser DOM API to render
    // this! Now we rely on marked here and trust our own reporting
    // a bit.
    for(let [type, data] of doc.data) {
        let snipped = null;
        switch(type) {
        case('md'):
            snipped = marked(data, {gfm: true});
            break;
        case('table'):
            snipped = ['<table>'];
            if(data.caption)
                snipped.push('<caption>', marked(data.caption), '</caption>','\n');

            if(data.firstRowIsHead) {
                snipped.push('<thead><tr>', '\n');
                snipped.push(...renderRow(data.data[0], 'th', 'th'));
                snipped.push('</tr></thead>', '\n');
            }
            snipped.push('<tbody>', '\n');
            let headColumnTag = data.firstRowIsHead ? 'th' : 'td';
            for(let i=(data.firstRowIsHead ? 1 : 0),l=data.data.length;i<l;i++) {
                snipped.push('<tr>', '\n'
                        ,...renderRow(data.data[i], headColumnTag, 'td')
                        , '</tr>');
            }
            snipped.push('</tbody>', '\n');
            snipped.push('</table>');
            snipped = snipped.join('');
            break;
        default:
            // unkown type
            continue;
        }
        if(snipped)
            result.push(snipped);
    }
    return result.join('\n');
}

/**
 * Responds with an HTML page that includes the rendered status report.
 *
 * Other examples use socket.io here, but these reports are not being
 * updated anymore. A standard get interface makes this simplest.
 */
_p.fbStatusReport = function(req, res, next) {
    // jshint unused:vars
    var id = decodeURIComponent(req.param('id'))
      , reportIds = new ReportIds()
      ;
    reportIds.addIds(id);
    this._reports.get(reportIds)
        .then(reports=>{
            if(!reports.length)
                return res.status(404).send('Not found');
            // there's only one doc requested in this method!
            let report = reports[0]
              , doc, htmlSnipped
              ;
            doc = report.toObject(false);
            doc.data = JSON.parse(doc.data);
            htmlSnipped = _renderStatusReportDoc(doc);
            this.fbSendServsersideRenderedPage(htmlSnipped, req, res, next);
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
                return this._server.serveStandardClient(req, res, next);
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
    return this._fbCheckIndexExists('family', 'id', req, res, next);
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
    return this._fbCheckIndexExists('collection', 'collection_id', req, res, next);
};

_p._getFilesMessage = function(buffer) {
    var filesMessage = Files.deserializeBinary(
                                                new Uint8Array(buffer))
        // reconstruct the filesMessage to have all files sorted by name
        // and to discard duplicates (which is possible with this message
        // format
      , newMessage = new Files()
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
        res.send(JSON.stringify({id: docid, url: 'report/' + encodeURIComponent(docid)}));
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
    var channel = 'changes-report';
    socket.emit(channel, data);
    // This is a simple familytest subscription, we don't organize these
    // to talk to multiple sockets yet. Even if we did, the reason for
    // closing here is sufficient (but then not the means).
    if(data.new_val && data.new_val.finished) {
         // don't use close=true if only the namespace needs closing
         // but currentltly the client is only subscribed to one of
         // this kind at a time.
        this._closeCursor(cursor);
        // FIXME: we'll use the socket for different channels
        // so, a socket will probably need a counter of users,
        // if users is zero, we can disconnect.
        // We should be using "namespaces" and close=false
        // because: "close (Boolean) whether to close the underlying connection
        //           [...]
        //           Disconnects this client. If value of close is true,
        //           closes the underlying connection. Otherwise, it just
        //           disconnects the namespace.
        //           "
        // from: https://socket.io/docs/server-api/#socket-disconnect-close
        var close=true;
        socket.disconnect(close);
    }
};

/**
 * data.docid is the rethink db document UUID.
 */
_p._subscribeToFamilytestReport = function(socket, data) {
    return this._io.query('family')
        .get(data.id + '')
        .changes({includeInitial: true, squash: 1})
        .run((err, cursor) => {
            if(err) {
                // FIXME: see socket.disconnect in this._updateFamilytestReport
                socket.disconnect(true);
                this._raiseUnhandledError('Can\'t acquire change feed.', err);
            }
            // got a cursor
            socket.on('disconnecting', (/*reason*/)=>this._closeCursor(cursor));
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
        this._familyDocs.delete(familytests_id);

        if(!this._familyDocs.size) {
            // close the change feed if there are no more subscribers
            this._closeCursor(this._familyDocsSubscriptionCursor);
            this._familyDocsSubscriptionCursor = null;
        }
    }
};

function _callbackFamilyDocSubscubscriber(subscription, data) {
    var args = subscription.args.slice();
    args.push(data);
    subscription.callback.apply(null, args);
}


_p._getDashboardFamilytestQuery = function(familytests_id) {
    var query = this._io.query('family');
    // this way we can create a changefeed for the whole table
    // and have a single point of truth for the query
    if(familytests_id)
        query = query.get(familytests_id);

    return query.merge(doc => {return {
                total: doc('tests').count().default(null)
              , '#fonts': doc('iterargs')('font').count().default(null)
            };
        })
        // more?
        .pluck('id', 'results', 'finished', 'created', 'started'
             , 'exception', 'total' , '#fonts')
        .merge({type: 'familytest'})
        ;
};

// https://github.com/sindresorhus/escape-string-regexp/blob/master/index.js
const _matchOperatorsRe = /[|\\{}()[\]^$+*?.]/g;
function _escapeStringRegexp (str) {
    return str.replace(_matchOperatorsRe, '\\$&');
}

const _matchDoubleQuotes = /"/g;
function _escapeDoubleQuotes(str) {
    return str.replace(_matchDoubleQuotes, '\\$&');
}
_p._getDashboardFamilytestQueryFilterChecks = function(familytests_id, searchedChecks) {
    var query = this._io.query('family')
     , search = searchedChecks
                    .map(_escapeStringRegexp)
                    .map(_escapeDoubleQuotes)
                    // we'll be searching in the key of the checks
                    // make sure to select just the matching "check"
                    .map(str=> '"check":' + '"' + str + '"')
                    .join('|') // RegeExp "or" operator
      ;
    // this way we can create a changefeed for the whole table
    // and have a single point of truth for the query
    if(familytests_id)
        query = query.get(familytests_id);

    query.merge(doc=>{
            var results = doc('tests').keys()
                     // this is a list of all keys we are interested in.
                    .filter(key=>key.match(search)
                        // If the check did not run yet (either brand new
                        // or an exception in the worker) it has no
                        // result.
                       .and(doc('tests')(key).hasFields('result')))
                    .map(key=>doc('tests')(key)('result'))
              ;
            return {
                results: results.fold({},
                           (acc, key)=>acc.merge(this._io.r.object(key, acc(key).default(0).add(1))))
              , total: results.count()
              , '#fonts': doc('iterargs')('font').count().default(null)

            };
        })

        // more?
        .pluck('id', 'results', 'finished', 'created', 'started'
             , 'exception', 'total' , '#fonts')
        .merge({type: 'familytest'})
        ;
};

_p._updateFamilytestDoc = function(isPriming, data) {
    var familyDoc = this._familyDocs.get(data.new_val.id);

    if(!familyDoc)
        // we are not listening to this doc
        return;

    if(familyDoc.data && isPriming)
        // needs no priming anymore, change feed was first.
        return;

    familyDoc.data = data;
    familyDoc.subscriptions.forEach(subscription => {
        _callbackFamilyDocSubscubscriber(subscription, familyDoc.data);
    });
};

_p._subscribeToFamilyDocChanges = function() {
    return this._getDashboardFamilytestQuery()
        .changes({includeInitial: false, squash: 1})
        .run((err, cursor) => {
            if(err)
                this._raiseUnhandledError('Can\'t acquire change feed.', err);

            if(!this._familyDocs.size)
                // everybody has left! Close the change feed there are no more subscribers
                this._closeCursor(cursor);

            this._familyDocsSubscriptionCursor = cursor;
            cursor.each((err, data) => {
                if(err)
                    this._raiseUnhandledError('Change feed cursor error:', err);

                if(data.new_val)
                    this._updateFamilytestDoc(false, data);
                // else: it is a delete, not yet supported
            });

        }, {cursor: true});
};

_p._subscribeToFamilyDoc = function(familytests_id, callback, ...args) {
    var familyDoc = this._familyDocs.get(familytests_id)
      , subscription = {
            familytests_id: familytests_id
          , callback: callback
          , args: args
        }
      , subscriptions
      ;

    if(this._familyDocsSubscriptionCursor === null) {
        this._familyDocsSubscriptionCursor = 'pending';
        this._subscribeToFamilyDocChanges();
    }

    if(!familyDoc) {
        familyDoc = {
            subscriptions: subscriptions = new Set()
          , data: null
        };
        // at this point we start to record changes for this familytests_id
        this._familyDocs.set(familytests_id, familyDoc);

        // This may need priming, but also maybe the change feed is faster.
        // if there's data when this request returns then the changefeed
        // has won.
        this._getDashboardFamilytestQuery(familytests_id)
            .run()
            .then(data => this._updateFamilytestDoc(true, {new_val: data}));
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

    return this._io.query('collection')
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
    return this._io.query('collection')
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
      , channel = 'changes-collection'
      ;
    collectionSubscription.consumers.forEach(socketId => {
        let consumer = this._collectionConsumers.get(socketId);
        consumer.socket.emit(channel, doc);
    });
};

_p._sendInitialCollectionSubscription = function(collectionId, socketId) {
    var collectionSubscription = this._collectionSubscriptions.get(collectionId)
      , consumer = this._collectionConsumers.get(socketId)
      , channel = 'changes-collection'
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
_p._disconectFromCollections = function(socket) {
    var socketId = socket.id
      , consumer = this._collectionConsumers.get(socketId)
      ;
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
    //     this._io.query('collection')
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

_p._disconnectFromDashboard = function(socket) {
    var socketId = socket.id
      , consumers, consumer;

    if(!this._dashboardSubscription)
        return;
    consumers = this._dashboardSubscription.consumers;
    consumer = consumers.get(socketId);
    if(!consumer)
        return;

    consumer.unsubscribe_callbacks.forEach(unsubscribe => unsubscribe());
    consumers.delete(socketId);

    if(!consumers.length) {
        this._closeCursor(this._dashboardSubscription.cursor);
        this._dashboardSubscription = null;
    }
};

_p._updateDashboardCollectionDoc = function(isPriming, doc) {
    var collectionDocs = this._dashboardSubscription.collectionDocs
      , consumers = this._dashboardSubscription.consumers
      , key = [doc.collection_id, doc.family_name].join('...')
      , current = collectionDocs.get(key)
      ;
    // Do this check, because of us not using includeInitial
    // and the "priming" request
    if(isPriming && current)
        // the change feed was faster
        return;

    collectionDocs.set(key, doc);
    // send updates to each consumers;
    consumers.forEach((consumer) => {
        this._sendToDashboardConsumer(consumer, doc);
    });
};

_p._sendToDashboardConsumer = function(consumer, collectiontest_data) {
    var channel = 'changes-dashboard'
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
    //jshint unused:vars
    var consumer;
    if(!this._dashboardSubscription) {
        this._dashboardSubscription = {
            cursor: null
          , consumers: new Map()
          , collectionDocs: new Map()
        };
        // init the cursor
        this._io.query('collection')
        .merge({type: 'collectiontest'})
        .changes({squash: 1})
        .run((err, cursor) => {
            if(err)
                this._raiseUnhandledError('Can\'t acquire change feed.', err);
            this._dashboardSubscription.cursor = cursor;
            cursor.each((err, data) => {
                if(err)
                    this._raiseUnhandledError('Change feed cursor error:', err);
                this._updateDashboardCollectionDoc(false, data.new_val);
            });
        }, {cursor: true})
        .then(() => {
            // prime the cache
            return this._io.query('collection')
                .group({index: 'collection_family'})
                .max('date')// only the most current entries in each group
                .merge({type: 'collectiontest'})
                .run()
                .then(collectionRows => {
                    collectionRows.forEach((row) => {
                        this._updateDashboardCollectionDoc(true, row.reduction);
                    });
                });
        })
        ;
    }

    consumer = this._dashboardSubscription.consumers.get(socket.id);
    if(consumer) {
        // is already subscribed ... ?
        // reset the consumer: unsbscribe all
        // also this is what we to do on a hang up, see _disconnectFromDashboard
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
    // storing in global scope, to make it available for inspection
    // in the debugger.
    global.server = new FontBakeryServer(setup.logging, 3000, setup);
}
