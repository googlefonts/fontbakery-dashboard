"use strict";
/* jshint esnext:true, node:true*/

const {Process: Parent} = require('./Process');

/**
 * The idea of GenericProcess is to be able to display the data of
 * an outdated or otherwise incompatible process in the interface,
 * without any means of changing the actual data. E.g. the Task don't
 * have any actions.
 */
function GenericProcess(resources, state) {
    // guessing by the data which step constructors are required by it.
    var stepCtors = null
      , FailStepCtor = 'failStep' in state ? GenericStep : null
      , FinallyStepCtor = 'finallyStep' in state ? GenericStep : null
      ;
    if('steps' in state) {
        stepCtors = [];
        for(let i=0,l=state.steps.length;i<l;i++)
            stepCtors.push(GenericStep);

    }
    Parent.call(this, resources, state, stepCtors, FailStepCtor, FinallyStepCtor);
}

GenericProcess.prototype = Object.create(Parent.prototype);
