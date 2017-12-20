#! /usr/bin/env node
"use strict";
// this is expected to run in nodejs
/* jshint esnext:true */


function _Source() {
    // jshint validthis: true

    // Both implemented as stub functions!
    // this._queue = null;
    // this._dispatchFamily = null;
}

var _p = _Source.prototype;

_p._queue = function() {
    throw new Error('Not implemented! Use setQueue to add the interface!');
};

_p._dispatchFamily = function() {
    throw new Error('Not implemented! Use setDispatchFamily to add the interface!');
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
       return  this[task].apply(this, args);
    });
};

// Runs immediately on init. Then it's called via the poke interface.
// There's no cron/scheduling in the ManifestSource itself.
_p.update = function(forceUpdate) {
    // jshint unused:vars
    throw new Error('Not Implemented "update".');
};

_p.init = function() {
    // may return a promise if the source needs to set up its own resources.
    // promise exceptions will be handled as well (= end the server).
    return null;
};

exports._Source = _Source;
