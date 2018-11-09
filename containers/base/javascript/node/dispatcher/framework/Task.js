"use strict";
/* jshint esnext:true, node:true*/

const {mixin: stateManagerMixin} = require('./stateManagerMixin')
  , {mixin: expectedAnswersMixin} = require('./expectedAnswersMixin')
  , {Status, PENDING, OK, FAILED, LOG} = require('./Status')
  , {Path} = require('./Path')
  , { ProtobufAnyHandler } = require('../../util/ProtobufAnyHandler')
  ;

    // CAUTION: these are the ones that are allowed to be returned by
    // task.status. **Don't just change this**  it needs a careful review
    // of all the code using Tasks.
const validTaskStatuses = new Set([PENDING, OK, FAILED])
  , finishingStatuses = new Set([OK, FAILED])
  ;
exports.validTaskStatuses = validTaskStatuses;
exports.finishingStatuses = finishingStatuses;

function Task(step, state, anySetup) {
    // expectedAnswersMixin can extract a pbMessage from a commandMessage
    // in _executeExpectedAnswer, but the concrete implementation must
    // define the message Classes and namespace.
    var anySetup_ = anySetup
            ? anySetup
            : {
                knownTypes: {}
              , typesNamespace: '(no namespace)'
              };
    this._any = new ProtobufAnyHandler(anySetup_.knownTypes, anySetup_.typesNamespace);
    Object.defineProperties(this, {
        step: {value: step}
        // needed by expectedAnswersMixin
      , secret: {value: step.secret}
      , log: {value: step.log}
    });

    this._state = null;
    if(state === null)
        // make a new task, i.e. without having any existing state.
        this._initState();
    else
        // may fail!
        this._loadState(state);
}

exports.Task = Task;
const _p = Task.prototype;

expectedAnswersMixin(_p);

// do this?
Object.defineProperties(_p, {
    process: {
        get: function() {
            return this.step.process;
        }
    }
  , created: {
        get: function() {
            return this._state.created;
        }
    }
  , taskStatus: {
        get: function() {
            for(let i=this._state.history.length-1;i>=0;i--) {
                let taskStatus = this._state.history[i];
                // LOG doesn't change the status of the task
                if(taskStatus.status === LOG)
                    continue;
                if(!validTaskStatuses.has(taskStatus.status))
                    // Other code depends on the task status to be one
                    // of OK, FAILED, PENDING at any time.
                    throw new Error('Task status "'+taskStatus.status+'" is not allowed.');
                return taskStatus;
            }
            // This should never happen, it's more like a self-health-test.
            // On init we always set: PENDING, '*initial state*'
            throw new Error('Task has no status.');
        }
    }
  , status: {
        get: function() {
            return this.taskStatus.status;
        }
    }
  , isFailed: {
        get: function() {
            return this.status === FAILED;
        }
    }
  , finshed: {
        get: function() {
            return this._finishngStatuses.has(this.status);
        }
    }

  , pathPart: {
        get: function(){
            return  this.step.getTaskPath(this);
        }
    }
    // building this on request, because process.id may not be
    // initially available.
  , path: {
        get: function() {
            return new Path(...this.step.path, this.pathPart);
        }
    }

});

/**
 * NOTE: after init we have a PENDING status but NO ExpectedAnswer
 * that's an exception, and the `this.activate` method is used to actually
 * start the task.
 * Then, via `this.activate` or `this.execute` `this._runStateChangingMethod`
 * is executed and an expectedAnswer must be defined if the status is PENDING.
 */
_p._initHistory = function() {
    console.log('Task', this, '_initHistory');
    return [new Status(PENDING, '*initial state*')];
};

// TODO: More this._state validation
// load takes data from external, so it should check
//        that it's `state` argument is valid (otherwise it can't be
//        deserialized/loaded in a meaningful way???)
// do we also need a validate method for the deserialized data? everywhere
// where data can be written it should be checked if it is valid (!?).
//
// in this example: history must have at least one entry! That's not checked yet.
//
const stateDefinition = {
    created: {
        // date is a pseudo types in rethink db, so this is an identity field
        // could add some validation though...
        init: ()=>new Date()
      , serialize: date=>date
      , load: date=>date
      , validate: date=>{
            if(!(date instanceof Date))
                return [false, ''];
            if(isNaN(date.getTime()))
                return [false, 'Date "'+date+'" is invalid (getTime=>NaN).'];
            return [true, null];
        }
    }
  , history: {// array of valid taskStatus entries, min len = 1 (see _initState)
        init: _p._initHistory
      , serialize: history=>history.map(taskStatus=>taskStatus.serialize())
      , load: historyStates=>historyStates.map(Status.load)
    }
  // Can save some internal state data to the database, so that it can
  // validate, keep, and follow its internal state.
  // this must all somehow go into the rethinkDB database, so stick
  // to its native data types (i.e. JSON compatible + pseudo types like
  // Dates. See: https://rethinkdb.com/docs/data-types/)!
  , private: {
        init: ()=>null//empty
      , serialize: state=>state
      , load: state=>state
    }
};

stateManagerMixin(_p, stateDefinition);

_p._setSharedData = function(key, value) {
    this.process.setSharedData(key, value);
};

_p._hasSharedData = function(key) {
    return this.process.hasSharedData(key);
};

_p._getSharedData = function(key, ...args) {
    return this.process.getSharedData(key, ...args);
};

_p._deleteSharedData = function(key) {
    return this.process.deleteSharedData(key);
};

_p._setPrivateData = function(key, value) {
    if(this._state.private === null)
        this._state.private = {};
    this._state.private[key] = value;
};

_p._getPrivateData = function(key, ...args) {
    var hasFallback = args.length
      , fallback = hasFallback ? args[0] : undefined
      ;
    if(!this._hasPrivateData(key)) {
        if(hasFallback)
            return fallback;
        else
            throw new Error('KeyError "' + key + '" is not set.');
    }
    return this._state.private[key];
};

_p._hasPrivateData = function(key) {
    return (this._state.private !== null && this._state.private.hasOwnProperty(key));
};

_p._deletePrivateData = function(key) {
    if(this._hasPrivateData(key))
        delete this._state.private[key];

    if(this._state.private !== null && !Object.keys(this._state.private).length)
        // reset
        this._state.private = null;

    return true;
};

/**
 * Implement in sub class. Is called when the step becomes active.
 * This is Basically the initialization of the tasks business logic.
 */
_p._activate = function() {
    throw new Error('Not implemented `_activate`.');
};

_p._reActivate = function() {
    // reset
    this._setLOG('*activate*');
    this._state.private = null;
    this._unsetExpectedAnswer();
    // activate
    return this._activate();
};

/**
 * This is called when the Step is activated.
 * The task must have a thread from here to it's end, which is a
 * finishing status: either OK or FAIL
 *
 * Returns a promise.
 */
_p.activate = function() {
    // just a wrapper, unlike callbackReActivate this is not
    // executed from within _runStateChangingMethod, thus it
    // has to be done explicitly
    return this._runStateChangingMethod(this._reActivate, 'activate');
};

_p.callbackReActivate = function(data) {
    //jshint unused:vars
    // This is executed from within _runStateChangingMethod via execute...
    // validate data ??? what data do we expect here, seems to me that
    // his can be just `null` in this case
    return this._reActivate();
};


/**
 * A task can only expect one answer at any time, to keep it simple.
 * We may change this if there's a good use case.
 *
 * This needs to be put into _state, so we can serialize it!
 */
_p._setExpectedAnswer = function(waitingFor
                               , callbackName
                               , requestedUserInteractionName
                               , setPending /*optional, default: true*/) {
    if(setPending === undefined || setPending)
        // in _failedAction we explicitly don't want to set PENDING
        // and instead keep the FAILED status. reActivate will set PENDING
        // when callbackReActivate is executed via uiRetry
        this._setPENDING('Waiting for ' + waitingFor);
    return this.__setExpectedAnswer(waitingFor, callbackName, requestedUserInteractionName);
};

function renderErrorAsMarkdown(message, error){
    return '**NOT IMPLEMENTED** (renderErrorAsMarkdown) ' + message + ' ```\n' + error + '\n```';
}

_p._handleStateChange = function(methodName, stateChangePromise) {
    return stateChangePromise.then(()=>{
        // a self check ...
        var status = this.status;
        if(finishingStatuses.has(status))
            // all good, it's done
            return;
        // if not in a finished state now, we need to be in PENDING
        if(status !== PENDING)
            throw new Error('Status is not finished, thus, it must be '
                + 'PENDING, but it is ' + status + '.');
        // AND an expectedAnswer must be defined, otherwise, there's
        // no way the task can ever finish! (we lost the thread)
        if(!this._hasExpectedAnswer())
            throw new Error('Lost the thread: the task has not defined '
                                            + 'an expected answer.');
    })
    .then(null, error=> {
            this.log.error('State change failed:',error);
            this._setFAILED(renderErrorAsMarkdown(
                            'Method: ' + methodName + ' failed:', error))
        }
    )
    .then(()=>{
        if(!this.isFailed)
            return;
        return this._failedAction();
    });
};

_p.uiRetry = function (){
    return [
        {
            type: 'send' // a button (does't have to be a <button>) that sends the form.
          , label: 'Restart Task:'
          , text: 'Try again!'
          //, value: null // null is the default
        }

    ];
};

_p._failedAction = function() {
    // Maybe: if(!this._useRetryUI) return;
    // though, a sub-class could also just re-implement this method
    // this interface would just sit there, it doesn't have to be used
    // but if there's a good reason to restart a task, it can be used.
    this._setExpectedAnswer('Retry UI'
                           , 'callbackReActivate'
                           , 'uiRetry'
                           , false);
};

_p._setStatus = function(status, markdown, data) {
    this._state.history.push(new Status(status, markdown, null, data));
};

// These are helpers to use _setStatus, so a subclass doesn't need to
// import the status items.


/**
 * Right now this is basically an alias of this._executeExpectedAnswer
 * defined in expectedAnswersMixin, but maybe, as a public interface we'll
 * have to modify it. Also, not using targetPath at the moment.
 */
_p.execute = function(targetPath, commandMessage) {
    //jshint unused:vars
    return this._executeExpectedAnswer(commandMessage);
};

/**
 * This doesn't change the state.
 * In the history, the last status that is not a LOG is the status.
 */
_p._setLOG = function(markdown, data) {
    return this._setStatus(LOG, markdown, data);
};

_p._setFAILED = function(markdown, data) {
    return this._setStatus(FAILED, markdown, data);
};

_p._setOK = function(markdown, data) {
    return this._setStatus(OK, markdown, data);
};

_p._setPENDING = function(markdown, data) {
    return this._setStatus(PENDING, markdown, data);
};

