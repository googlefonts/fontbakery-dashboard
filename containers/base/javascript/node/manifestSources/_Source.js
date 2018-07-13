#! /usr/bin/env node
"use strict";
// this is expected to run in nodejs
/* jshint esnext:true */

const { ReportsClient } = require('../util/ReportsClient')
  , { Report } = require('protocolbuffers/messages_pb')
  , { Timestamp } = require('google-protobuf/google/protobuf/timestamp_pb.js')
  ;

function _Source(logging, id, reportsSetup) {
    // jshint validthis: true
    this._log = logging;
    this.id = id;

    // Both implemented as stub functions!
    // this._queue = null;
    // this._dispatchFamily = null;

    this._reportData = null;
    this._reports = null;
    if(reportsSetup)
        // needs this._reports.waitForReady(); see this.init
        this._reports = new ReportsClient(logging, reportsSetup.host
                                                    , reportsSetup.port);
}

var _p = _Source.prototype;

Object.defineProperty(_p, 'reports', {
    get: function(){
        if(!this._reports)
            throw new Error('Reports client is not configured');
        return this._reports;
    }
});

/**
 * Use this to add a data item to the report.
 *
 *
 * There's a generic, persistent report logging service.
 * It takes just the whole report, no incremental updates/streaming data yet.
 *
 * The report data:
 *
 * {
 *          type: 'source' // for structuring
 *        , id: this.id // type + id should be unique
 *        , report: [
 *                  // can contain different structures:
 *                  // * a table: CSV data will be rendered by the frontend
 *                  //   has information whether to render the head row and/or
 *                  //   column as thead/th. All fields will be markdown interpreted
 *                  // * just markdown (do not render the table completely
 *                  //   as markdown in here, to avoid having too much formatting
 *                  //   right here.)
 *          ]
 * }
 *
 */
_p._reportAdd = function(type, data, initial) {
    if(this._reportData === null) {
        if(!initial)
            // Don't use this._reportData in conflicting conditions!
            // if this raises, the approach of the sources concurrency
            // may be troubled. NOTE: this should be managed via the queue
            // mechanism in ManifestServer.
            throw new Error('There\'s already reportData, but this is '
                            + 'marked as the initial entry!');
        this._reportData = [];
        this._reportData.started = new Date();
    }
    this._reportData.push([type, data]);
};

function timestampFromDate(date){
    var ts = new Timestamp();
    ts.fromDate(date);
    return ts;
}
/**
 * Sends the collected report data to the ReportsService.
 */
_p._reportFlush  = function(method) {
    var report = new Report();
    report.setType('source'); // string
    report.setTypeId(this.id); // string
    report.setMethod(method); // string
    report.setStarted(timestampFromDate(this._reportData.started)); // Timestamp
    report.setFinished(timestampFromDate(new Date())); // Timestamp
    report.setData(JSON.stringify(this._reportData)); // string

    this._reportData = null;

    return this.reports.file(report)
        .then(null, err=>{
            this._log.error(err);
            // this is logged, no need to propagate further.
            // throw err;
        });
};

_p._queue = function() {
    throw new Error('Not implemented! Use setQueue to add the interface!');
};

_p._dispatchFamily = function() {
    throw new Error('Not implemented! Use setDispatchFamily to add the interface!');
};

function reflectPromise(promise) {
    return promise.then(
            value => ({value:value, status: true }),
            error => ({error:error, status: false }));
}

/**
 * Reject when all promises are finished, rejected OR resolved, and at
 * least one promise was rejected.
 * Resolve when all promises are resolved and none was rejected.
 *
 * NOTE, this is a replacement for Promise.all, but Promise.all fails
 * immediately on the first rejected promise and we need all promises
 * to finish fist, before rejecting or resolving.
 *
 * I.e. wait until all promises have finished!
 */
_p._waitForAll = function(promises) {
    return Promise.all(promises.map(reflectPromise)) // always resolves
        .then(results=>{
            let rejects = results.filter(item=>!item.status);
            if(rejects.length)
                throw new Error(rejects.length + ' promises did not finish successfully.');
            return results.map(item=>item.value);
        });
};

_p.setDispatchFamily = function(dispatchFamilyAPI) {
    this._dispatchFamily = dispatchFamilyAPI;
};

_p.setQueue = function(queueAPI) {
    this._queue = queueAPI;
};

// generic source API?
_p.schedule = function(task /* args */) {
    // queue even is task is already scheduled? Like if a `update`
    // is long running, and the cron/timer schedules it even though it
    // is running now or in this._scheduled, that may be a bit annoying.
    // Still, if no update is needed by then, nothing more should happen
    // than a basic check.
    var args = [], i, l;
    for(i=1,l=arguments.length;i<l;i++)
        args.push(arguments[i]);
    // use the global `schedule` queue for all sources of the ManifestServer
    // if not good: use this._queue(this.id+':schedule', ...)
    return this._queue('schedule', () => {
       return this[task].apply(this, args);
    });
};

// Runs immediately on init. Then it's called via the poke interface.
// There's no cron/scheduling in the ManifestSource itself.
_p.update = function() {
    // jshint unused:vars
    throw new Error('Not Implemented "update".');
};

_p.init = function() {
    // may return a promise if the source needs to set up its own resources.
    // promise exceptions will be handled as well (= end the server).
    return this._reports ? this._reports.waitForReady() : null;

};

exports._Source = _Source;
