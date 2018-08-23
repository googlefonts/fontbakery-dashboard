"use strict";
/* jshint esnext:true, node:true*/

function Process(state) {
    // Maybe rather a setState method?
    // we need a way to make a new process, i.e. without having any existing state.
    this._state = null;
    [this._steps, this._finalizeStep, this._failStep] = this._initSteps(
            this.constructor.steps
          , this.constructor.FinalizeStep
          , this.constructor.FailStep);
    if(state)
        this.loadState(state);// may fail! (call explicitly after initialization?)
}

const _p = Process.prototype;
_p.constructor = Process;

// expecting the sub-constructor to define these!
Process.steps = null;

_p._initSteps = function(stepCtors, FinalizeStep, FailStep) {
    var steps = []
      , finalizeStep
      ;
    for(let [i, StepCtor] of stepCtors.entries()) {
        TODO;
        let stepState = this._state.steps[i];
        steps.push(new StepCtor(stepState, this));
    }

    finalizeStep = new FinalizeStep(this._state.finalizeStep, this);
    failStep = new FailStep(this._state.failStep, this);

    return [steps, finalizeStep, failStep];
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
};

/**
 * state shared with the whole process
 * this should be persistant IMO, especially the familyData message
 * is important for e.g. forensics (only if we didn't do the PR …=
 * maybe we need to define life time management, or just get a huge disk)
 * If a new PR for the same family was created the old Process data could
 * be deleted... but in general, just keeping it around is probably more
 * straight forward just now and much less effort.
 * When we save these as files, we should have a MIME type of information
 * so _getSharedData can figure how to interprete/use the data
 *
 * For now, there is no namespace recommendation. A process should be
 * small and overseeable enough that clashes can be avoided. Use shared
 * state sparingly and think before you do.
 */
_p.setSharedData = function(key, value) {
    throw new Error('Not implememnted: setSharedData');
};

_p.hasSharedData = function(key) {
    throw new Error('Not implememnted: hasSharedData');
};

_p.getSharedData = function(key, ...args) {
    throw new Error('Not implememnted: getSharedData');
};

_p.deleteSharedData = function(key) {
    throw new Error('Not implememnted: deleteSharedData');
};

/**
 * Validation on construction is to figure if we received a valid state
 * to begin with.
 * After changing state, if it is still valid, we can commit the changes
 * to the database.
 */
_p.validateState = function() {


};
