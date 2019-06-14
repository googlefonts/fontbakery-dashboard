"use strict";
/* jshint esnext:true, node:true*/

const {mixin: stateManagerMixin} = require('./stateManagerMixin')
    , {mixin: expectedAnswersMixin} = require('./expectedAnswersMixin')
    , {validTaskStatuses } = require('./Task')
    , {Status, OK, FAILED, PENDING} = require('./Status')
    , {Path} = require('./Path')
    , { ProtobufAnyHandler } = require('../../util/ProtobufAnyHandler')
    ;

/**
 * If all Tasks are OK the Step will automatically finish with a status
 * of OK.
 * If there are FAILED tasks:
 *      - The task itself can/will offer a UI to re-run/re-try/re-activate it.
 *      - the step can be finished manually using its own UI (uiHandleFailedStep)
 * Once a step is finished, the Process can proceed to the next step or
 * run it's procedures to finish itself.
 *
 * Nice to have stuff that is *not* yet implemented:
 *
 * hard and soft timeouts: could maybe also be done in the tasks at least
 *     tasks need to be able to reset timeouts depending on their implementation
 *     and current progress (i.e. in the callbacks).
 *     This requires ideally some kind of gRPC based cron-service.
 *     * soft: after the timeout offer a UI to retry or set the FAILED
 *             status without interaction otherwise: just keep waiting
 *     * hard: set the FAILED status
 */
function Step(process, state, taskCtors, anySetup, {label=this.constructor.name}={}) {
    // expectedAnswersMixin can extract a pbMessage from a commandMessage
    // in _executeExpectedAnswer, but the concrete implementation must
    // define the message Classes and namespace.
    var anySetup_ = anySetup
            ? anySetup
            : {
                knownTypes: {}
              , typesNamespace: '(no namespace)'
              };
    this._any = new ProtobufAnyHandler(process.log, anySetup_.knownTypes, anySetup_.typesNamespace);
    Object.defineProperties(this, {
        process: {value: process}
        // needed by expectedAnswersMixin
      , secret: {value: process.secret}
      , log: {value: process.log}
      , label: {value: label}
    });

    // taskCtors must be an object of {taskName: TaskConstructor}
    this._taskCtors = new Map(Object.entries(taskCtors));
    this._state = null;
    // local cache for a reversed this._state.tasks map
    this._reverseTasks = null;
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

_p._initTasks = function() {
    var tasks = new Map();
    for(let [key, TaskCtor] of this._taskCtors)
       tasks.set(key, new TaskCtor(this, null));
    return tasks;
};

_p._loadTasks = function(tasksState) {
        // array of [[key, serializedState], [key, serializedState], ...]
    var tasksStateMap = new Map(tasksState);
    if(this._taskCtors.size !== tasksStateMap.size)
        throw new Error('Incompatible tasksState expected ' + this._taskCtors.size
                + ' entries but received ' + tasksStateMap.size
                +' (# of unique keys).');

    var tasks = new Map();
    for(let [key, TaskCtor] of this._taskCtors) {
        if(!tasksStateMap.has(key))
            throw new Error('Incompatible tasksState: entry for '
                                        + 'key "' + key + '" is missing.');
        tasks.set(key, new TaskCtor(this, tasksStateMap.get(key)));
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
  , pathPart: {
        get: function() {
            return  this.process.getStepPath(this);
        }
    }
    // building this on request, because process.id may not be
    // initially available.
  , path: {
        get: function() {
            return new Path(...this.process.path, this.pathPart);
        }
    }
});

const stateDefinition = {
    tasks: { // array, task statuses, must be compatible with this._taskCtors
        init: _p._initTasks
      , serialize: (tasks, options)=>
                    [...tasks].map(([key, task])=>[key, task.serialize(options)])
      , load: _p._loadTasks
      // always expected
    }
  , isActivated: { // boolean
        init: ()=>false
      , serialize: val=>val
      , load: val=>val
    }
  , finishedStatus: {
        init: ()=>null
      , serialize: status=>status === null ? null : status.serialize()
      , load: data=>data === null ? null : Status.load(data)
    }
    // rejection reason
    // status: PENDING, PASS, FAIL
    // but this status comes basically directly from the tasks status
    // so maybe we can calculate this and don't put into the DB
    // depends whether we need to query the step state at this level.
};

stateManagerMixin(_p, stateDefinition);

const _stateManagerSerialize = _p.serialize;
_p.serialize = function(options) {
    var data = _stateManagerSerialize.call(this, options);
    if(options && options.augment && options.augment.has('STEP.LABEL'))
        data['augmented:label'] = this.label;
    return data;
};

_p.uiHandleFailedStep = function(){
    return {
        roles: ['input-provider', 'engineer']
      , ui: [
            {   name: 'reason'
              , type: 'line' // input type:text
              , label: 'What is your reasoning?'
            }
          , {
                type: 'send'
              , text: 'Let this step fail.'
            }
        ]
    };
};

_p.callbackHandleFailedStep = function([requester, sessionID], values, ...continuationArgs) {
    //jshint unused:vars
    var { reason } = values;
    this._finishedFAILED('Failing with reason: ' + reason);
};

_p.getRequestedUserInteractions = function() {
    var results = [];
    if(this.isFinished)
        return results;

    if(this.hasRequestedUserInteraction)
        results.push(this);

    for(let task of this._state.tasks.values())
        if(task.hasRequestedUserInteraction)
            results.push(task);
    return results;
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
    for(let task of this._state.tasks.values()){
        this.log.debug('task activate', task);
        // these never raise, Task.prototype.activate catches exceptions
        // and puts them into rejected promises
        promises.push(task.activate());
    }
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

        // *IMPORTANT!* Currently, a step has only one possible
        // _setExpectedAnswer and that is set here.
        if(!this._hasRequestedUserInteraction())// no need to re-request it
            this._setExpectedAnswer('Failed Step'
                                 // this must call this _finishedFAILED
                                 , 'callbackHandleFailedStep'
                                 , 'uiHandleFailedStep');
        return;
    }
    // no FAILED, this is any case we don't need the FailedUI anymore.
    this._unsetExpectedAnswer();

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

_p.getTaskPath = function(task) {
    var path;
    if(this._reverseTasks === null)
        this._reverseTasks = new Map(
                [...this._state.tasks].map(([path, task])=>[task,path]));

    path = this._reverseTasks.get(task);
    if(path)
        return path;

    throw new Error('Task  "' + task + '" not found.');
};

function renderErrorAsMarkdown(message, error){
    return '## *ERROR* ' + error.name + '\n'
          + message + '\n'
          + '```\n' + error.stack + '\n```';
}

_p._handleStateChange = function(methodName, stateChangePromise) {
    // We only have callbackHandleFailedStep right now!
    // do this._finishedFAILED, as callbackHandleFailedStep seems incapable
    // of doing so.
    return stateChangePromise
        .then(null, error=>this._finishedFAILED(renderErrorAsMarkdown(
                    'Method: ' + methodName + ' failed', error)));
};

/**
 * Validate and perform `commandMessage`;
 * This (and activate) changes process state.
 */
_p.execute = function(targetPath, commandMessage) {
    // The next to self-checks are to verify the
    // parent process is behaving as expected.
    if(!this.isActivated)
        throw new Error('Step is not activated.');
    if(this.isFinished)
        throw new Error('Step is finished, no changes are possible anymore.');
    return (!targetPath.task
                // an action aimed at this step directly
                ? this._executeExpectedAnswer(commandMessage)
                // If this task is present (and the step is active) it can always
                // be executed.
                : this._getTask(targetPath.task).execute(targetPath, commandMessage)
    ).then((result)=>{this._transition(); return result;});
};
