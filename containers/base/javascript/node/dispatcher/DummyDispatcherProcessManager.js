#! /usr/bin/env node
"use strict";
/* jshint esnext:true, node:true*/

const grpc = require('grpc')
  , { ProcessManagerService } = require('protocolbuffers/messages_grpc_pb')
  , { Empty } = require('google-protobuf/google/protobuf/empty_pb.js')
  , { ProcessList, ProcessState } = require('protocolbuffers/messages_pb')
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

function identity(val){ return val;}

_p.subscribeProcess = function(call) {
    var processQuery = call.request;
    identity(processQuery);

    this._log.info('processQuery subscribing to', processQuery.getProcessId());
    // FIXME: need to keep call in `subscriptions` structure
    call.on('error', error=>this._log.error(
                            'FIXME ERROR while streaming response:', error));
    call.on('end', ()=>this._log.DEBUG('FIXME: on END: subscribeProcessList'));
    // todo: call.on('end') should cancel the source listener
    var timeout = setInterval(()=>{
        var processState = new ProcessState();
        processState.setProcessId(new Date().toISOString());
        call.write(processState);
    }, 1000);
    identity(timeout);
};

_p.subscribeProcessList = function(call) {
    // var processListQuery = call.request;
    identity(ProcessList);
    call.end();
};

_p.execute = function(processCommand) {
    identity(processCommand);
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
