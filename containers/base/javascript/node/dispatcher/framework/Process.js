"use strict";
/* jshint esnext:true, node:true*/

const {mixin: stateManagerMixin} = require('stateManagerMixin')
  ,   {Status, OK, FAILED} = require('./Status')
  ,   {Path} = require('./Path')
;

function Process(resources
                     , state
                        /*
                         * The last step should dispatch the PR
                         */
                      , stepCtors
                        /*
                         * Special step: it runs immediately after the
                         * first failed step and closes the process.
                         * => Needs a Task that does this!
                         *
                         * I.e. Create an issue somewhere on GitHub.
                         */
                      , FailStepCtor
                        /*
                         * Special step: it runs always as last step
                         * it can be used to cleanu up/close/delete/remove
                         * resources.
                         *
                         * Also needs a Task that does this!
                         */
                      , FinallyStepCtor) {

    Object.defineProperties(this, {
        secrect: {get: ()=>resources.secret}
    });

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
        steps.push(new StepCtor(this, null));
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
    // can be built into StepCtor probably.
    var steps = [];
    for(let [i, StepCtor] of this._stepCtors.steps.entries())
        steps.push(new StepCtor(this, stepStates[i]));
    return steps;
};

_p._initFailStep = function() {
    return new this._stepCtors.FailStep(this, null);
};

_p._loadFailStep = function(state) {
    return new this._stepCtors.FailStep(this, state);
};

_p._initFinallyStep = function() {
    return new this._stepCtors.FinallyStep(this, null);
};

_p._loadFinallyStep = function(state) {
    return new this._stepCtors.FinallyStep(this, state);
};

const dateTypeDefinition = {
        init: () => new Date()
        // if we (de-)serialize from/to rethinkdb, date is actually
        // a valid type! So this can all be just identity functions.
      , serialize: date=>date
      , load: date=>date
      , validate: date=>{
            if(!(date instanceof Date))
                return [false, '`date` is not an instance of `Date`'];
            if(isNaN(date.getTime()))
                return [false, 'Date "'+date+'" is invalid (getTime=>NaN).'];
            return [true, null];
        }
};

const serializeStep = step=>step.serialize();

const stateDefinition = {
    /**
     * the unique id of the Process document in the database.
     */
    id: {
        init: null
      , load: val=>val
      , serialize: val=>val
    }
  , created: dateTypeDefinition // date: always on init, can be overridden by loadState
  , finishedStatus: {
        init: ()=>null
      , serialize: status=>status === null ? null : status.serialize()
      , load: data=>data === null ? null : Status.load(data)
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
    new Path(...this.process.path
    // building this on request, because process.id may not be
    // initially available.
  , path: {
        get: function() {
            if(!this.id)
                throw new Error('ID is not set yet.');
            return new Path(this.id);
        }
    }
 ,  steps: {
        // always return an array, return an empty array if there are no steps
        get: function() {
            return this._state.steps || [];
        }
    }
  , failStep: {
        get: function() {
            return this._state.failStep;
        }
    }
  , finallyStep: {
        get: function() {
            return this._state.finallyStep;
        }
    }
    // this is set in this._transition, possible as an effect of
    // this.activate. But it can't be in this._state directly,
    // because it's determined from the state of this._state.steps etc.
    //  => hmm actually to fully finish the process a UI is neeed
    //     though, if there are no more steps, this needs finishing …
  , isFinished: {
        get: function() {
            return this._state.finishedStatus !== null;
        }
    }
});

/**
 * Called from this.activate and this._transition if there are no more
 * steps to activate (either all steps finished successfully or a step
 * failed)
 */
_p._finish = function() {
    var firstFailedStep = null
      , status, markdown
      , okCounter = 0
      ;
    if(this.isFinished)
        throw new Error('Process was already finished at: ' + this._state.finished);

    for(let [i, step] of this.steps.entries()) {
        if(step.isFailed) {
            firstFailedStep = [i, step];
            break;
        }
        if(step.isFinished)
            okCounter += 1;
    }
    if(!firstFailedStep) {
        // these special steps, if they fail, we still fail the while process
        // even though the result may have been successful.
        if(this.failStep && this.failStep.isFailed)
            firstFailedStep = ['fail step', this.failStep];
        else if(this.finallyStep && this.finallyStep.isFailed)
            firstFailedStep = ['finally step', this.finallyStep];
    }

    if(firstFailedStep) {
        status = FAILED;
        markdown = '**FAILED!** first failed step: '
                + firstFailedStep[0]
                + ' ' + firstFailedStep[0].constructor.name
                ;
    }
    else {
        // no FAILED step at this point, but maybe this method was called
        // (for any reason e.g. timeout) before all steps finished.
        if(okCounter !== this.steps.length
                // no need to check failStep, because we'd have a firstFailedStep
                || (this.finallyStep && !this.finallyStep.isFinished)){
            status = FAILED;
            markdown = '**FAILED!** not all steps are finished.';
        }
        else {
            status = OK;
            markdown = '**DONE!** all steps finished OK';
        }
    }
    // rethinkdb allows for nested indexes:
    // https://www.rethinkdb.com/api/javascript/index_create/
    // we can do:
    //          r.table('processes')
    //           .indexCreate('finished', r.row("finishedStatus")("created"))
    //           .run(conn, callback)
    // i.e. => it's finished when finishedStatus was created.
    this._state.finishedStatus = new Status(status, markdown);
};

/**
 * Called after the Constructor has created the process object.
 * This may be a brand new process, which never was activated or
 * one with old state from the database (re-activation).
 *
 * The aim is to set this._activeStep or to set isFinished
 *
 * FIXME: UIServer likely needs to call this method BUT without the
 * actual step.activate() call that may happen in this._activateStep
 * i.e. UIServer *must not* run methos meant to be performed by
 * ProcessManager *only*.
 * Maybe, activate must be a unique call once in a step lifetime and
 * _loadState (or equivalent) must be enough to identify and set
 * this._activeStep if it is available! Thusly, there would be no
 * need to
 */
_p.activate = function() {
    if(this.isFinished)
        throw new Error('Process is finished.');
    // NOTE: this._activeStep is just in memory, the actual active step
    // is derived from the state (this._state.steps, this.failStep
    // and this.finallyStep).
    if(this._activeStep)
        throw new Error('Process is active.');

    // Find the next active step.
    // This is kind of similar to _p._getNextStep
    //
    // maybe its easier to make one initial activate and then one
    // reActivate when the process is resurrected from persistence?
    // BUT: reActivate would have to work in the activate case as well
    // Thus process.isActive === !! this._activeStep
    var stepToActivate = null;
    for(let step of this.steps) {
        if(step.isFailed) {
            // var firstFailedStep = step;
            if(this.failStep && !this.failStep.isFinished)
                stepToActivate = this.failStep;
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
    if(!stepToActivate && this.finallyStep
                                    && !this.finallyStep.isFinished)
        stepToActivate = this.finallyStep;

    if(stepToActivate)
        return this._activateStep(stepToActivate);
    else
        // It's interesting, if we're out of steps this should be closed
        // though, this may be the initial activation (just without any
        // defined steps, which is stupid, but maybe for testing possible
        // so, if we allow that there are no steps at all, activate()
        // could lead to close directly, without activating any steps.
        return this._finish();
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
    // is set on activate and changed on transition
    if(!this._activeStep)
        throw new Error('No active step found');
    return this._activeStep;
};

_p._isActiveStep = function(step) {
    // throws "No active step found"
    return this._getActiveStep() === step;
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
    var steps = this.steps
      , stepIndex = steps.indexOf(step)
      , lastStepIndex = steps.length - 1
      , nextStepIndex = stepIndex + 1
      ;
    if(stepIndex === -1)
        // didn't find step, so there's no next regular step
        // it's likely that step is failStep or finallyStep
        // i.e. assert step === this.failStep || step === this.finallyStep
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
    // this.failStep must be proceeded by a regular step
    // i.e. step must be a regular step
    // this also ensures that step !== this.failStep
    // this.failStep must be defined
    else if(step.isFailed && this._isRegularStep(step) && this.failStep)
        return this.failStep;
    else if(this.finallyStep && step !== this.finallyStep)
        return this.finallyStep;
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
        return this._finish();
};

_p.getStepPath = function(step) {
    var index;
    if(this.failStep && this.failStep === step)
        return 'fail';
    if(this.finallyStep && this.finallyStep === step)
        return 'finally';
    index = this.steps.indexOf(step);
    if(index !== -1)
        return index + '';
    throw new Error('Step  "' + step + '" not found.');
};

_p._getStep = function(stepPath) {
    var steps = this.steps
      , index, step
      ;
    if(stepPath === 'fail' && this.failStep)
        return this.failStep;
    if(stepPath === 'finally' && this.finallyStep)
        return this.finallyStep;
    // catches floats, negatives, NaN, non canonical int formats
    index = Math.abs(parseInt(stepPath, 10));
    if(index + '' !== stepPath
            || steps.length >= index
            || ( step = steps[index] ) === undefined )
        throw new Error('Step with path "' + stepPath + '" not found.');
    return step;
};

/**
 * validate and perform commandMessage
 *
 * This is the single mechanism that changes process state.
 */
_p.execute = function(targetPath, commandMessage) {
    if(this.isFinished)
        throw new Error('Process is finished.');
    var step = this._getStep(targetPath.step);
    // Throws maybe "No active step found"
    // BUT: if there's no active step this.isFinished should be true.
    // OR the caller did not run process.activate() before calling
    // process.execute().
    if(!this._isActiveStep(step))
        throw new Error('Can\'t execute path "'+targetPath+'" because step '
                + '"'+targetPath.step+'" is not the active step.');
    return step.execute(targetPath, commandMessage)
        .then(()=>this._transition())
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
