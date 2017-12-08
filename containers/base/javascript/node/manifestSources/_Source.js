#! /usr/bin/env node
"use strict";
// this is expected to run in nodejs
/* jshint esnext:true */


function _Source() {
    // jshint validthis: true
    this.__tick = this._tick.bind(this);
    this._currentTask = null;
    this._scheduled = [];
}

var _p = _Source.prototype;

_p._dispatchFamily = function() {
    throw new Error('Not implemented! Use the setDispatchFamily interface!');
};

_p.setDispatchFamily = function(dispatchFamily) {
    this._dispatchFamily = dispatchFamily;
};

_p._tick = function() {
    if(!this._scheduled.length || this._currentTask)
        return;
    var [task, args, resolve, reject] = this._scheduled.shift();
    this._currentTask = this[task].apply(this, args)
        // unset _currentTask
        .then(resolve, reject)
        .then(() => this._currentTask = null)
        // schedule the next tick
        // even on error! Otherwise we loose continuation to work on
        // this._scheduled
        // finally:
        .then(this.__tick, this.__tick)
        ;
};

// generic source API?
_p.schedule = function(taskName /* args */) {
    // push even is task is already scheduled? Like if a `update`
    // is long running, and the cron/timer schedules it even though it
    // is running now or in this._scheduled, that may be a bit annoying.
    // Still, if no update is needed by then, nothing more should happen
    // than a basic check.
    var task
      , args = [], i, l
      , promise = new Promise(
              // the executor runs immediately
              (resolve, reject) => {task = [taskName, args, resolve, reject]; })
      ;
    for(i=1,l=arguments.length;i<l;i++)
        args.push(arguments[i]);
    this._scheduled.push(task);
    this._tick();
    return promise;
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
}

exports._Source = _Source;
