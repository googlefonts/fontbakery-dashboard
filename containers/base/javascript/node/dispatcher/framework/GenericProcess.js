"use strict";
/* jshint esnext:true, node:true*/

const { Task } = require('./Task')
  , { Step } = require('./Step')
  , { Process } = require('./Process')
  , {mixin: stateManagerMixin} = require('./stateManagerMixin')
  ;


/**
 * This is really not elegant, but I think it will do it's
 * job just fine.
 */
function manipulateStateManagerValidation(state, ignore) {
    // jshint validthis: true
    var forgivingStateDefinitions = {}
      , stateDefKeys = new Set()
      , isAlwaysValid = ()=>[true, null]
      , isTrue = ()=>true
      , isFalse = ()=>false
        // EXPECTED and present
      , acceptingDefinition = {
            init: ()=>null
          , serialize: state=>state
          , load: state=>state
        }
      ;
    for(let [key, definition] of this._stateDefEntries()) {
        if(ignore && ignore.has(key))
            continue;
        stateDefKeys.add(key);
        let newDef = Object.create(definition);
        if('validate' in definition)
            newDef.validate = isAlwaysValid;

        if(!(key in state))
            newDef.isExpected = isFalse;
        else if('isExpected' in definition)
            newDef.isExpected = isTrue;

        if(Object.keys(newDef).length)
            // only needed if there are any `ownProperties`
            forgivingStateDefinitions[key] = newDef;
    }
    for(let key in state){
        if(ignore && ignore.has(key))
            continue;
        if(!stateDefKeys.has(key))
            forgivingStateDefinitions[key] = acceptingDefinition;
    }
    stateManagerMixin(this, forgivingStateDefinitions);
}

const GenericTask = (function(){
const Parent = Task;
function GenericTask(step, state){
    manipulateStateManagerValidation.call(this, state);
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
    manipulateStateManagerValidation.call(this, state, new Set('tasks'));
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
    manipulateStateManagerValidation.call(this, state
                        , new Set('steps', 'failStep', 'finallyStep'));
    Parent.call(this, resources, state, stepCtors, FailStepCtor, FinallyStepCtor);
}

const _p = GenericProcess.prototype = Object.create(Parent.prototype);
_p.constructor = GenericProcess;

_p.getRequestedUserInteractions = function() {
    return null
}

return GenericProcess;
})();

exports.GenericProcess = GenericProcess;
