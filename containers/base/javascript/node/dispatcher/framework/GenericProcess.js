"use strict";
/* jshint esnext:true, node:true*/

const { Task } = require('./Task')
  , { Step } = require('./Step')
  , { Process } = require('./Process')
  ;


const GenericTask = (function(){
const Parent = Task;
function GenericTask(step, state){
    Parent.call(this, step, state);
}
GenericTask.prototype = Object.create(Parent.prototype);
return GenericTask;
})();

const GenericStep = (function(){

const Parent = Step;
function GenericStep(process, state){
    var taskCtors = {};
    for(let [key/*, taskState*/] of state.tasks)
        taskCtors[key] = GenericTask;
    Parent.call(this, process, state, taskCtors);
}
GenericStep.prototype = Object.create(Parent.prototype);
return GenericStep;
})();

const GenericProcess = (function(){
/**
 * The idea of GenericProcess is to be able to display the data of
 * an outdated or otherwise incompatible process in the interface,
 * without any means of changing the actual data. E.g. the Task don't
 * have any actions.
 */
const Parent = Process;
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
GenericProcess.prototype.constructor = GenericProcess;
return GenericProcess;
})();

exports.GenericProcess = GenericProcess;
