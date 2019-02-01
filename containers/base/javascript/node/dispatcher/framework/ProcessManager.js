"use strict";
/* jshint esnext:true, node:true*/

const { AsyncQueue } = require('../../util/AsyncQueue')
  , { Path } = require('./Path')
  , grpc = require('grpc')
  , { ProcessManagerService } = require('protocolbuffers/messages_grpc_pb')
//  , { Empty } = require('google-protobuf/google/protobuf/empty_pb.js')
  , { ProcessState, ProcessCommandResult, ProcessCommand } = require('protocolbuffers/messages_pb')
  , { GenericProcess } = require('./GenericProcess')
  , { IOOperations } = require('../../util/IOOperations')
  , { ProtobufAnyHandler } = require('../../util/ProtobufAnyHandler')
  ;

/**
 * TODO: now the interaction with ProcessManager needs to be defined...
 * What is the UI server sending here?
 * What are the answers?
 * How are state changes propagated?
 */

function ProcessManager(setup, port, secret, anySetup, ProcessConstructor) {
    this._log = setup.logging;
    this._io = new IOOperations(setup.logging, setup.db, setup.amqp);
    this._executeQueueName = null;
    this._processResources = Object.create(null);
    this._processSubscriptions = new Map();
    this._activeProcesses = new Map();
    this._any = new ProtobufAnyHandler(this._log, anySetup.knownTypes, anySetup.typesNamespace);
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

    this._asyncDependencies = [];
    this._asyncDependencies.push([this._io, 'init']);
}

exports.ProcessManager = ProcessManager;
const _p = ProcessManager.prototype;

_p._persistProcess = function(process) {
        // if process has no id we do an insert, otherwise replace
        // instead of `replace`, `update` could speed up the action
        // but it would mean we only update changes, which is more effort
        // to implement.
    var processData = process.serialize()
      , conflict = process.id ? 'replace' : 'error'
      ;
    if(!process.id)
        // Otherwise we get this Error:
        //          "Primary keys must be either a number, string, bool,
        //           pseudotype or array (got type NULL)"
        delete processData.id;
    return this._io.query('dispatcherprocesses')
        // Insert a document into the table users, replacing the document
        // if it already exists.
        .insert(processData, {conflict: conflict})
        .then(report=>{
            if(report.errors)
                throw new Error(report.first_error);

            if(report.generated_keys && report.generated_keys.length)
                // assert report.inserted === 1
                // assert process.id === null
                process.id = report.generated_keys[0];
            return process;
        });
};

/**
 * This should be implemented by the specific implementation of ProcessManager
 *
 * It is important to check that the type od initMessage is an instance
 * of the expected protocol buffers message type.
 */
_p._examineProcessInitMessage = function(initMessage) {
    // jshint unused:vars
    // Does the familyName exist?
    // Is the requester authorized to do this?
    // Is it OK to init the process now or are there any rules why not?
    return Promise.resolve([null, {}]); // [errorMessage, initArgs]
};

/**
 * Create a brand new process.
 *
 * TODO: need to inject here implementation specific metadata somehow
 */
_p._initProcess = function(initArgs) {
    var process = new this.ProcessConstructor(
                                    this._processResources, null, initArgs);
     // will also activate the first step and all its tasks
    return process.activate()
        .then(()=>this._persistProcess(process))
        // FIXME: do this here? Maybe the caller of _initProcess should do!
        .then(process=>this._setProcess(process.id, process, null))
        .then(processData=>processData.process)
        ;
};

/**
 * Try to create a process with state (e.g. from the database). If using
 * ProcessConstructor fails (e.g. because it's incompatible with the state)
 * a GenericProcess will be created, which should be fine for viewing but
 * has now APIs to change it's state.
 * TODO: If a GenericProcess is required, and the process is *not* finished
 * we have potentially a problem: there's no UI to close it. Thusly,
 * the one API to change it's state should be probably something to finish
 * it and potentially to start another process for that font family.
 * Otherwise, likely, the dispatcher for that library may be stuck waiting
 * for the outdated process. Though, eventually timeouts or other tools
 * external to processes can help here, too.
 * ALSO, the idea of this right now may be over-complicated, maybe it's
 * simpler to just pass the state to the client (which we'll do probably
 * anyways with all processes).
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
        // be started.
        // expecting this to be some kind of state validation issue
        // i.e. the state is (now) incompatible with ProcessConstructor
        // thus, maybe GenericProcess should not validate or not be
        // a `Process` at all, just a container for unloaded state.

        // FIXME: we should add the ERROR to the state of
        // GenericProcess somehow. At least it shouldn't be muted!
        // This warning will at least put the stack trace into the logs,
        // but that may become log-pollution...
        this._log.warning('Can\'t init regular Process with state',
                              'trying GenericProcess.', error);

        // NOTE: This can and probably will eventually fail, but,
        // loading the GenericProcess should never fail.
        // If it fails, probably something very basic changed.
        // The solution is not to mute errors in GenericProcess though
        // rather do sth. more appropriate that captures the intention
        // of the class.
        process = new GenericProcess(this._processResources, state);
    }
    // FIXME: only activate the process if it is *NOT* finished
    // TODO: activate *GenericProcess* ??? sounds all wrong to me
    // but could be used to set a finishing status. If the GenericProcess
    // is finished already, it seems to load fine already, e.g. without
    // errors. But this is most likely not true for all cases,
    // e.g. if an expectedAwnser is set, but there's no callback(s) for
    // it, state validation will fail. Maybe, we need to skip stateManager
    // validation for the Generic{Process|Step|Task} classes
    return process.isFinished
        ?   process
        :   process.activate().then(()=>process)
        ;
};

_p._loadProcessFromDB = function(processId) {
    return this._io.query('dispatcherprocesses')
        .get(processId)
        .then(state=>{
            if(state === null)
                throw new Error('Process not found! With id: '+processId);
            return this._initProcessWithState(state);
        });
};

function TODO(){}

_p._setProcess = function(processId, process, promise) {
    var assertion = (process === null || promise === null) && process !== promise
      , processData
      ;
    if(!assertion)
        throw new Error('`process` and `promise` must be mutually exclusive, '
                      + 'one must be null.\n'
                      + '(process: '+process+') (promise: '+promise+')');


    processData = this._activeProcesses.get(processId);
    if(!processData) {
        processData = {
            process: null
          , promise: null
          , queue: new AsyncQueue()
        };
        this._activeProcesses.set(processId, processData);
    }
    processData.process = process;
    processData.promise = promise;
    return processData;
};

_p._getProcess = function(processId) {
    TODO();// concept and implementation of process cache and cache invalidation
    // i.e. when is a process removed from _activeProcesses/memory
    // this *needs* more info about how process is used!
    var processData = this._activeProcesses.get(processId);
    if(!processData) {
        // may fail!
        let promise = this._loadProcessFromDB(processId)
            // replace the promise with the actual value
            // could also just remain the resolved promise, but
            // this way seems more explicit.
            // => processData
            .then(process=>this._setProcess(processId, process, null))
            ;
        processData = this._setProcess(processId, null, promise);
    }
    return processData.promise || Promise.resolve(processData);
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

_p._publishUpdates = function(process) {
    var subscriptions = this._processSubscriptions.get(process.id)
      , processState
      ;
    if(!subscriptions || !subscriptions.size)
        return;

    // create this once for all subscribers
    // would be nice to have it also just serialzied once.
    processState = this._getProcessStateForClient(process);
    for(let call of subscriptions)
        call.write(processState);

};

////////////////
// gRPC related:

_p.serve = function() {
    // Start serving when the database etc. is ready
    return Promise.all(this._asyncDependencies.map(
            ([service, method])=>service[method]()))
    .then(()=>{
        if(this._io.hasAmqp && this._executeQueueName) {
            // amqp is configured and this._executeQueueName is set up
            this._log.info('Listening to the execute queue: ', this._executeQueueName);
            return this._listenExecuteQueue(this._executeQueueName);
        }
        this._log.info('Not Listening to the execute queue.');
    })
    .then(()=>this._server.start());
};


/**
 * rpc GetInitProcessUi (google.protobuf.Empty) returns (ProcessState) {};
 */
_p.getInitProcessUi = function(call, callback) {
    //jshint unused: vars
    // call.request is an Empty

    // FIXME: uiPreInit should be optional and when it's missing we should
    // fail gracefully. Not all conceivable processes need this!

    // This way it can return both: a promise or the ui directly
    return Promise.resolve(this.ProcessConstructor.uiPreInit(this._processResources))
    .then(ui=>{
            var processState = new ProcessState();
            processState.setUserInterface(JSON.stringify(ui));
            callback(null, processState);
        }
      , error=>{
            this._log.error('getInitProcessUi', error);
            callback(error, null);
        }
    );
};

/**
 * see also _p.execute for back-channel considerations
 *
 * FIXME: there's a race condition. *If we want to have only one active
 * process for a family at a time.* (which is not enforced yet).
 * That is: Between the call to initProcess to registering the process
 * as an activeProcess there's plenty time to call initProcess again.
 * Hence, a promise for that process should be stored immediately in
 * initProcess and that should resolve by calling back all requesting calls.
 */
_p.initProcess = function(call, callback) {
    var anyProcessInitMessage = call.request
        //, payload = processInitMessage.getPayload()
        // see cacheClient._getMessageFromAny ...
        // the specific implementation has to define this!
        // including allowed/expected types
        // FIXME: pull any handling from cache client and make it a mixin
        // or internal service, i.e. `this._any._getMessage(any)`!
        //, typeName = any.getTypeName()
        //, Type = this._getTypeForTypeName(typeName)
        //, initArgsMessage = any.unpack(Type.deserializeBinary, typeName)
      , initMessage = this._any.unpack(anyProcessInitMessage)
      ;

    this._examineProcessInitMessage(initMessage)
    .then(([errorMessage, initArgs])=>{
        if(errorMessage)
            throw new Error(errorMessage);
        return this._initProcess(initArgs);
    })
    .then(process=>[process, null], error=>[null, error])
    .then(([process, error])=>{
        var resultMessage = new ProcessCommandResult();
        if(process) {
            resultMessage.setResult(ProcessCommandResult.Result.OK);
            resultMessage.setMessage(process.id);
        }
        else{
            resultMessage.setResult(ProcessCommandResult.Result.FAIL);
            resultMessage.setMessage(error.message);
        }
        callback(null, resultMessage);
    });
};

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
 *      ticket = commandMessage.getTicket()
 *      targetPath = Path.fromString(commandMessage.getTargetPath())
 *      callbackName = commandMessage.getCallbackName()
 *      requester = commandMessage.getRequester()
 *      if(commandMessage.hasJsonPayload())
 *          payload = JSON.parse(commandMessage.getJsonPayload())
 *      else if(commandMessage.hasPbPayload())
 *          anyPayload = commandMessage.getPbPayload() // => Any
 *      else
 *          // though! maybe there is no payload needed, e.g. when
 *          // the message is just something like: "resource ready now".
 *          throw new Error('No Payload');
 */

_p.execute = function(call, callback) {
    var commandMessage = call.request;
    return this._execute(commandMessage, 'grpc')
    .then(result=>{
        var message = new ProcessCommandResult();
        message.setResult(result.status);
        message.setMessage(result.message);
        callback(null, message);
    });
};

_p._consumeExecuteQueue = function(amqpMessage) {
    var arr = new Uint8Array(Buffer.from(amqpMessage.content))
     , commandMessage = ProcessCommand.deserializeBinary(arr)
     ;
    this._io.ackQueueMessage(amqpMessage);
    return this._execute(commandMessage, 'amqp');
};

_p._listenExecuteQueue = function(executeQueueName) {
    return this._io.queueListen(executeQueueName
                                    , this._consumeExecuteQueue.bind(this));
};

_p._execute = function(commandMessage, _via) {
    // aside from the managennet,, queueing etc.
    // it's probably the task of each element in the process hierarchy
    // to check whether the command is applicable or not.
    // so this command trickles down and is checked by each item on it's
    // way …
    var targetPath = Path.fromString(commandMessage.getTargetPath());
    this._log.debug('PM._execute at targetPath:', targetPath, 'via', _via);
    return this._getProcess(targetPath.processId)// => {process, queue}
        .then(({process, queue})=>{
            // Do we need a gate keeper? Are we allowed to perform an action on target?
            // process should be designed in a way, that it doesn't end in a
            // unrecoverable state, i.e. if the state is FUBAR, the process
            // should be marked as failed and don't accept new commands.
            // The implementation of process is intended to take care of
            // this.
            var job = ()=>process.execute(targetPath, commandMessage);
            return queue.schedule(job)
                // on success return promise
                .then(
                    // TODO: the command must be able to return a
                    // human readable message here (and maybe some structured
                    // data, and we'll have to forward it to the back channel
                    // ProcessCommandResult should be extended to have:
                    // always: the status code
                    // maybe: structured data (JSON) (new, we use message for this right now)
                    // maybe: a human readable message
                    (result)=>{
                        return [process, result];
                    }
                  , error=>{
                        this._log.error(error, 'targetPath: ' + targetPath);
                        throw error;
                    }
                )
                // persist after each execute, maybe even after each activate,
                // especially when activate(also error handling in _initProcessWithState)
                // changed the process state, e.g. set it to a finished state.
                .then(([process, result])=>this._persistProcess(process)
                                               .then(()=>[process, result]))
                .then(([process, result])=>{
                    // don't wait for this to finish
                    // should also not return a promise (otherwise, a fail
                    // would create an unhandled promise, and it's not
                    // interesting here to handle that.
                    this._publishUpdates(process);
                    return result;
                })
                ;
        })
        // normalizing the return value
        .then(
            result=>[result, null]
            // if this is a serious problem, we should log it
            // or take care that it has been logged already
          , error=>[null, error]
        )
        .then(([result, error])=>{
            var status, messageStr;
            if(error) {
                this._log.error('PM.execute', error, error.message);
                return {
                    status: ProcessCommandResult.Result.FAIL
                  , message: error.message
                  // original item, only for debugging
                  , _error: error
                };
            }
            if(typeof result === 'object' && 'status' in result) {
                if(result.status in ProcessCommandResult.Result)
                    status = ProcessCommandResult.Result[result.status];
                else {
                    this._log.warning('Result object produced unknown status'
                       , '"'+result.status+'"', 'at targetPath:', targetPath + '.');
                    status = ProcessCommandResult.Result.OK;
                }
                messageStr = result.message;
            }
            else
                status = ProcessCommandResult.Result.OK;

            return {
                status: status
              , message: messageStr || 'Looks good.'
              // original item, only for debugging
              , _result: result
            };
        });
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


_p._getProcessStateForClient = function(process) {
    var processState = new ProcessState();
    processState.setProcessId(process.id);
    // TODO: we wan't some filtering here, e.g. expected answers
    // are not meant to be in the process data visible by the client.
    // An important exception are the user interface requests, but they
    // are separated from the actual process data.
    processState.setProcessData(JSON.stringify(
            process.serialize({filterKeys: new Set(['expectedAnswer'])})
    ));
    processState.setUserInterface(JSON.stringify(process.getRequestedUserInteractions()));
    return processState;
};

_p._addCallToProcessSubscriptions = function(processId, call) {
    var processSubscriptions = this._processSubscriptions.get(processId);
    if(!processSubscriptions){
        processSubscriptions = new Set();
        this._processSubscriptions.set(processId, processSubscriptions);
    }
    processSubscriptions.add(call);
};

_p._removeCallFromProcessSubscriptions = function(processId, call) {
    var processSubscriptions = this._processSubscriptions.get(processId);
    // End the subscription and delete the call object.
    // Do this only once, but, `unsubscribe` may be called more than
    // once, e.g. on `call.destroy` via FINISH, CANCELLED and ERROR.
    if(!processSubscriptions)
        return;
    processSubscriptions.delete(call);
    if(!processSubscriptions.size)
        this._processSubscriptions.delete(processId);
};

_p.getProcess = function(call, callback) {
    var processQuery = call.request
      , processId = processQuery.getProcessId()
      ;
    this._getProcess(processId).then(
        ({process /*, queue*/})=>{
                this._log.debug('got a',  process.constructor.name ,'by id', process.id);
                var processState = this._getProcessStateForClient(process);
                callback(null, processState);
            }
          , error=>{
                this._log.error(error);
                callback(error, null);
            }
        );
};

_p.subscribeProcess = function(call) {

    //this._initProcess().then(process=>{
    //    this._log.debug('new process', process.constructor.name,'id:', process.id);
    //    return  process.id;
    //})
    // 'bd87384a-6f07-4c7f-8605-43cfb2b70d0a' => now becomes a GenericProcess
    // '3b325ffc-d30c-43e2-a273-bf3dabe52645' => added a "family" key to process
    //Promise.resolve('3b325ffc-d30c-43e2-a273-bf3dabe52645')
    //.then(processId=>
    //
    //    this._getProcess(processId).then(
    //        ({process, queue})=>{
    //            this._log.debug('got a process by id', process.constructor.name, process.id);
    //            this._log.debug(JSON.stringify(process.serialize()));
    //        }
    //      , error=>this._log.error(error)
    //    )
    //);

    var processQuery = call.request
      , processId = processQuery.getProcessId()
      , unsubscribe = ()=>{
            this._log.info('subscribeProcess ... UNSUBSCRIBE', processId);
            this._removeCallFromProcessSubscriptions(processId, call);
        }
      ;

    //var dummyUpdates = ()=>{
    //    var counter = 0, maxIterations = 5;//Infinity;
    //    timeout = setInterval(()=>{
    //        this._log.debug('subscribeProcess call.write counter:', counter);
    //        var processState = new ProcessState();
    //        processState.setProcessId(new Date().toISOString());
    //
    //        counter++;
    //        if(counter === maxIterations) {
    //            //call.destroy(new Error('Just a random server fuckup.'));
    //            //clearInterval(timeout);
    //            call.end();
    //        }
    //        else
    //            call.write(processState);
    //
    //    }, 1000);
    //};

    //892fd622-acc2-41c7-b3cb-a9e60f889b09
    this._log.info('processQuery subscribing to', processId);
    this._subscribeCall('process', call, unsubscribe);

    this._getProcess(processId).then(
            ({process /*, queue*/})=>{
                this._log.debug('got a',  process.constructor.name ,'by id', process.id);
                var processState = this._getProcessStateForClient(process);
                // subscribing now in case that maybe, at some point in
                // the future `_getProcess` may cause itself updates
                // to the process (if _loadProcessFromDB fails and
                // changes the process state (to FINISHED?) then maybe
                // a combination of _persistProcess/_publishUpdates
                // would be necessary.
                this._addCallToProcessSubscriptions(process.id, call);
                call.write(processState);
            }
          , error=>{
                this._log.error(error);
                call.destroy(error);
            }
        );

};


