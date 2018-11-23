"use strict";
/* jshint esnext:true, node:true*/


function Step(state, process) {
    this.parent = process;
    this._state = state;
    this._tasks = this._initTasks(this.constructor.tasks);
}

const _p = Step.prototype;

// expecting the sub-constructor to define these!
Step.tasks = null;

_p._initTasks = function(tasks) {
    var result = [];
    for(let TaskCtor of tasks) {
        TODO;
        let taskState = this._state.tasks[i];
        result.push(new TaskCtor(taskState, this));
    }
    return result;
};

// copied from manifestSources/_Source.js
function reflectPromise(promise) {
    return promise.then(
            value => ({value:value, status: true }),
            error => ({error:error, status: false }));
}


_p._activateTask = function(task) {
    try {
        // may return a promise but is not necessary
        // Promise.resolve will fail if task.activate returns a failing promise.
        return Promise.resolve(task.activate());
    }
    catch(error) {
        return Promise.reject(error);
    }
}

_p.activate = function() {
    var promises = [];
    for(let task of this._tasks)
        promises.push(task.activate());
    // Using reflectPromise because we don't want to have
    // Promise.all fail, instead only wait for all promises to be
    // finished, regardless of being resolved or rejected.
    // `task.activate()` does error handling for us already.
    return Promise.all(promises.map(reflectPromise))
        .then(results=> {
            TODO; // This should have changed the statuses of the tasks
            // some may have a FAILED state now, some are OK or still PENDING.
            // probably now the Process must check it's overall state.
            this._checkState();
        });
}
