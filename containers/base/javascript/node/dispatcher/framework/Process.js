"use strict";
/* jshint esnext:true, node:true*/

function Process(state) {
    // Maybe rather a setState method?
    // we need a way to make a new process, i.e. without having any existing state.
    this._state = null;
    this._steps = this._initSteps(this.constructor.steps);
    if(state)
        this.loadState(state);// may fail! (call explicitly after initialization?)
}

const _p = Process.prototype;
_p.constructor = Process;

// expecting the sub-constructor to define these!
Process.steps = null;

_p._initSteps = function(steps) {
    var result = [];
    for(let StepCtor of steps) {
        TODO;
        let stepState = this._state.steps[i];
        result.push(new StepCtor(stepState, this));
    }
    return result;
};


expectedKeys = [
    'created' // date: always on init, can be overridden by loadState
    'finished' // date: null on init, can be overridden by loadState and set internally
    'evaluation' // markdown, human readable, especially interesting when FAILED
    'status' // PENDING, OK, FAILED
    'steps' // array, steps statuses, must be compatible with this.constructor.steps
]

_p.loadState = function(state) {
    var unknown, missing
      , receivedKeys = new Set(Object.keys(state))
      ;
    unknown = receivedKeys - expectedKeys
    if(unknown.size)
        throw "State has unknown keys: {unknown}"
    missing = expectedKeys - receivedKeys
    if(missing.size)
        throw "Keys are missing from state: {missing}"

}

/**
 * Validation on construction is to figure if we received a valid state
 * to begin with.
 * After changing state, if it is still valid, we can commit the changes
 * to the database.
 */
_p.validateState = function() {


}
