"use strict";
/* jshint esnext:true, node:true*/

const { AsyncQueue } = require('../../util/AsyncQueue')
  , { Path } = require('./Path')
  , grpc = require('grpc')
  , { ProcessManagerService } = require('protocolbuffers/messages_grpc_pb')
  , { Empty } = require('google-protobuf/google/protobuf/empty_pb.js')
  , { ProcessList, ProcessListItem, ProcessState } = require('protocolbuffers/messages_pb')
  , { GenericProcess } = require('./GenericProcess')
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
      , log: {value: this._log}
    });
    Object.defineProperties(this, {
        ProcessConstructor: {value: ProcessConstructor}
    });

    this._server = new grpc.Server({
        'grpc.max_send_message_length': 80 * 1024 * 1024
      , 'grpc.max_receive_message_length': 80 * 1024 * 1024
    });

    this._server.addService(ProcessManagerService, this);
    this._server.bind('0.0.0.0:' + port, grpc.ServerCredentials.createInsecure());
}

exports.ProcessManager = ProcessManager;
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

function TODO(){}

_p._getProcess = function(processId) {
    TODO();// concept and implementation of process cache and cache invalidation
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

    // TODO;
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
    for(let subscription of subscriptions)
        TODO('publish(subscription, processMessage);')

};

////////////////
// gRPC related:

_p.serve = function() {
    return this._server.start();
};

/**
 * The unsubscribe function may be called multiple times during the
 * ending of a call, e.g. when finishing with an error three times.
 * make sure it is prepared.
 */
_p._subscribeCall = function(type, call, unsubscribe) {
    // To end a subscription with a failing state, use:
    //      `call.destroy(new Error('....'))`
    //      The events in here are in order: FINISH, ERROR, CANCELLED
    // This will also inform the client of the error details `call.on('error', ...)`
    // To end a subscription regularly, use:
    //       `call.end()`
    //        The events in here are in order: FINISH
    // When the client hangs up using:
    //         `call.cancel()`
    //        The events in here are in order: CANCELLED
    //        NOTE: *no* FINISH :-(
    //        If the client produces an error e.g.
    //              `call.on('data', ()=>throw new Error())`
    //        It also seems to result in a cancel, as well as when the
    //        client just shuts down. There is not really a way to send
    //        errors to the server as it seems.


    // TODO: need to keep call in `subscriptions` structure
    call.on('error', error=>{
        this._log.error('on ERROR: subscribeCall('+type+'):', error);
        unsubscribe();
    });
    call.on('cancelled', ()=>{
        // hmm somehow is called after the `call.on('error',...)` handler,
        // at least when triggered by `call.destroy(new Error(...))`
        // seems like this is called always when the stream is ended
        // we should be careful with not trying to double-cleanup here
        // if the client cancels, there's no error though!
        this._log.debug('on CANCELLED: subscribeCall('+type+')');
        unsubscribe();
    });

    call.on('finish', ()=>{
        this._log.debug('on FINISH: subscribeCall('+type+')');
        unsubscribe();
    });
};

// Interestingly, the User Interface will be based on the Font Family
// not on the Process. Similarly, the Font Bakery reports should not be
// accessed via the report ID only. Rather via a family page, or the
// dashboard...
// the idea is that the client pieces this together.
_p.subscribeProcess = function(call) {
    var processQuery = call.request
      , unsubscribe = ()=> {
            if(!timeout) // marker if there is an active subscription/call
                return;
            // End the subscription and delete the call object.
            // Do this only once, but, `unsubscribe` may be called more than
            // once, e.g. on `call.destroy` via FINISH, CANCELLED and ERROR.
            this._log.info('... UNSUBSCRIBE');
            clearInterval(timeout);
            timeout = null;
        }
      ;

    this._log.info('processQuery subscribing to', processQuery.getProcessId());
    this._subscribeCall('process', call, unsubscribe);

    var counter = 0, maxIterations = Infinity
      , timeout = setInterval(()=>{
        this._log.debug('subscribeProcess call.write counter:', counter);
        var processState = new ProcessState();
        processState.setProcessId(new Date().toISOString());

        counter++;
        if(counter === maxIterations) {
            //call.destroy(new Error('Just a random server fuckup.'));
            //clearInterval(timeout);
            call.end();
        }
        else
            call.write(processState);

    }, 1000);
};

_p.subscribeProcessList = function(call) {
    var processListQuery = call.request
      , unsubscribe = ()=> {
            if(!timeout) // marker if there is an active subscription/call
                return;
            // End the subscription and delete the call object.
            // Do this only once, but, `unsubscribe` may be called more than
            // once, e.g. on `call.destroy` via FINISH, CANCELLED and ERROR.
            this._log.info('... UNSUBSCRIBE');
            clearInterval(timeout);
            timeout = null;
        }
      ;

    this._log.info('processQuery subscribing to', processListQuery.getQuery());
    this._subscribeCall('process', call, unsubscribe);

    var counter = 0, maxIterations = Infinity
      , timeout = setInterval(()=>{
        this._log.debug('subscribeProcessList call.write counter:', counter);

        var processList = new ProcessList();
        for(let i=0,l=3;i<l;i++) {
            let processListItem = new ProcessListItem();
            processListItem.setProcessId(
                            '#' + i + '+++' + new Date().toISOString());
            processList.addProcesses(processListItem);
        }

        counter++;
        if(counter === maxIterations) {
            //call.destroy(new Error('Just a random server fuckup.'));
            //clearInterval(timeout);
            call.end();
        }
        else
            call.write(processList);

    }, 1000);
};

_p.execute = function(processCommand) {
    //jshint unused:vars
    // TODO(processCommand);
    return new Empty();
};


