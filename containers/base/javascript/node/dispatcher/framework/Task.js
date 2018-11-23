"use strict";
/* jshint esnext:true, node:true*/


FIXME;// REASSES if this will work AND plan the next steps!

const PENDING = 'PENDING'
  , OK = 'OK'
  , FAILED = 'FAILED'
  , LOG = 'LOG'
  , statusItems = new Map(Object.entries({PENDING, OK, FAILED, LOG}))
  ;

const TaskState = (function() {
function TaskState(
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

const _p = TaskState.prototype;

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
TaskState.deserialize = function(state) {
    var {
            statusString
          , details
          , created: createdString
          , data
        } = state;
    // stateString :must exist, check in here for a better error message
    if(!statusItems.has(statusString))
        throw new Error('state.status is not a statusItems key: "'+statusString+'"');

    return new TaskState(
        statusItems.get(statusString)
      , details
      , new Date(createdString)
      , data
    );
};

return TaskState;
})();

function Task(state, step) {
    this.parent = step;
    this._state = null;
    if(state)
        this._loadState(state);
    else
        this._initState();
}

const _p = Task.prototype;

// do this?
Object.defineProperties(_p, {
    created: {
        get: function() {
            return this._state.created;
        }
    }
  , taskState: {
        get: function() {
            for(let i=this._state.history.length-1;i>=0;i--) {
                let taskState = this._state.history[i];
                // LOG doesn't change the status of the task
                if(taskState.status !== LOG)
                    return taskState;
            }
            // This should never happen, it's more like a self-health-test.
            // On init we always set: PENDING, '*initial state*'
            throw new Error('Task has no status.');
        }
    }
  , status: {
        get: function() {
            return this.taskState.status;
        }
    }
  , finshed: {
        get: function() {
            return new Set([OK, FAILED]).has(this.status);
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
  , history: {// array of valid taskState entries, min len = 1 (see _initState)
        init: ()=>[new TaskState(PENDING, '*initial state*')]
      , serialize: data=>data.map(taskState=>taskState.serialize())
      , deserialize: serialized=>serialized.map(TaskState.deserialize)
    }
  // can save some internal state data to the database, so that it can validate
  // and follow its internal state.
  , private: {
        init: ()=>null//empty
      , serialize: data=>data
      , deserialize: serialized=>serialized
    }
};

_p._setSharedState = function(name, value) {
    TODO;// state shared with the  whole process
    // this should be persistant IMO, especially the familyData message
    // is important for e.g. forensics (only if we didn't do the PR …=
    // maybe we need to define life time management, or just get a huge disk)
    // If a new PR for the same family was created the old Process data could
    // be deleted... but in general, just keeping it around is probably more
    // straight forward just now and much less effort.
    // When we save these as files, we should have a MIME type of information
    // so _getSharedState can figure how to interprete/use the data
    throw new Error('Not implemented!');
};

_p._getSharedState = function(name, ...args) {
    TODO;//see, _setSharedState
    throw new Error('Not implemented!');
};

_p._setPrivateState = function(key, value) {
    if(this._state.private === null)
        this._state.private = {};
    this._state.private[key] = value;
};

_p._getPrivateState = function(key, ...args) {
    var hasFallback = args.length
      , fallback = hasFallback ? args[0] : undefined
      ;
    if(!this._hasPrivateState(key)) {
        if(hasFallback)
            return fallback;
        else
            throw new Error('KeyError "'+key+'" is not set.');
    }
    return this._state.private[key];
};

_p._hasPrivateState = function(key) {
    return (this._state.private !== null && this._state.private.hasOwnProperty(key));
};

_p._deletePrivateState = function(key) {
    if(this._hasPrivateState(key))
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
    this._setState(PENDING, '*activating*');
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
    return promise.then(null, error=>this._setState(
                FAILED, renderErrorAsMarkdown('Activation failed:', error)));
};

/**
 * This doesn't change the state.
 * In the history, the last status that is not a LOG is the status.
 */
_p._logState = function(markdown, data) {
    this._setState(LOG, markdown, data);
};

_p._setState = function(status, markdown, data){
    this._state.history.push(new TaskState(status, markdown, null, data));
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
