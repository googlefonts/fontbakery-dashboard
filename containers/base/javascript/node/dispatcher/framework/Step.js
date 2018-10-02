"use strict";
/* jshint esnext:true, node:true*/

const {mixin: stateManagerMixin} = require('stateManagerMixin')
    , {validTaskStatuses } = require('./Task')
    , {Status, OK, FAILED, PENDING} = require('./Status')
    ;

function Step(state, process, taskCtors) {
    this.parent = process;
    // taskCtors must be an object of {taskName: TaskConstructor}
    this._taskCtors = new Map(Object.entries(taskCtors));
    this._state = null;
    if(state === null)
        // make a new step, i.e. without having any existing state.
        this._initState();
    else
        // may fail!
        this._loadState(state);
}

const _p = Step.prototype;

FIXME;// thinking of permanent user interaction allowed for
// the active step:
// always: re-activate any task
// this may also change the FAIL status of the step;
// i.e. if the step is FAILed but not closed, re-running a/the failed task
// may make the task pass and subsequently the step as well.
//
// also, if the step is failed but not closed yet, a user interaction
// to choose/set up the closing action/message would be good.
//
// also, Tasks may need a kind of time out.
// we can theoretically wait forever for a task to receive an answer
// but that's not perfect. Options:
// hard default or custom timeout -> task fails re-activate ui appears
// soft default or custom timeout: re-activate or manually fail ui (buttons)
// appears, otherwise the task is just PENDING/waiting until the hard timeout
//
// also, a hard-timeout could have a retry count attached???
// rendering images with browser stack can have the worst availability
// possible, so, we should be able to query it multiple times over a long
// period of time.
//
// maybe we can have a kind of cron service for a task to schedule re-runs
// via the execute/callbackTicket interface? The task implementation itself
// would use this, or at least configure it.

_p._initTasks = function() {
    var tasks = new Map();
    for(let [key, TaskCtor] of this._taskCtors)
       tasks.set(key, new TaskCtor(null, this));
    return tasks;
};

_p._loadTasks = function(tasksState) {
        // array of [[key, serializedState], [key, serializedState], ...]
    var tasksStateMap = new Map(tasksState);
    if(this._taskCtors.size !== tasksState.length)
        throw new Error('Incompatible tasksState expected ' + this._taskCtors.size
                + ' entries but received ' + tasksState.length +'.');

    var tasks = new Map();
    for(let [key, TaskCtor] of this._taskCtors) {
        if(!tasksStateMap.has(key))
            throw new Error('Incompatible tasksState: entry for '
                                        + 'key "' + key + '" is missing.');
        tasks.set(key, new TaskCtor(tasksStateMap.get(key), this));
    }
    return tasks;
};

Object.defineProperties(_p, {
    isActivated: {
        get: function() {
            return this._state.isActivated;
        }
    }
    // If there's at least one failed process techniccally the step is already
    // failed, but there will be a (optional?) way that requires user interaction
    // to finish the the step in a failed state.
  , isFailing: {
        /**
         * Return true if at least on taks.status === FAILED.
         * isFailing can change as long the step is not finished thus
         * this property is calculated on request.
         */
        get: function() {
            // This is semantically the correct definition, don't touch it ever.
            for(let task of this._state.tasks.values()) {
                if(task.status === FAILED)
                    return true;
            }
            return false;
        }
    }
  , isFailed: {
        /**
         * If the step is finished and there's a FAILED task, this
         * step isFailed for good.
         */
        get: function() {
            return this.isFinished
                        ? this._state.finishedStatus.status === FAILED
                        : false
                        ;
        }
    }
  , isFinished: {
        /**
         * This closes the step and all its tasks from any further
         * modifications ever.
         */
        get: function() {
            return this._state.finishedStatus !== null;
        }
    }
});

const stateDefinition = {
    tasks: { // array, task statuses, must be compatible with this._taskCtors
        init: _p._initTasks
      , serialize: tasks=> {
            return [...tasks].map(([key, task])=>[key, task.serialize()]);
        }
      , load: _p._loadTasks
      // always expected
    }
  , isActivated: {
        init: ()=>false
      , serialize: val=>val
      , load: val=>val
    }
  , isFinished: {
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


FIXME;//this is a stub, recheck!
_p.getRequestedUserInteractions = function() {
    var tasks = []
      , step
      ;
    if(this.isFinished)
        return [null, null];

    for(let [key, task] of this._state.tasks) {
        let rui = task.requestedUserInteraction;
        if(!rui)
            continue;
        tasks.push([key, rui]);
    }

    if(this.isFailing) {// && !this.isFinished
        TODO;// && hasAFailStep rather useFailStep? because that's a standard ui
        // do we need a ticket for this as well???
        // it seems like there's no reason not to have one!
        step = [TODO];
    }
    return {step, tasks};
};

// copied from manifestSources/_Source.js
function reflectPromise(promise) {
    return promise.then(
            value => ({value:value, status: true }),
            error => ({error:error, status: false }));
}

/**
 * Called by process when transitioning, e.g. moving to the next step.
 */
_p.activate = function() {
    // FIXME: do we allow reactivation?
    // i.e. if this._state.isActivated === true
    // at the moment, I would assert this._state.isActivated === false
    // Though, we may add a feature to reset a step completely and
    // reactivate it. e.g. if for some reasom the expected answer is not
    // coming in and we want to request it again
    if(this._state.isActivated)
        // At the moment, expect caller to check this.
        throw new Error('Step is already activated.');
    this._state.isActivated = true;
    var promises = [];
    for(let task of this._state.tasks.values())
        // these never raise, Task.prototype.activate catches exceptions
        // and puts them into rejected promises
        promises.push(task.activate());
    // Using reflectPromise because we don't want to have
    // Promise.all fail, instead only wait for all promises to be
    // finished, regardless of being resolved or rejected.
    // `task.activate()` does the error handling for us already
    // and this._transition processes the step status
    return Promise.all(promises.map(reflectPromise))
                  .then((/*results*/)=>this._transition());
};

_p._requestFailedUI = function() {
    // We should _requestFailedUI automatically based on
    // the two assertions below.
    // assert this.isFailing;
    // assert !this.isFinished;
    TODO;// this will eventually have to call `this._setFinished`
        // OR re-run tasks and this._transition until they end OK
};

_p._cancelFailedUI = function() {
    // assert !this.isFailing;
    // assert !this.isFinished;
    // maybe not needed!
};

_p._setFinished = function(status, markdown, data) {
    if(status !== OK && status !== FAILED)
        throw new Error('Invalid status code: ' + status);
    this._state.finishedStatus = new Status(status, markdown, null, data);
};

_p._finishedOK = function(markdown, data){
    this._setFinished(OK, markdown, data);
};

_p._finishedFAILED = function(markdown, data){
    this._setFinished(FAILED, markdown, data);
};

_p._transition = function() {
    if(this.isFinished)
        return;

    if(this.isFailing) {
        this._requestFailedUI();
        // until the step is closed, it will be possible to receive
        // further pending answers for the tasks expecting them.
        // But once it's closed, the answers won't be processed anymore.
        // So, in this case, the user could also just wait until all
        // tasks have a finishing status (FAILED or OK) and then decide
        // whether to re-run any tasks.
        return;
    }

    var okCounter = 0;
    for(let task of this._state.tasks.values()) {
        if(task.status === PENDING) {
            // No FAILED but still some PENDING tasks.
            // Just wait.
            // If the user just restarted the FAILED tasks we don't need
            // the FailedUI anymore.
            this._cancelFailedUI();
            return;
        }
        if(task.status === OK)
            okCounter += 1;
    }

    if(okCounter === this._state.tasks.size) {
        // successfully completed all tasks
        // close, succesfully
        this._finishedOK('All tasks completed successfully.');
        this._state.isFinished = true; // finishes the step
        return;
    }

    // This should not happen! investigate! task.status should also
    // raise if this assertion fails.
    // validTaskStatuses must be defined like: new Set([OK, FAILED, PENDING])
    // otherwise the implementation above doesn't make sense anymore.
    throw new Error('There are invalid statuses used in the tasks: '
        + [...new Set([...this._state.tasks.values].map(task=>task.status))]
                // remove valid statuses
               .filter(status=>!validTaskStatuses.has(status))
               .join(', '));
};

_p._getTask = function(key) {
    if(!this._state.tasks.has(key))
        throw new Error('No taks with key "'+key+'" is defined.');
    return this._state.tasks.get(key);
};

_isExpectedAnswer
_getCallbackMethod
_unsetExpectedAnswer

// will reset the timer
// the task can itself reset it's timer and timeouts(??) (i.e. in it's callbacks)
// thus, concrete implementations can react very precisely on their
// inividual requirements
task.activate()

Hmm, what I dislike, is that this is meant to completely re-activate
a task by the step, the task can't reactivate itself directly.
Also, how to keep timers running when the process is not managed?
-> the process manager could keep processes with timeouts around
-> or at least keep the actual timeouts around
That also means, that process manager would probably have to load
all **unfinished** processes when itself is (re-)started and maybe handle
some timeouts right away.


// the task stays pending. but there's a user interface that allows to
// re-activate the task (until we're out of reactivations)
softTimeout
// the task is re-activated, when we're out of reactivations the task
// is shut down as FAILED
hardTimeout
// number of allowed calls to activate re-activate a task
// this is without the initial activate, which can't be turned off.
reactivations// (= retries)

// what are we going to execute here???
// => callbackFailedUI: This is only OK when we're expecting it
//                      and we only expect it when:
//                      this.isFailing && !this.isFinished
//                      also, to net receive this from an outdated expectation
//                      we're going to have to check the callbackTicket on this
// => callbackReactivateTask(taskKey): This is kind of always OK (????)
//                      when !this.isFinished The user can decide to restart
//                      a task because it appears to be stalling -> maybe we
//                      should implement the hard/soft timeout idea
_p._execute = function(actionMessage) {
    var callbackTicket = actionMessage.getCallbackTicket()
      , [callbackName, ticket] = callbackTicket
      , payload = actionMessage.getPayload()
      , data, callbackMethod
      , expected = this._isExpectedAnswer(callbackTicket)
      ;
    if(!expected)
        throw new Error('Action for "' + callbackName + '" with ticket "'
                                    + ticket + '" is not expected.');
    data = JSON.parse(payload);
    callbackMethod = this._getCallbackMethod(callbackName);
    TODO;// we need to establish a back channel here, that goes directly to
    // the user interacting, if present! ...
    // Everything else will be communicated via the changes-feed of
    // the process. Back channel likely means there's an answer message
    // for the execute function.
    this._unsetExpectedAnswer();
    FIXME;// make sure that a failed callbackMethod
    // creates appropriate error handling, such as failing and ending the
    // step.
    // So what is the state/are the conditions that make this step go FUBAR?
    try {
        return Promise.resolve(callbackMethod.call(this, data));
    }
    catch(error) {
        return Promise.reject(error);
    }
};

/**
 * Validate and perform `actionMessage`;
 * This (and activate) changes process state.
 */
_p.execute = function(targetPath, actionMessage) {
    // The next to self-checks are to verify the
    // parent process is behaving as expected.
    if(!this.isActivated)
        throw new Error('Step is not activated.');
    if(this.isFinished)
        throw new Error('Step is finished, no changes are possible anymore.');
    return (!targetPath.task
                // an action aimed at this step directly
                ? this._execute(actionMessage)
                // If this task is present (and the step is active) it can always
                // be executed.
                : this._getTask(targetPath.task).execute(actionMessage)
    ).then(()=>this._transition());
};
