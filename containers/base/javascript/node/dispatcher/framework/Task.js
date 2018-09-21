"use strict";
/* jshint esnext:true, node:true*/

const {mixin: stateManagerMixin} = require('stateManagerMixin');

/**
 * Making these items unique objects so it's very explicit what is meant.
 */
function StatusItem (status) {
    Object.defineProperty(this, 'status', {
        value: status
      , writable: false
      , enumerable: true
    });
}
StatusItem.prototype.valueOf = function() {
    return this.status;
};

const PENDING = new StatusItem('PENDING')
  , OK = new StatusItem('OK')
  , FAILED = new StatusItem('FAILED')
  , LOG = new StatusItem('LOG')
  , statusItems = new Map(Object.entries({PENDING, OK, FAILED, LOG}))
    // string2statusItem: statusItems.get(string) => statusItem
    //                    statusItems.get('FAILED') => FAILED
  , string2statusItem = string=>statusItems.get(string)
  , finishingStatuses = new Set([OK, FAILED])
  ;

exports.PENDING = PENDING;
exports.FAILED = FAILED;
exports.OK = OK;
exports.LOG = LOG;
exports.statusItems = statusItems;
exports.string2statusItem = string2statusItem;
exports.finishingStatuses = finishingStatuses;

const TaskStatus = (function() {
function TaskStatus(
            status/*status item*/
          , details/*string(markdown)*/
          , created/*Date: optional*/
          , data/* losslessly JSON serializable data: optional*/) {
    // FIXME: vaidate types!

    //must be an existing status item
    if(!statusItems.has(status.toString()))
        throw new Error('`status` "'+status+'" is unknown.');
    this.status = status;

    if(typeof details !== 'string')
        throw new Error('`details` "'+details+'" is not a string "'+(typeof details)+'".');
    this.details = details; // TODO: must be a string

    if(created) {
        // if present must be a valid date
        if(!(created instanceof Date))
            throw new Error('`created` is not an instance of Date "'+created+'".');
        if(isNaN(created.getDate()))
            throw new Error('`created` is an Invalid Date "'+created+'".');
        this.created = created;
    }
    else
        this.created = new Date();
    // for structured data in advanced situations
    this.data = data || null;
}

const _p = TaskStatus.prototype;

_p.serialize = function() {
    return {
        status: this.status.toString()
      , details: this.details
                // for use with rethinkDB this can just stay a Date
      , created: this.created //.toISOString()
      , data: this.data
    };
};

/**
 * Just a factory function.
 */
TaskStatus.load = function(state) {
    var {
            statusString
          , details
          , created
          , data
        } = state;
    // stateString :must exist, check in here for a better error message
    if(!statusItems.has(statusString))
        throw new Error('state.status is not a statusItems key: "'+statusString+'"');

    // rethinkdb can store and return dates as it
    if(typeof created === 'string')
        created = new Date(created);
    return new TaskStatus(
        statusItems.get(statusString)
      , details
      , created
      , data
    );
};

return TaskStatus;
})();

function Task(state, step) {
    this._step = step;
    this._state = null;
    if(state !== null)
        this._loadState(state);
    else
        this._initState();
}

const _p = Task.prototype;

// do this?
Object.defineProperties(_p, {
    step: {
        get: function() {
            return this._step;
        }
    }
  , process: {
        get: function() {
            return this._step.process;
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
                if(taskStatus.status !== LOG)
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
  , finshed: {
        get: function() {
            return this._finishngStatuses.has(this.status);
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
    return [new TaskStatus(PENDING, '*initial state*')];
};

// FIXME: load takes data from external, so it should check
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
        init: ()=>_p._initHistory
      , serialize: history=>history.map(taskStatus=>taskStatus.serialize())
      , load: historyStates=>historyStates.map(TaskStatus.load)
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
  , expectedAnswer: {
        init: ()=>null//empty
      , serialize: state=>state
      , load: state=>state
      // validate: ?? could be done...
      // must be either null or an 2 item array [callbackName, ticket]
      // if an array the second entry is the ticket, if somehow
      // "signed"/"salted" with a "secret" could be validated as well.
      // I.e. if the secret changes, the loaded state is then invalid …
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

/**
 * This is called when the Step is activated.
 * The task must have a thread from here to it's end, which is either
 * OK or FAIL
 *
 */
_p.activate = function() {
    // reset
    this._setLOG('*activate*');
    this._state.private = null;
    this._state.expectedAnswer = null;
    return this._runStateChangingMethod(this._activate);
};

/**
 * A task can only expect one answer at any time, to keep it simple.
 * We may change this if there's a good use case.
 * If expectedAnswer is already set, either use _unsetExpectedAnswer
 * or the `force` argument set to true to override.
 * This needs to be put into _state, so we can serialize it!
 */
_p._setExpectedAnswer = function(waitingFor, callbackName, force) {
    if(force)
        this._unsetExpectedAnswer();

    if(this._hasExpectedAnswer())
        throw new Error('Expected answer is already set: "'
                                    + this._state.expectedAnswer[0] +'".');

    this._setPENDING('Waiting for ' + waitingFor);

    // do we need some random string here? or a secret?
    // or a date signed with a secret?
    // If it's random or a salted hash, it will be harder to guess from
    // outside. What's the value of the salted hash?
    var ticket = TODO();
    this._state.expectedAnswer = [callbackName, ticket];
    //return a "defensive copy" of the array => callbackTicket
    return this._state.expectedAnswer.slice();
};

_p._hasExpectedAnswer = function(){
    return this._state.expectedAnswer !== null;
};

_p._unsetExpectedAnswer = function() {
    this._state.expectedAnswer = null;
};

/**
 * ticket would be a unique string stored in here
 */
_p._isExpectedAnswer = function([callbackName, ticket]) {
    return this._hasExpectedAnswer()
                    && this._state.expectedAnswer[0] === callbackName
                    && this._state.expectedAnswer[1] === ticket
                    ;
};

_p._setRequestedUserInteraction = function(userInteractionName, callbackTicket) {
    TODO;// the result of the user interaction should be
    // received like: this.execute(userInteractionResultMessage)
    // where: callbackTicket === actionMessage.getCallbackTicket()
    // this needs handling in ProcessManager (it needs to be aware of
    // all required user interactions and possibly about the authorization
    // situation.
    // Basically this must be detected and updated after each transition
    // or after resurrection.
    //
    // This is most probably propagated via the step of this task
    // so that only an active step will be able to request user interaction.
}

_p._requestUserInteraction = function(userInteractionName, callbackName) {
    var callbackTicket = this._setExpectedAnswer('user interaction', callbackName);
    return this._setRequestedUserInteraction(userInteractionName, callbackTicket);
};

_p._getCallbackMethod = function(callbackName) {
    //TODO?;
    return this[callbackName];
};

_p._runStateChangingMethod = function(method, ...args) {
    var promise;
    try {
        // may return a promise but is not necessary
        // Promise.resolve will also fail if method returns a failing promise.
        promise = Promise.resolve(method.call(this, ...args));
    }
    catch(error) {
        promise = Promise.reject(error);
    }

    return promise.then(()=>{
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
    .then(null, error=>this._setFAILED(renderErrorAsMarkdown(
                    'Method: ' + method.name + ' failed:', error)));
};

_p.execute = function(actionMessage) {
    var callbackTicket = actionMessage.getCallbackTicket()
      , [callbackName, ticket] = callbackTicket
        // *MAYBE* to verify the answer comes from the dispatched request
        // e.g. ticket would be a unique string stored here, for the
        // callback, roundtripping from dispatched request back to
        // here.
      , payload = actionMessage.getPayload()
      , data, callbackMethod
      , expected = this._isExpectedAnswer(callbackTicket)
      ;
    if(!expected)
        throw new Error('Action for "' + callbackName + '" with ticket "'
                                    + ticket + '" is not expected.');
    data = JSON.parse(payload);
    callbackMethod = this._getCallbackMethod(callbackName);
    // A ticket is only valid once. If we need more answers for the same
    // callback, it would be good to make the this._state.expectedAnswer[1]
    // value a set of allowed tickets and have _setExpectedAnswer be called
    // with a number indicating the count of expected answers.
    // But we need a good use case for it first.
    this._unsetExpectedAnswer();
    return this._runStateChangingMethod(callbackMethod, data);
};

_p._setStatus = function(status, markdown, data){
    this._state.history.push(new TaskStatus(status, markdown, null, data));
};

// These are helpers to use _setStatus, so a subclass doesn't need to
// import the status items.

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

