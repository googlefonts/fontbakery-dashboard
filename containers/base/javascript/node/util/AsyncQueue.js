#! /usr/bin/env node
"use strict";
// this is expected to run in nodejs
/* jshint esnext:true, node:true*/

function AsyncQueue() {
    this._current = null;
    this._thread = [];
}

const _p = AsyncQueue.prototype;

_p._tick = function() {
    if(!this._thread.length || this._current) {
        return;
    }

    this._current = this._thread.pop();
    this._current().then(() => {
        this._current = null;
        this._tick();
    });
};

_p.schedule = function(job) {
    var resolve, reject
        // resolve, reject of the closure are
      , jobPromise = new Promise((res, rej) => {
            resolve = res;
            reject = rej;
        })
      ;
    this._thread.unshift(() => {
        var result;
        try {
            result = job();
            resolve(result);
        } catch(err) {
            reject(err);
        }

        return (result && typeof result.then === 'function')
              // run next after result; no matter if result succeeds or fails
            ? result.then(()=>null, ()=>null)
              // run next queue.thread item asap
            : Promise.resolve(null)
            ;
    });
    this._tick();
    return jobPromise;
};

exports.AsyncQueue = AsyncQueue;
