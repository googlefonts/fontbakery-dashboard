"use strict";
/* jshint esnext:true, node:true*/


function ProcessManager(logging, db, port, ProcessConstructor) {
    this._log = logging;
    this.ProcessConstructor = ProcessConstructor;
}

const _p = ProcessManager.prototype;

_p._unpackCommandMessage = function(commandMessage) {
    TODO;
    var targetPathString = commandMessage.getTargetPath()
        // actionMessage is an "any" maybe? Thus further work needs to be done
        // to extract it completely.
      , actionMessage = commandMessage.getAction()
      , targetPath = new TargetPath(targetPathString)
      ;
    return [targetPath, actionMessage];
};

/**
 * A lock could be written to the process document, but maybe it's
 * just enough to lock it within this service, as long as it runs as a
 * single instance (likely) and no one else writes to the process document.
 */
_p._lock = function(processId) {
    TODO;
};

_p._unlock = function(processId) {
    TODO;
};

/**
 * This needs to be the gate keeper as well! Are we allowed to perform
 * an action on target? Maybe the step is already finalized or just not
 * the current step ...
 */
_p._getTarget = function(targetPath) {
    // first fetch the process document
    // then check for each path element if we are allowed to change it
    //          => status is important:
    //             * is the item already finalized?
    //             * if it is a step: is the sibling step before finalized?
    //          => authorization will be important, some tasks will only be
    //             changeable by an "engineer" roler, others can also be
    //             changed by an for the family accepted designer.
    // => if not fail
    // => else create a tree from _processDefinition
    // return the last created item, the rest being linked by
    state = dbFetch(targetPath.targetPath.processId)

    // TODO: Process needs to load all the state, not just the adressed
    process = new this.ProcessConstructor(state)//should be enough!
    // must validate state

    if(!process.pathIsChanegable(targetPath))
        throw new


    var processId = targetPath.parts[0]
      , pathParts = targetPath.parts.slice(1) // remove process doc id
      , state = document
      , Ctor = this._processDefinition.Process
      , parent = null
      , current = new Ctor(state, processId, parent)
      ;

    checkAllowedToChange(current);
    for(let pathPart of pathParts) {
        parent = current
        state = state[ .... pathPart ]
        Ctor = this._processDefinition.byPathPart(pathPart)
        current = new Ctor(state, pathPart, parent)
        checkAllowedToChange(current);
    }

    return current;

    return {
        type: "process" | "step" | "task"
        id: ...
        parent: null | process | step
        pathString: get:()=> [(this.parent && this.parent.pathString) || '', this.id].join('/')

        // execute will always only change the state of the target itself
        // not of a parent, not of a child
        // TODO: this comes from this._processDescription
        execute: function(actionMessage) {
            // change state by appen2ding a new item to history
            // STATUS, INFO_MARKDOWN, MORE(?)
        }


        data: {document from the db, or sub-document}
        state: this.data.history[this.data.history.length - 1]

    }
};

/**
 * target will have to validate and perform actionMessage
 */
_p._execute = function(target, actionMessage) {
    TODO;
};

_p._finishTransition = function(target) {
    TODO;
};

/**
 * `processId` is used to receive the process state.
 *
 * `targetPath` is a path likely the specific task
 * May also be the step (close it explicitly and forcefully)
 * and to the proces
 * => {processId}/{stepId}/{taskId}
 *
 * action will be dispatched to the task, which will have to validate and
 * handle it.
 *
 *
 * BEWARE of race conditions! See `_p._lock`.
 */
_p.transition = function(commandMessage) {
    var [targetPath, actionMessage] = this._unpackCommandMessage(commandMessage)
      , unlockFunc = (err) => {
            return this._unlock(targetPath.processId)
                .then(
                    ()=>{if(err) throw err;}
                  , newError=>{
                        if(err)
                            this._log.error('Failed unlock after transition '
                                          + 'failed with error:', err);
                        // that the unlock failed is probably the bigger
                        // problem now, because that means we can't change
                        // the process at all anymore. It's a structural problem.
                        throw newError;
                    }
                );
        }
      , transition = () => {
            return this._getTarget(targetPath)
            // target = process, step or task
            .then(target=>this._execute(target, actionMessage)
                          // on success return target
                          .then(()=>target))
            // transition only if not failed?
            // FIXME: Can a fail leave a bad state and we don't clean up???
            //        A failed execute should not change the state at all!
            //        Do we need a rollback mechanism?
            // Maybe the state needs to be transitioned or the process needs to be finalized.
            .then(target=>this._finishTransition(target))
            .then(()=>unlockFunc(), err=>unlockFunc(err))
            ;
        }
      ;
    return this._lock(targetPath.processId)
        .then(transition)
        .then(null,err=>{
            // log all errors that make it to here and raise to inform
            // the client … this assumes that this func is a grpc action.
            this._log.error(err);
            throw err;
        });
};
