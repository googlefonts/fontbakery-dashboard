"use strict";
/* jshint esnext:true, node:true*/

const {mixin: stateManagerMixin} = require('./stateManagerMixin')
    , {expectedAnswersMixin} = require('./expectedAnswersMixin')
    , {validTaskStatuses } = require('./Task')
    , {Status, OK, FAILED, PENDING} = require('./Status')
    ;


/**
 *
 * Nice to have stuff that is *not* yet implemented:
 *
 * hard and soft timeouts
 *
 */
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

exports.Step = Step;
const _p = Step.prototype;

expectedAnswersMixin(_p);

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
//
// NOTE: re-activation/timeouts could be nicely implemented within task
// (needs a cron-service though) but there's no reason why a failed or timed
// out task shouldn't itself decide to call this.activate within it's own
// callback. A task can be failed AND at the same time request an UI to
// re-activate...

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
      , set: function(val){
            this._state.isActivated = !!val; //make it a bool always
        }
    }
    // If there's at least one failed process technically the step is already
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
                if(task.isFailed)
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
  , expectedAnswer: {
        init: ()=>null//empty
      , serialize: state=>state
      , load: state=>state
      , validate: _p._validateExpectedAnswer
    }
};

stateManagerMixin(_p, stateDefinition);


TODO;// def uiHandleFailedStep
TODO;// _p.callbackHandleFailedStep { this._finishedFAILED('md reason')}

_p.getRequestedUserInteractions = function() {
    var tasks = []
      , step = this.requestedUserInteraction // null if there is none
      ;
    if(this.isFinished)
        return [null, null];

    for(let [key, task] of this._state.tasks) {
        let rui = task.requestedUserInteraction;
        if(!rui) // null if there is none
            continue;
        tasks.push([key, rui]);
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
    // Don't allow reactivation, which, however should be equivalent
    // to re-activating all tasks.
    if(this.isActivated)
        // Expect caller to check this.
        throw new Error('Step is already activated.');
    this.isActivated = true;
    var promises = [];
    for(let task of this._state.tasks.values())
        // these never raise, Task.prototype.activate catches exceptions
        // and puts them into rejected promises
        promises.push(task.activate());
    // Using reflectPromise because we don't want to have Promise.all
    // fail directly, instead wait for all promises to be finished,
    // regardless of being resolved or rejected. `task.activate()` does
    // the error handling for us already and this._transition processes
    // the step status and handles failed tasks.
    return Promise.all(promises.map(reflectPromise))
                  .then((/*results*/)=>this._transition());
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
        // autofail(?): if(!this._useFailStepUI) {
        //            // only after all tasks are finished?
        //            this _finishedFAILED();
        //            return;
        //        }

        // Until the step.isFinished, it will be possible to receive
        // further pending answers for tasks expecting them.
        // But once it's finished, the answers won't be processed anymore.
        // So, in this case, the user could also just wait until all
        // tasks have a finishing status (FAILED or OK) and then decide
        // whether to re-run any tasks or execute the uiHandleFailedStep
        // and finish the step for good.

        // currently, a step has only one possible _setExpectedAnswer
        // and that is set here.

        if(!this._hasRequestedUserInteraction())// no need to re-request it
            this._setExpectedAnswer('Failed Step'
                                 // this must call this _finishedFAILED
                                 , 'callbackHandleFailedStep'
                                 , 'uiHandleFailedStep');
        return;
    }
    // no FAILED, this is any case we don't need the FailedUI anymore.
    this.this._unsetExpectedAnswer();

    var okCounter = 0;
    for(let task of this._state.tasks.values()) {
        if(task.status === PENDING) {
            // No FAILED but still some PENDING tasks.
            // Just wait.
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

    // This should never happen! investigate! task.status should also
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

_p._handleStateChange = function(methodName, stateChangePromise) {
    // We only have callbackHandleFailedStep right now!
    // do this._finishedFAILED, as callbackHandleFailedStep seems incapable
    // of doing so.
    return stateChangePromise
        .then(null, error=>this._finishedFAILED(renderErrorAsMarkdown(
                    'Method: ' + methodName + ' failed:', error)));
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
                ? this._executeExpectedAnswer(actionMessage)
                // If this task is present (and the step is active) it can always
                // be executed.
                : this._getTask(targetPath.task).execute(targetPath, actionMessage)
    ).then(()=>this._transition());
};
