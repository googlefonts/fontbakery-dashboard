"use strict";
/* jshint esnext:true, node:true*/

const AsyncQueue = require(TODO)
  , { Path } = require('./Path')
  ;

/**
 * TODO: now the interaction with ProcessManager needs to be defined...
 * What is the UI server sending here?
 * What are the answers?
 * How are state changes propagated?
 */

function ProcessManager(logging, db, port, secret, ProcessConstructor) {
    this._log = logging;
    this._processResources = Object.create(null);
    this._processSubscriptions = new Map();

    Object.defineProperties(this._processResources, {
        secret: {value: secret}
    });
    Object.defineProperties(this, {
        ProcessConstructor: {value: ProcessConstructor}
    });
}

const _p = ProcessManager.prototype;

_p._persistProcess = function(process) {
        // if process has no id we do an insert, otherwise replace
        // instead of `replace`, `update` could speed up the action
        // but it would mean we only update changes, which is more effort
        // to implement.
    var method = process.id ? 'replace' : 'insert';

    table
        // Insert a document into the table users, replacing the document
        // if it already exists.
        [method](process.serialize(), {conflict: "replace"})
        .then(report=>{
            if(report.generated_keys && report.generated_keys.length)
                // assert report.inserted === 1
                // assert process.id === null
                process.id = report.generated_keys[0];
            return process;
        });
};

/**
 * Create a brand new process.
 */
_p._initProcess = function() {
    var process = new this.ProcessConstructor(
                                    this._processResources, null);
     // will also activate the first step and all its tasks
    return process.activate()
        .then(()=>this._persistProcess(process));
};

/**
 * Try to create a process with state (e.g. from the database). If using
 * ProcessConstructor fails (e.g. because it's incompatible with the state)
 * a GenericProcess will be created, which should be fine for viewing but
 * has now APIs to change it's state.
 */
_p._initProcessWithState = function(state) {
    var process;
    try {
        process = new this.ProcessConstructor(
                                    this._processResources, state);
    }
    catch(error) {
        // FIXME: Since we can't use this state anymore, we should
        // "force finish" it. That way, a new process for the family can
        // be initiated.

        // expecting this to be some kind of state validation issue
        // i.e. the state is (now) incompatible with ProcessConstructor
        try {
            process = new GenericProcess(this._processResources, state);
        }
        catch(error2) {
            // Loading the GenericProcess should never fail.
            // Probably something very basic changed.
            throw new Error('Can\'t create Process from state with error: '
                            +  error + '\n'
                            + 'Also, can\t initiate GenericProcess from '
                            + 'state with error:' + error2);
        }
    }
    return process.activate()
        .then(()=>process);
};

_p._loadProcessFromDB = function(processId) {
    return dbFetch(processId)
        .then(state=>this._initProcessWithState(state));
};

_p._getProcess = function(processId) {
    TODO;// concept and implementation of process cache and cache invalidation
    // i.e. when is a process removed from _activeProcesses/memory
    // this *needs* more info about how process is used!
    var process = this._activeProcesses.get(processId);
    if(!process) {
        // may fail!
        process = this._loadProcessFromDB(processId)
            .then(process=>{
                this._activeProcesses.set(processId, {process, queue: new AsyncQueue()});
                return process;
            });
    }
    return Promise.resolve(process);
};

    FIXME;
    // first fetch the process document
    // then check for each path element if we are allowed to change it
    //          => status is important:
    //             * is the item already finalized?
    //             * if it is a step: is the sibling step before finalized?
    //          => authorization will be important, some tasks will only be
    //             changeable by an "engineer" role, others can also be
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
    // that are no longer compatible, so that we can display but not modify
    // them.

    // hmm, probably checked by process.execute internally
    // GenericProcess would not be changeable in general.
    // maybe it's own access log could get a message about this attempt
    // though, that could help with debugging


/**
 * GRPC api "execute" … (could be called action or command as well)
 *
 * action will be dispatched to the task, which will have to validate and
 * handle it.
 *
 *
 * BEWARE of race conditions! We're using AsyncQueue to not act on the
 * same process in two concurrent tasks.
 *
 * TODO: back channel needs to be established to inform the caller of the
 * result of the command. Especially fails, but also just success.
 *
 * commandMessage interfaces needed so far:
 *      callbackName = commandMessage.getCallbackName()
        ticket = commandMessage.getTicket()
 *      payload = JSON.parse(commandMessage.getPayload())
 *      targetPath = Path.fromString(commandMessage.getTargetPath())
 */
_p.execute = function(commandMessage) {
    // aside from the managennet,, queueing etc.
    // it's probably the task of each element in the process hierarchy
    // to check whether the command is applicable or not.
    // so this command trickles down and is checked by each item on it's
    // way …
    var targetPath = Path.fromString(commandMessage.getTargetPath());
    return this._getProcess(targetPath.processId)// => {process, queue}
        .then(({process, queue})=>{
            // Do we need a gate keeper? Are we allowed to perform an action on target?
            // process should be designed in a way, that it doesn't end in a
            // unrecoverable state, i.e. if the state is FUBAR, the process
            // should be marked as failed an don't accept new commands.
            // The implementation of process is intended to take care of
            // this.
            var job = ()=>process.execute(targetPath, commandMessage);
            return queue.schedule(job)
                // on success return promise
                .then(
                    ()=>process
                  , error=>this._log.error(error, 'targetPath: ' + targetPath)
                )
                // persist after each execute, maybe even after each activate,
                // especially when activate(also error handling in _initProcessWithState)
                // changed the process state, e.g. set it to a finished state.
                .then(process=>
                        this._persistProcess(process).then(()=>process))
                .then(process=>{
                    // don't wait for this to finish
                    // should also not return a promise (otherwise, a fail
                    // would create an unhandled promise, and it's not
                    // interesting here to handle that.
                    this.publishUpdates(process);
                    return process;
                });
        });
};

_p.publishUpdates = function(process) {
    var subscriptions = this._processSubscriptions.get(process)
        // create this once for each subscriber
        // would be nice to have it also just serialzied once.
      , processMessage = new ProcessMessage(process)
      ;
    if(!subscriptions)
        return;
    for(subscription of subscriptions)
        TODOpublish(subscription, processMessage);

};

_p.subscribeList = function(call){
    var selection = call.request.getSelection();
    // all subscriptions in here follow the same scheme. That means
    // a subscriber needs to renew periodically.
    // MAYBE: hat renewing seems a bit overcomplicated. The subscription
    // can also just end when the client hangs up and the call is ended.
    // we still need no extra unsubscribe call.
};

// Interestingly, the User Interface will be based on the Font Family
// not on the Proess. Similarly, the Fontbakery reports should not be
// accessed via the report ID only. Rather via a family page, or the
// dashboard...
// the idea is that the client pieces this together.
_p.subscribeProcess = function(call) {
    // a subscruption times out/has to be renewed by the subscriber after
    // an amount of time. that way we don't need an explicit unsubscribe
    // also, we send the whole process state after each change, not just
    // the change set.
    // The renewal is done via the incoming stream, not by calling subscribe
    // again.
    var processId = call.request.getProcessId();
    // send an initial process directly


};
