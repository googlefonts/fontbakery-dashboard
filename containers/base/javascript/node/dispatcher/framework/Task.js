"use strict";
/* jshint esnext:true, node:true*/

const {mixin: stateManagerMixin} = require('stateManagerMixin')
  , crypto = require('crypto')
  , {Status, PENDING, OK, FAILED, LOG} = require('./Status')
  ;

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

    // CAUTION: these are the ones that are allowed to be returned by
    // task.status. **Don't just change this**  it needs a careful review
    // of all the code using Tasks.
const validTaskStatuses = new Set([PENDING, OK, FAILED])
  , finishingStatuses = new Set([OK, FAILED])
  ;

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
                if(taskStatus.status === LOG)
                    continue;
                if(!validTaskStatuses.has(taskStatus))
                    // Other code depends on the task status to be one
                    // of OK, FAILED, PENDING at any time.
                    throw new Error('Task status "'+taskStatus+'" is not allowed.');
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
  , _secret: {
        get: function() {
            FIXME;
            throw new Error('Not implemented "_secret".');
        }
    }
  , _callbackTicket: {
        get: function() {
            if(!this._hasExpectedAnswer)
                return null;
            return this._state.expectedAnswer.slice(0,2);
        }
    }
  , requestedUserInteraction: {
        get: function() {
            if(!this._hasRequestedUserInteraction)
                return null;
            // => [requestedUserInteractionName, callbackTicket]
            return [
                this._state.expectedAnswer[2]
              , this._callbackTicket
            ];
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
    return [new Status(PENDING, '*initial state*')];
};

_p._hash = function(...data) {
    var hash = crypto.createHash('sha256');
    for(let str of data)
        hash.update(str);
    return hash.digest('hex');
};

/**
 * A hash for ticket only makes sense if it includes the callbackName,
 * a unique/random number or maybe the date, a secret
 * The secret should not accessible with database access,
 * so, "unauthorized" database access cannot enable to make any callback
 * expected.
 * The secret must not be in the git repo, otherwise it's not a secret!
 */
_p._getTicket = function (callbackName, dateString/*don't use for new tickets*/) {
    var date = dateString || new Date().toISOString()
      , hash = this._hash(date, callbackName, this._secret)
      ;
    return [date, hash].join(';');
};

/**
 * Must be either null or an 3 item array:
 *          [callbackName, ticket, requestedUserInteractionName]
 * If an array the second entry is the ticket, if somehow
 * "signed"/"salted" with a "secret" could be validated as well.
 * I.e. if the secret changes, the loaded state would then then be invalid …
 */
_p._validateExpectedAnswer = function(expectedAnswer) {
    if(expectedAnswer === null)
        return [true, null];
    var [callbackName, ticket, requestedUserInteractionName] = expectedAnswer;

    if(!this._getCallbackMethod(callbackName))
        return [false, 'Callback "' + callbackName + '" is not defined.'];

    let dateString = ticket.split(';')[0];
    if(ticket !== this._getTicket(callbackName, dateString))
        return [false, 'Ticket is invalid.'];

    if(requestedUserInteractionName !== null
                && !this._hasUserInteraction(requestedUserInteractionName))
        return [false, 'Requested user Interaction "'
                    + requestedUserInteractionName + '" is not defined.'];

    return [true, null];
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
  , expectedAnswer: {
        init: ()=>null//empty
      , serialize: state=>state
      , load: state=>state
      , validate: _p._validateExpectedAnswer
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
 * The task must have a thread from here to it's end, which is a
 * finishing status: either OK or FAIL
 *
 * Returns a promise.
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
 *
 * This needs to be put into _state, so we can serialize it!
 */
_p._setExpectedAnswer = function(waitingFor, callbackName, requestedUserInteractionName) {
    this._setPENDING('Waiting for ' + waitingFor);
    var ticket = this._getTicket(callbackName)
      , expectedAnswer = [callbackName, ticket
                                , requestedUserInteractionName || null]
      , [result, message] = this._validateExpectedAnswer(expectedAnswer)
      ;
    if(!result)
        throw new Error('expectedAnswer is invalid: ' + message);
    this._state.expectedAnswer = expectedAnswer;
    return this._callbackTicket;
};

_p._hasExpectedAnswer = function() {
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

/**
 * Don't use directly in a Task implementation!
 * Use `_requestUserInteraction` instead.
 */
_p._hasRequestedUserInteraction = function() {
    return this._hasExpectedAnswer() && this._state.expectedAnswer[2] !== null;
};

/**
 * As a convention, callbackName and thus the method name
 * must start with "callback"
 */
_p._getCallbackMethod = function(callbackName) {
    return (callbackName.indexOf('callback') !== 0 && this[callbackName])
            ? this[callbackName]
            : null
            ;
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

/**
 * actionMessage.callbackTicket: To verify a answer comes from the actual
 * request that was dispatched, ticket is a unique, "signed" string stored
 * here We're round tripping it  from dispatched request back to here.
 * A ticket is only valid once. If we need more answers for the same
 * callback, it would be good to make the this._state.expectedAnswer[1]
 * value a set of allowed tickets and have _setExpectedAnswer be called
 * with a number indicating the count of expected answers. But we need a
 * good use case for it first, because it's more complicated to get it right.
 * I.e. we may run into race conditions or otherwise conflicting states
 * when there are parallel expected answers. It's much better to
 * implement concurrency using the step-task model.
 *
 * A requested user interaction callbackMethod must be able to reject
 * an answer and provide hints to the user abut what went wrong,
 * i.e. if there's some validation
 * issue. In that case, we **don't** keep expected answer and
 * request user interaction around for re-use. Instead, the callbackMethod
 * should be like a "monkey form" implementation, calling itself explicitly
 * (via _setExpectedAnswer) until all requirements are met. Then, also,
 * only one client can answer to one expected answer, resolving the
 * race directly here, even before the `callbackMethod` could go async
 * or so.
 */
_p.execute = function(actionMessage) {
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
    return this._runStateChangingMethod(callbackMethod, data);
};

_p._setStatus = function(status, markdown, data) {
    this._state.history.push(new Status(status, markdown, null, data));
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

