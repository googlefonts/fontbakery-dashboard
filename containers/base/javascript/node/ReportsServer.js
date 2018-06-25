#! /usr/bin/env node
"use strict";
// this is expected to run in nodejs
/* global require, module */
/* jshint esnext:true */

const getSetup = require('./util/getSetup').getSetup
  , { IOOperations } = require('./util/IOOperations')
  , grpc = require('grpc')
  , { ReportsService } = require('protocolbuffers/messages_grpc_pb')
  , { Report, ReportsQuery } = require('protocolbuffers/messages_pb')
  , { Timestamp } = require('google-protobuf/google/protobuf/timestamp_pb.js')
  , { Empty } = require('google-protobuf/google/protobuf/empty_pb.js')
  ;

/**
 * Tasks
 * - put Report message into persistent storage
 * - provide interfaces to make all reports accessible.
 *
 * This uses the RethinkDB, as it's already persitent.
 * One problem could be RethinkDB (IOOperations) being the bottleneck
 * when a lot of checks are reporting, but this service itself will not
 * be very performance hungry.
 */
function ReportsServer(logging, dbSetup, port) {
    this._logging = logging;
    this._dbSetup = dbSetup;
    this._io = new IOOperations(logging, dbSetup);

    this._server = new grpc.Server({
        'grpc.max_send_message_length': 80 * 1024 * 1024
      , 'grpc.max_receive_message_length': 80 * 1024 * 1024
    });

    this._server.addService(ReportsService, this);
    this._server.bind('0.0.0.0:' + port, grpc.ServerCredentials.createInsecure());
}

var _p = ReportsServer.prototype;

_p.serve =  function() {
    // Start serving when the database is ready
    return this._io.init()
        .then(()=>this._server.start());
};


_p.file = function(call, callback) {
    var report = call.request // call.request is a protocolbuffers/messages_pb.js:Report
      , reportDoc = {
            type: report.getType() // string e.g. 'source'
          , typeId: report.getTypeId() // string e.g. "upstream"
          , method: report.getMethod() // string e.g. "update"
          , started: report.getStarted().toDate() // Timestamp -> Date
          , finished: report.getFinished().toDate() // Timestamp -> Date
          , reported: new Date()
          , reportData: JSON.parse(report.getData()) // array of report items
        }
      ;

    this._logging.debug('[FILE]',new Date(),'type:', reportDoc.type
                      , 'id:', reportDoc.typeId
                      , 'method:', reportDoc.method);

    return this._io.insertDoc('statusreport', reportDoc)
        //.then(response=>response.generated_keys[0]);// => statusreports id;
        .then(
            // we could respond with the new document id, but there's
            // currently no use for it in the reporters, so Empty seems
            // a good choice after all.
            ()=>callback(null, new Empty())
          , err=>{
              this._logging.error('[FILE] ERROR', err);
              callback(err, null);
            }
        );
};

function timestampFromDate(date){
    var ts = new Timestamp();
    ts.fromDate(date);
    return ts;
}

function reportFromDbDoc(reportDoc) {
    var report = new Report();
    report.setId(reportDoc.id);
    report.setType(reportDoc.type);
    report.setTypeId(reportDoc.typeId);
    report.setMethod(reportDoc.method);
    report.setStarted(timestampFromDate(reportDoc.started));
    report.setFinished(timestampFromDate(reportDoc.finished));
    report.setReported(timestampFromDate(reportDoc.reported));
    if('reportData' in reportDoc)
        report.setData(JSON.stringify(reportDoc.reportData));
    return report;
}

/**
 * Returns [query, bool:reverseResult] `query` is a configured rethinkdb
 * query object, ready for query.run(); `reverseResult` is a boolean flag
 * that hints the caller that the query result must be reversed to get
 * the expected order of entries (reported date descending). This is
 * caused in the optimization strategy for the paging of the query.
 *
 * To receive just a list of reports by document id the `get` api is
 * much faster.
 *
 * Important (for all dates): Date.prototype.toISOString() returns
 * a date string that contains the milliseconds: "2018-06-14T10:10:33.692Z"
 * and that can be parsed losslessly with new Date("2018-06-14T10:10:33.692Z");
 * so, to serialize a date use `myDate.toISOString()` *NOT*  `myDate.toString()`
 */
_p._setupQueryReports = function(reportsQuery) {
    var r = this._io.r
      , query = this._io.query('statusreport')
      , filtersMap = reportsQuery.getFiltersMap()
      , previousPage = false
      ;

    // https://www.rethinkdb.com/docs/cookbook/javascript/#pagination
    // "This is the most efficient way to paginate[…]"
    if(reportsQuery.hasPagination()) {
        let reportsPagination = reportsQuery.getPagination()
          , paginationItem = [
                         reportsPagination.getItemReported().toDate()
                       , reportsPagination.getItemId()
                    ]
          ;
        // Not in let, because we need to override the outer scope var!
        previousPage = reportsPagination.getPreviousPage();
        if(!previousPage) {
            // next page (default!)
            // paginationItem is the "smallest" item on that page
            // and we're interested in all items < paginationItem
            // excluding paginationItem
            query = query.between(r.minval, paginationItem, {
                // closed: includes value
                // open: excludes value
                leftBound: "closed" // >= r.minval
              , rightBound: "open" // < paginationItem
              , index: "reported_id"

            });
        }
        else {
            // previous page
            // r.maxval should still be right, order is reversed, but not
            // get all items <= paginationItem
            // paginationItem is the first (biggest) item of the (requesting)
            // page and we want to get all items > paginationItem
            // excluding pagefirstItem
            query = query.between(paginationItem, r.maxval , {
                // closed: includes value
                // open: excludes value
                leftBound: "open" // > paginationItem
              , rightBound: "closed" // <= r.maxval
              , index: "reported_id"
            });
        }
    }

    if(!previousPage)
        // The client expects the result in descending reported-date order,
        // i.e. the newest date first, last pages contains the oldest items
        query = query.orderBy({index: r.desc('reported_id')});
    else
        // This is reversed, to make limit work instead of heaving to
        // use the less efficient slice(-pageSize);
        query = query.orderBy({index: r.asc('reported_id')});

    let pageSize = 25;
    query = query.limit(pageSize);

    for(let [name, reportsFilter] of filtersMap.entries()) {
        switch(reportsFilter.getType()) {
            case(ReportsQuery.Filter.Type.VALUE):
                // assert name in ['id', 'type', 'typeId', 'method']
                // -> "contains"
                query = query.filter(function(row) { //jshint ignore:line
                    return r.expr(reportsFilter.getValuesList()).contains(row(name));
                });
            break;
            case(ReportsQuery.Filter.Type.DATE):
                // assert name in ['started', 'finished', 'reported']
                let dates = reportsFilter.getMinMaxDatesList();
                if(!dates.length)
                    continue;
                dates.sort(); // always have min as first element
                if(dates.length === 1)
                    query = query.filter(r.row(name).ge(dates[0].toDate()));
                else
                    query = query.filter(r.row(name).during(
                        // smallest and greatest dates after `dates.sort()`!
                        dates[0].toDate(), dates[dates.length-1].toDate()));
            break;
        }
    }

    var keysToPluck = [
        'id'
      , 'reported'
      , 'type'
      , 'method'
      , 'typeId'
      , 'started'
      , 'finished'
    ];
    if(reportsQuery.getIncludeData())
        keysToPluck.push('reportData');
    query = query.pluck(...keysToPluck);
    return [query, previousPage/* bool:reverseResult */];
};

_p._queryReports = function(reportsQuery) {
    var [query, reverseResult] = this._setupQueryReports(reportsQuery);
    return query.run().then(docs=>{
        if(reverseResult)
            docs.reverse();
        return docs;
    });
};

/**
 * writes a stream of Report's to call!
 */
_p._streamReports = function(call, docs) {
    // this is crucial to get a proper error message in the log output
    // when e.g. `call.write(report)` fails. it would be nice to have a
    // more direct way to get these errors. Right now, the for loop
    // keeps calling `call.write(report)` even after an error was
    // was registered, then with:
    //      Error [ERR_STREAM_WRITE_AFTER_END]: write after end
    // initial error was due to `report.setData(reportDoc.reportData)`
    // where data must be a string (json) and reportDoc.reportData is an
    // object (array)
    call.on('error', error=>this._logging.error(
                            'ERROR while streaming response:', error));
    try {
        for(let reportDoc of docs) {
            let report = reportFromDbDoc(reportDoc);
                // Seems to return false on fail and true on success,
                // but there's no good documentation about this writable
                // stream implementation.
            call.write(report);
        }
        // all reports are sent
        call.end();
    }
    catch(error) {
        call.error(error, null);
        throw error;
    }
};

/**
 * takes a ReportsQuery and returns a stream of Report-messages.
 *
 * reportsQuery.Filters options:
 *
 * Type.DATE -- started, finished, reported
 * can be used to limit the date range. All of these have two items: [fromDate, toDate]
 * (will be sorted to avoid failures here, the smaller date is always fromDate).
 * If there's one item, it is items >= date, like: [fromDate, MAXDATE].
 * If there are more than two items, the smallest and the greatest will be used.
 *
 * Type.Value -- type, method, id
 * direct match, all of these can be/are lists, allowing multiple types/ids/methods
 * to be selected.
 *
 * returns a stream of Report-messages
 *      optionaly containing `reportData` => ReportsQuery needs a flag for this
 *      also, *always!* containing the database id
 */
_p.query = function(call) {
    var reportsQuery = call.request; // call.request is a ReportsQuery
    this._logging.debug('[QUERY]', reportsQuery.toObject());
    return this._queryReports(reportsQuery)
        .then(docs=>this._streamReports(call, docs))
        .then(null, err=>{
              this._logging.error('[GET] ERROR', err);
        })
        ;
};

/**
 * Return one or more Report-messages.
 *
 * Reports for ids that are multiple times in the ReportIds message,
 * mutiple reports will be returned. Missing ids will be ignored, there's
 * no "Not Found" error. By comparing the requested IDs with the IDs
 * of the returned Report-messages, not found ID's can be identified.
 */
_p.get = function(call) {
    var reportIds = call.request // call.request is a ReportIds
      , ids = reportIds.getIdsList()
      ;
    this._logging.debug('[GET] ids:', ids);
    return this._io.query('statusreport').getAll(...ids).run()
        .then(docs=>this._streamReports(call, docs))
        .then(null, err=>{
              this._logging.error('[GET] ERROR', err);
        })
        ;
};


/**
 * THIS IS A STUB. Maybe we want to have a UI that configures itself by
 * the capabilities of the service it is querying. This could be the
 * description of the service capabilities.
 *
 * returns a ReportsQuery with all value filters and their possible values
 * an all date filters with their current  min/max dates.
 *
 * The one value filter that is omitted is "id", because that would mean
 * to include all ids, which by themselves have no meaning. I.e. there's
 * no way to decide whether one wants to see a report purely by watching
 * at it's id. The database id is just a random string.
 * /
_p.describe = function(call, callback) {
    // call.request is a google-protobuf/google/protobuf/empty_pb:Empty
    this._logging.debug('[DESCRIBE]');

    return this._io.query('statusreport')
        .get all unique entries for

        .then(queryResult=>{
            var response = new ReportsQuery()
            for(name of ['type', 'typeId', 'method']) {
                //queryResult[name] should be an array of unique values
                let filter = new ReportsQuery.Filter()
                  , values = queryResponse[name]
                  ;
                // FIXME: is ReportsQuery.Filter.Type.VALUE the enum?
                filter.setType(ReportsQuery.Filter.Type.VALUE);
                filter.setValuesList(queryResponse[name]);
                response.getFiltersMap().set(name, filter) // this is a map

            }

            for(name of ['started', 'finished', 'reported']) {
                let filter = new ReportsQuery.Filter()
                  , values = queryResponse[name]
                  ;
                // FIXME: is ReportsQuery.Filter.Type.VALUE the enum?
                filter.setType(ReportsQuery.Filter.Type.DATE);
                filter.setMinMaxDatesList([
                      timestampFromDate(values.min)
                    , timestampFromDate(values.max)
                ]);
                response.getFiltersMap().set(name, filter) // this is a map
            }
            return response;
        })
        .then(
            response=>callback(null, response)
          , err=>callback(err, null)
        );
};
*/

exports.ReportsServer = ReportsServer;

if (typeof require != 'undefined' && require.main==module) {
    var setup = getSetup(), reportsServer, port=50051;

    for(let i=0,l=process.argv.length;i<l;i++) {
        if(process.argv[i] === '-p' && i+1<l) {
            let foundPort = parseInt(process.argv[i+1], 10);
            if(foundPort >= 0) // not NaN or negative
                port = foundPort;
            break;
        }
    }
    setup.logging.info('Init server, port: '+ port +' ...');
    setup.logging.log('Loglevel', setup.logging.loglevel);
    reportsServer = new ReportsServer(setup.logging, setup.db, port);
    reportsServer.serve()
        .catch(err => {
            setup.logging.error('Can\'t initialize server.', err);
            process.exit(1);
        });
}
