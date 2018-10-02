"use strict";
/* jshint esnext:true, node:true*/

const {mixin: stateManagerMixin} = require('stateManagerMixin');

function Process(state, stepCtors, FailStepCtor, FinallyStepCtor) {
    this._stepCtors = {};
    if(stepCtors)
        this._stepCtors.steps = stepCtors;
    if(FailStepCtor)
        this._stepCtors.FailStep = FailStepCtor;
    if(FinallyStepCtor)
        this._stepCtors.FinallyStep = FinallyStepCtor;

    this._state = null;
    if(state === null)
        // make a new process, i.e. without having any existing state.
        this._initState();
    else
        // may fail! (call explicitly after initialization?)
        this._loadState(state);
}

const _p = Process.prototype;
_p.constructor = Process;

_p._initSteps = function() {
    var steps = [];
    for(let StepCtor of this._stepCtors.steps)
        steps.push(new StepCtor(null, this));
    return steps;
};

_p._loadSteps = function(stepStates) {
    if(!(stepStates instanceof Array))
        // maybe use the debugger to figure what it is?
        throw new Error('`stepStates` must be an instance of Array.'
                        + ' typoeof: ' + (typeof stepStates)
                        + ' toString: ' + stepStates);
    if(stepStates.length !== this._stepCtors.steps.length)
        throw new Error('`stepStates.length` (' + stepStates.length + ') '
                        + 'must match stepCtors.length ('
                        + this._stepCtors.steps.length + ').');
    // TODO: more validation: fingerprints? ids? versions?
    // built into StepCtor probably.
    var steps = [];
    for(let [i, StepCtor] of this._stepCtors.steps.entries())
        steps.push(new StepCtor(stepStates[i], this));
    return steps;
};

_p._initFailStep = function() {
    return new this._stepCtors.FailStep(null, this);
};

_p._loadFailStep = function(state) {
    return new this._stepCtors.FailStep(state, this);
};

_p._initFinallyStep = function() {
    return new this._stepCtors.FinallyStep(null, this);
};

_p._loadFinallyStep = function(state) {
    return new this._stepCtors.FinallyStep(state, this);
};

const dateTypeDefinition = {
        init: () => new Date()
        // if we (de-)serialize from/to rethinkdb, date is actually
        // a valid type! So this can all be just identity functions.
      , serialize: date=>date
      , load: date=>date
      , validate: date=>{
            if(isNaN(date.getTime()))
                return [false, 'Date "'+date+'" is invalid (getTime=>NaN).'];
            return [true, null];
        }
};

const serializeStep = step=>step.serialize();

const stateDefinition = {
    id: {
        init: null
      , load: val=>val
      , serialize: val=>val
    }
  , created: dateTypeDefinition // date: always on init, can be overridden by loadState
  , finished: dateTypeDefinition // date: null on init, can be overridden by loadState and set internally
  , evaluation: {  // markdown, human readable, especially interesting when FAILED
        FIXME// maybe this is not part of the process state directlty?

    }
  , status: { // PENDING, OK, FAILED
        TODO// set this when setting finished? is probably a good thing
        // to have for faster querying
        // alongside with some other useful indexed information
        // we need this for fast and meaningful lists of processes ...
    }
  , steps: { // array, steps statuses, must be compatible with this.constructor.steps
        init: _p._initSteps
      , serialize: steps=>steps.map(serializeStep)
      , load: _p._loadSteps
      , isExpected: function() {
            // only if there are stepCtors
            return ('steps' in this._stepCtors);
        }
    }
  , failStep: {
        init: _p._initFailStep
      , serialize: serializeStep
      , load: _p._loadFailStep
      , isExpected: function() {
            // only if there is a FailStepCtor
            return ('FailStepCtor' in this._stepCtors);
        }
    }
  , finallyStep: {
        init: _p._initFinallyStep
      , serialize: serializeStep
      , load: _p._loadFinallyStepStep
      , isExpected: function() {
            // only if there is a FinallyStepCtor
            return ('FinallyStepCtor' in this._stepCtors);
        }
    }
};

stateManagerMixin(_p, stateDefinition);


Object.defineProperties(_p, {
    id: {
        get: function() {
            return this._state.id;
        }
      , set: function(id) {
            this._state.id = id || null;
        }
    }
 ,  steps: {
        // always return an array, return an empty array if there are no steps
        get: function() {
            return this._state.steps || [];
        }
    }
    // this is set in this._transition, possible as an effect of
    // this.activate. But it can't be in this._state directly,
    // because it's determined from the state of this._state.steps etc.
  , isFinished: {TODO}
});

/**
 * Called after the Constructor has created the process object.
 * This may be a brand new process, which never was activated or
 * one with old state from the database (reactivation).
 *
 * The aim is to set this._activeStep or to set isFinished
 *
 * FIXME: UIServer likely needs to call this method BUT without the
 * actual step.activate() call that may happen in this._activateStep
 * i.e. UIServer *must not* run action meant to be performed by
 * ProcessManager *only*.
 * Maybe, activate must be a unique call once in a step lifetime and
 * _loadState (or equivalent) must be enough to identify and set
 * this._activeStep if it is available! Thusly, there would be no
 * need to
 */
_p.activate = function() {
    if(this.isFinished)
        throw new Error('Process is finished.');
    if(this._activeStep)
        throw new Error('Process is active.');

    // Find the next active step.
    // This is kind of similar to _p._getNextStep
    //
    // maybe its easier to make one initial activate and then one
    // reActivate when the process is resurrected from persistence?
    // BUT: reActivate would have to work in the activate case as well
    // Thus process.isActive === !! this._activeStep
    var firstFailedStep = null // ? do we need this?
      , stepToActivate = null
      , steps = this.steps
      ;
    for(let i=0,l=steps.length;i<l;i++) {
        let step = steps[i];
        if(step.isFailed) {
            firstFailedStep = step;
            if(this._state.failStep && !this._state.failStep.isFinished)
                stepToActivate = this._state.failStep;
            // else => … finallyStep
            break;
        }
        if(!step.isFinished) {
            // will have to activate all cases where !step.isFinished
            // i.e. step.isFailing === true will also be activated
            stepToActivate = step;
            break;
        }
    }
    // else => … finallyStep
    if(!stepToActivate && this._state.finallyStep
                                    && !this._state.finallyStep.isFinished)
        stepToActivate = this._state.finallyStep;

    if(stepToActivate)
        return this._activateStep(stepToActivate);
    else
        // It's interesting, if we're out of steps this should be closed
        // though, this may be the initial activation (just without any
        // defined steps, which is stupid, but maybe for testing possible
        // so, if we allow that there are no steps at all, activate()
        // could lead to close directly, without activating any steps.
        return this._close();
};

_p._isActiveStep = function(step) {
    return this._getActiveStep() === step;
};

// getter boolean
Object.defineProperty(_p, 'userInteractionIsRequired', {
    get: function() {
        TODO;
        return true || false;
    }
});

/**
 * return an dict of {path: [...user interface description]}
 * this runs probably only in UIServer, but then we need the information
 * of which UIs are requested to either survive serialisation, or to
 * get it directly via gRPC from ProcessManager ???
 */
_p.defineUserInteracion = function(uiConstructors) {
    if(!this.userInteractionIsRequired)
        throw new Error('User Interaction is not requested.');
    var uiDescription = {};
    // ...
    return uiDescription;
};

// this runs in ProcessManager
_p.receiveUserInteracion = function(userResponse) {

};

_p._getActiveStep = function() {
    if(!this._activeStep)
        throw new Error('No active step found');
    //    let activeStep = this._findActiveStep(); ???
    //    return this._activateStep(activeStep)
    TODO; // set on init/load state
    return this._activeStep;
};

_p._activateStep = function(step) {
    if(step.isFinished)
        throw new Error('Can\t activate closed step.');
    // we could have a self-check here if step is the valid
    // next step.
    this._activeStep = step;
    // There's the possibility, that the process/step was activated and
    // then persisted and reloaded. In that case, we don't want the
    // step to run all it's activate action again, just set this._activeStep;
    return step.isActivated
                ? Promise.resolve(step)
                    // (sometimes recursively) call this._transition
                    // it could be that step is already finished
                    // after activation
                 : step.activate()
                       .then(()=>this._transition());
};

_p._getNextRegularStep = function(step) {
    let steps = this.steps
      , stepIndex = steps.indexOf(step)
      , lastStepIndex = steps.length - 1
      , nextStepIndex = stepIndex + 1
      ;
    if(stepIndex === -1)
        // didn't find step, so there's no next regular step
        // it's likely that step is failStep or finallyStep
        // i.e. assert step === this._state.failStep || step === this._state.finallyStep
        return null;
    if(stepIndex === lastStepIndex)
        // that was the last regular step
        return null;
    return steps[nextStepIndex];
};

_p._isRegularStep = function(step) {
    return this.steps.indexOf(step) !== -1;
};

_p._getNextStep = function(step) {
    // assert step.isFinished
    var nextRegularStep = this._getNextRegularStep(step);
    if(!step.isFailed && nextRegularStep)
        return nextRegularStep;
    // step is failed or there's no next regular step
    // this._state.failStep must be proceeded by a regular step
    // i.e. step must be a regular step
    // this also ensures that step !== this._state.failStep
    // this._state.failStep must be defined
    else if(step.isFailed && this._isRegularStep(step) && this._state.failStep)
        return this._state.failStep;
    else if(this._state.finallyStep && step !== this._state.finallyStep)
        return this._state.finallyStep;
    else
        return null;
};

_p._transition = function() {
        // throws "No active step found"
    var activeStep = this._getActiveStep()
      , nextStep = null
      ;
    if(!activeStep.isFinished)
        // still pending
        return;

    // next step
    nextStep = this._getNextStep(activeStep);
    if(nextStep)
        return this._activateStep(nextStep);
    else
        // no next step
        return this._close();
};

/**
 * validate and perform actionMessage
 *
 * This is the single mechanism that changes process state.
 */
_p.execute = function(targetPath, actionMessage) {
    // if(targetPath.step) ? => can we execute directly on path?
    var step = this._getStep(targetPath.step);TODO; // implement
    if(!this._isActiveStep(step)) // TODO: implement
        throw TODO; // implement
    return step.execute(targetPath, actionMessage)// TODO: implement
        .then(()=>this._transition()) //TODO: implement
        ;
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
    // jshint unused: vars
    throw new Error('Not implememnted: setSharedData');
};

_p.hasSharedData = function(key) {
    // jshint unused: vars
    throw new Error('Not implememnted: hasSharedData');
};

_p.getSharedData = function(key, ...args) {
    // jshint unused: vars
    throw new Error('Not implememnted: getSharedData');
};

_p.deleteSharedData = function(key) {
    // jshint unused: vars
    throw new Error('Not implememnted: deleteSharedData');
};
