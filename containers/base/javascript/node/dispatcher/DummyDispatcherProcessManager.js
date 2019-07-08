#! /usr/bin/env node
"use strict";
/* jshint esnext:true, node:true*/

const grpc = require('grpc')
  , { ProcessManagerService } = require('protocolbuffers/messages_grpc_pb')
  , { Empty } = require('google-protobuf/google/protobuf/empty_pb.js')
  , { ProcessList, ProcessListItem, ProcessState } = require('protocolbuffers/messages_pb')
  ;


function DummyProcessManager(logging, port) {
    this._log = logging;

    this._server = new grpc.Server({
        'grpc.max_send_message_length': 80 * 1024 * 1024
      , 'grpc.max_receive_message_length': 80 * 1024 * 1024
    });

    this._server.addService(ProcessManagerService, this);
    this._server.bind('0.0.0.0:' + port, grpc.ServerCredentials.createInsecure());
}

const _p = DummyProcessManager.prototype;

_p.serve = function() {
    return this._server.start();
};

function TODO(val){ return val;}


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
                            '#' + i + '>>>' + new Date().toISOString());
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
    TODO(processCommand);
    return new Empty();
};

if (typeof require != 'undefined' && require.main==module) {
    var { getSetup } = require('../util/getSetup')
      , setup = getSetup(), processManager, port=50051;

    for(let i=0,l=process.argv.length;i<l;i++) {
        if(process.argv[i] === '-p' && i+1<l) {
            let foundPort = parseInt(process.argv[i+1], 10);
            if(foundPort >= 0) // not NaN or negative
                port = foundPort;
            break;
        }
    }
    setup.logging.info('Init server, port: '+ port +' ...');
    setup.logging.log('Loglevel', setup.logging.loglevel);
    // Combine ProcessManager and the process definition:FamilyPRDispatcherProcess.
    processManager = new DummyProcessManager(setup.logging, port);
    processManager.serve();
}
