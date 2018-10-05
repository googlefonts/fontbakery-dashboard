"use strict";
/* jshint esnext:true, node:true*/


FIXME;// This is a stub;
/** `targetPath` is a path likely the specific task
 * May also be the step (close it explicitly and forcefully)
 * and to the process
 * => {processId}/{stepId}/{taskId}
 *
 * as a string:
 * we could go for indexes OR for ids, for a mixture of both, where it
 * makes sense AND for both in all cases which is redundant.
 *
 * indexes make sense for steps, because these are an ordered list
 * ids make sense for tasks, because they are "unordered" at least
 * semantically (there's an explicit order in the `tasks` list of the
 * step that we use)
 *
 * process: {processId}
 * steps: {index}
 * task: {id} OR {index}:{id} ? => redundant, but maybe helps to reduce errors, i.e. when refactoring?
 * callback: {name}
 *
 * having an id and an index for a task, we can create a fingerprint
 * for the step. though, we can also create a fingerprint by merely
 * using ids! just have to sort the ids before to create a canonical order.
 * So, tasks don't have indexes …
 */
function TargetPath(pathString) {
    // documenting expected properties;
    this.processId
    this.step
    this.task
}

function ProcessManager(logging, db, port, secret, ProcessConstructor) {
    this._log = logging;
    this._processResources = Object.create(null);
    Object.defineProperties(this._processResources, {
        secret: {value: secret}
    });


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
 *
 * TODO: also create a queue, to dispatch all incoming messages to the
 * process one after another, without turning them down when one request
 * is processed.
 */
_p._lock = function(processId) {
    TODO;
};

_p._unlock = function(processId) {
    TODO;
};


_p._persistProcess = function(process) {
        // if process has no id we do an insert, otherwise replace
        // instead of `replace`, `update` could speed up the action
        // but it would mean we only update changes, which is more effort
        // to implement.
    var method = process.id ? 'replace' : 'insert';

    ...table
        // Insert a document into the table users, replacing the document
        // if it already exists.
        .insert(process.serialize(), {conflict: "replace"})
        .then(report=>{
            if(report.generated_keys && report.generated_keys.length)
                // assert report.inserted === 1
                // assert process.id === null
                process.id = report.generated_keys[0];
            return process
        })
};

/**
 * Crate a brand new process.
 */
_p._initProcess = function() {
    var process = new this.ProcessConstructor(
                                    this._processResources, null);
     // will also activate the first step and all its tasks
    return process.activate()
        .then(()=>this._persistProcess(process));
};

/**
 * Try to create a process with state from the database. If using
 * ProcessConstructor fails (e.g. because it's incompatible with the state)
 * a GenericProcess will be created, which should be fine for viewing but
 * has now APIs to change it's state.
 */
_p._loadProcess = function(processId) {
    var state = dbFetch(processId);
    try {
        process = new this.ProcessConstructor(
                                    this._processResources, state);
    }
    catch(error) {
        // expecting this to be some kind of state validation issue
        // i.e. the state is (now) incompatible with ProcessConstructor
        try {
            process = new GenericProcess(this._processResources, state);
        }
        catch(error2) {
            // Loading the GenericProcess should never fail.
            // Probably something very basic changed.
            throw new Error('Can\'t create Process from state with error: '
                            +  error '+\n'
                            + 'Also, can\t initiate GenericProcess from '
                            + 'state with error:' + error2);
        }
    }
    return process.activate()
        .then(()=>process);
};

_p._getProcess = function(processId) {
    TODO;// concept and implementation of process cache and cache invalidation
    var process = this._activeProcesses.get(processId);
    if(!process) {
        TODO;// may fail!
        process = this._loadProcess(processId);
        this._activeProcesses.set(processId, process);
    }
    return process;
}

/**
 * This needs to be the gate keeper as well! Are we allowed to perform
 * an action on target? Maybe the step is already finalized or just not
 * the current step ...
 */
_p._getTargetProcess = function(targetPath) {
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
    //
    // Fingerprinting steps will help to detect missmatches between state
    // from the database and the process defined by the code, not fully
    // sufficient, but a strong marker if something has changed.
    //
    // We must/should have enough data in the DB, to create a generic process
    // without the current in code defined process, for outdated reports,
    // that are no longer compatible, so that we can display them.


    NOTE;// can be a GenericProcess as well!
    var process = this._getProcess(targetPath.processId);


    // hmm, probably checked by process.execute internally
    // GenericProcess would not e changeable in general.
    // maybe it's own access log could get a message about this attempt
    // though, that could help with debugging
    if(!process.isChangegable(targetPath))
        throw new ...

    return process;

    return {
        type: "process" | "step" | "task"
        id: ...
        parent: null | process | step
        pathString: get:()=> [(this.parent && this.parent.pathString) || '', this.id].join('/')

        // execute will always only change the state of the target itself
        // not of a parent, not of a child
        // TODO: this comes from this._processDescription
        execute: function(actionMessage) {
            // change state by appending a new item to history
            // STATUS, INFO_MARKDOWN, MORE(?)
        }


        data: {document from the db, or sub-document}
        state: this.data.history[this.data.history.length - 1]

    }
};

_p._finishTransition = function(process) {
    TODO;
};

/**
 * GRPC api "transition" … (could be called action or command as well)
 *
 * action will be dispatched to the task, which will have to validate and
 * handle it.
 *
 *
 * BEWARE of race conditions! See `_p._lock`.
 */
_p.transition = function(commandMessage) {
    // aside from the managemnet, locking, queueing etc.
    // it's probably the task of each element in the process hierarchy
    // to check whether the command is applicable or not.
    // so this command trickles down and is checked by each item on it's
    // way …
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
            return this._getTargetProcess(targetPath)
            // target = process, step or task
            .then(process=>process.execute(targetPath, actionMessage)
                                  .then(()=>process))// on success return process
            // transition only if not failed?
            // FIXME: Can a fail leave a bad state and we don't clean up???
            //        A failed execute should not change the state at all!
            //        Do we need a rollback mechanism?
            // Maybe the state needs to be transitioned or the process
            // needs to be finalized.
            // process.execute could handle this as well!
            .then(process=>this._finishTransition(process))
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
