"use strict";
/* jshint esnext:true, node:true*/

const {mixin: stateManagerMixin} = require('stateManagerMixin');

function Step(state, process, taskCtors) {
    this.parent = process;
    // must be an object of {taskName: TaskConstructor}
    this._taskCtors = taskCtors;
    this._state = null;
    if(state === null)
        // make a new step, i.e. without having any existing state.
        this._initState();
    else
        // may fail!
        this._loadState(state);
}

const _p = Step.prototype;

_p._initTasks = function() {
    var tasks = {};
    for(let [key, TaskCtor] of Object.entries(this._taskCtors))
       tasks[key] = new TaskCtor(null, this);
    return tasks;
};

_p._loadTasks = function(tasksState) {
    var taskCtorsLen = Object.keys(this._taskCtors).length
      , tasksStateLen = Object.keys(tasksState).length
      ;
    if(taskCtorsLen !== tasksStateLen)
        throw new Error('Incompatible tasksState expected ' + taskCtorsLen
                + ' entries but received ' + tasksStateLen +'.');

    var tasks = {};
    for(let [key, TaskCtor] of Object.entries(this._taskCtors)) {
        if(!(key in tasksState))
            throw new Error('Incompatible tasksState: entry for '
                                        + 'key "' + key + '" is missing.');
        tasks[key](new TaskCtor(tasksState[key], this));
    }
    return tasks;
};

Object.defineProperties(_p, {
    isActivated: {
        get: function() {
            return this._state.isActivated;
        }
    }
    // MAYBE: is Failed can only be true after the UI acknowledged it
    // or if explicitly no user interaction is required to fail the step
    // in case of failing tasks.
    // if there's a t least one failed process techncically the step is already
    // failed, but we wan't to add an optional way that requires user interaction
    // to finish the the step in a failed state. before isFailed can be true
    // (and thus the step is closed)
  , isFailed: {TODO}
    // if this is an active step and !this.isClosed
    // the step is still pending, i.e. the process can't transition
    // to the next step.
    // isClosed should return true when isFailed is true as well
    // maybe just: return this.isFailed || this.isOk
    //
    // BUT: we want the failed step to require explicit closing …
    // maybe the best thing to do is to use the FailStep for this.
    // Then, there's no need to fix something special into this
    // implementation?
    //
    // I stated somewhere:
    // if a Step is failing, finishing it will require user interaction,
    // in order to file the GIt issue at the right place and with a meaningful
    // message and to leave a final note in the Process. So, if a step is
    // failing, instead of finalizing it, individual tasks can be re-run
    // as well, which makes sense when we depend on external services and
    // sources to function properly or not
  , isClosed: {TODO}
});

const stateDefinition = {
    tasks: { // array, task statuses, must be compatible with this._taskCtors
        init: _p._initTasks
      , serialize: tasks=> {
            var data = {};
            for(let [key, task] of Object.entries(tasks))
                data[key] = task.serialize();
            return data;
        }
      , load: _p._loadTasks
      // always expected
    }
  , isActivated: {
        init: ()=>false
      , serialize: val=>val
      , load: val=>val
    }
    // rejection reason
    // status: PENDING, PASS, FAIL
    // but this status comes basically directly from the tasks status
    // so maybe we can calculate this and don't put into the DB
    // depends whether we need to query the step state at this level.
};

stateManagerMixin(_p, stateDefinition);

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
};

/**
 * called by process when transitioning, e.g. moving to the next step.
 */
_p.activate = function() {
    // FIXME: do we allow reactivation?
    // i.e. if this._state.isActivated === true
    // at the moment, I would assert this._state.isActivated === false
    // Though, we may add a feature to reset a step completely and
    // reactivate it.
    if(this._state.isActivated)
        // At the moment, expect caller to check this.
        throw new Error('Step is already activated.');
    this._state.isActivated = true;
    var promises = [];
    for(let task of this._state.tasks)
        promises.push(task.activate());
    // Using reflectPromise because we don't want to have
    // Promise.all fail, instead only wait for all promises to be
    // finished, regardless of being resolved or rejected.
    // `task.activate()` does error handling for us already.
    return Promise.all(promises.map(reflectPromise))
        .then(results => {
            // jshint unused: vars
            TODO; // This should have changed the statuses of the tasks
            // some may have a FAILED state now, some are OK or still PENDING.
            // probably now the Process must check it's overall state???
            // how to implement the UI that closes a step when it has failed
            // tasks ... ?
            this._checkState(); ??? needed ??? what does it do?
        });
};

// what is this good for?
_p._transition = _p._checkState = function() {
    // what to check here???

    // In case of at least one failed Task, we want to finish the whole
    // step as Failed, but explicitly with user interaction
    // thus, before closing, the user can maybe re-run tasks or make them
    // pass, OR also just wait with closing until all pending tasks are
    // resolved.
    // We could also wait until all tasks have finished, without the
    // shortcut of having just one failed to make it possible to finish
    // the task directly. Thus, we'd likely not prevent pending callbacks
    // from ending tasks and also have better feedbacks when task are
    // just pending forever.
    //

    // In case of all Tasks passed, just finish the whole step directly
    // as OK and let Process proceed to activate the next step.


};

/**
 * validate and perform `actionMessage`
 *
 * This is the single mechanism that changes process state.
 */
_p.execute = function(targetPath, actionMessage) {
    var task = this._getTask(targetPath.task);TODO; // implement
    // If this task is present (and the step is active) it can always
    // be executed.
    return task.execute(actionMessage)
        .then(()=>this._transition())  //TODO: implement also see this._checkState();
        .then(()=>this)
        ;
};
