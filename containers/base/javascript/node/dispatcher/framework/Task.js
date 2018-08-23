"use strict";
/* jshint esnext:true, node:true*/


FIXME;// REASSES if this will work AND plan the next steps!

const PENDING = 'PENDING'
  , OK = 'OK'
  , FAILED = 'FAILED'
  , LOG = 'LOG'
  , statusItems = new Map(Object.entries({PENDING, OK, FAILED, LOG}))
  ;

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
      , created: this.created.toISOString()
      , data: this.data
    };
};

/**
 * Just a factory function.
 */
TaskStatus.deserialize = function(state) {
    var {
            statusString
          , details
          , created: createdString
          , data
        } = state;
    // stateString :must exist, check in here for a better error message
    if(!statusItems.has(statusString))
        throw new Error('state.status is not a statusItems key: "'+statusString+'"');

    return new TaskStatus(
        statusItems.get(statusString)
      , details
      , new Date(createdString)
      , data
    );
};

return TaskStatus;
})();

function Task(state, step) {
    this._step = step;
    this._state = null;
    if(state)
        this._loadState(state);
    else
        this._initState();
}

const _p = Task.prototype;

_p._finishingStatuses = new Set([OK, FAILED]);

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

// FIXME: deserialize is data from external, so it should check
//        that it's `serialized` argument is valid (otherwise it can't be
//        deserialized in a meaningful way???)
// do we also need a validate method for the deserialized data? everywhere
// where data can be written it should be checked if it is valid (!?).
//
// in this example: history must have at least one entry! That's not checked yet.
//
const expectedKeys = {
    created: { // date
        init: () => new Date()
      , serialize: data => data.toISOString()
      , deserialize: serialized => new Date(serialized)
    }
  , history: {// array of valid taskStatus entries, min len = 1 (see _initState)
        init: ()=>[new TaskStatus(PENDING, '*initial state*')]
      , serialize: data=>data.map(taskStatus=>taskStatus.serialize())
      , deserialize: serialized=>serialized.map(TaskStatus.deserialize)
    }
  // Can save some internal state data to the database, so that it can
  // validate, keep, and follow its internal state.
  , private: {
        init: ()=>null//empty
      , serialize: data=>data
      , deserialize: serialized=>serialized
    }
};

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
            throw new Error('KeyError "'+key+'" is not set.');
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

_p._initState = function() {
    this._state = {};
    for(let [key, definition] of expectedKeys)
        this._state[key] = definition.init();
};

/**
 * Implement in sub class. Is called when the step becomes active.
 * This is Basically the initialization of the tasks business logic.
 */
_p._activate = function() {
    throw new Error('Not implemented `_activate`.');
};

_p.activate = function() {
    this._setStatus(PENDING, '*activating*');
    // reset
    this._state.private = null;
    var promise;
    try {
        // may return a promise but is not necessary
        // Promise.resolve will fail if task.activate returns a failing promise.
        promise = Promise.resolve(this._activate());
    }
    catch(error) {
        promise = Promise.reject(error);
    }
    return promise.then(null, error=>this._setStatus(
                FAILED, renderErrorAsMarkdown('Activation failed:', error)));
};

/**
 * This doesn't change the state.
 * In the history, the last status that is not a LOG is the status.
 */
_p._logStatus = function(markdown, data) {
    this._setStatus(LOG, markdown, data);
};

_p._setStatus = function(status, markdown, data){
    this._state.history.push(new TaskStatus(status, markdown, null, data));
};

_p._loadState = function(state) {
    // TODO: do we need more validation?
    // TODO: implement for real!
    var unknown, missing
      , receivedKeys = new Set(Object.keys(state))
      ;
    unknown = receivedKeys - expectedKeys;
    if(unknown.size)
        throw new Error("State has unknown keys: {unknown}");
    missing = expectedKeys - receivedKeys;
    if(missing.size)
        throw new Error("Keys are missing from state: {missing}");

    this._state = {};
    for(let [key, definition] of expectedKeys)
        this._state[key] = definition.deserialize(state[key]);
};

_p.serialize = function() {
    var state = {};
    for(let [key, definition] of expectedKeys)
        state[key] = definition.serialize(this._state[key]);
    return state;
};
