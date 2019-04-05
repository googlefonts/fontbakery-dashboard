#! /usr/bin/env node
"use strict";
// this is expected to run in nodejs
/* global require */
/* jshint esnext:true */

const { nodeCallback2Promise } = require('./nodeCallback2Promise')
  , grpc = require('grpc')
  , { InitWorkersClient: grpcInitWorkersClient } = require('protocolbuffers/messages_grpc_pb')
  , { pack, unpack } = require('./ProtobufAnyHandler')
  , { WorkerDescription, FamilyJob } = require('protocolbuffers/messages_pb')
  , { Empty } = require('google-protobuf/google/protobuf/empty_pb.js')
  ;

/**
 * new InitWorkersClient(logging, 'localhost', 5678)
 *
 * service InitWorkers {
 *    // the message type of the answer is worker implementation dependent.
 *    rpc Init (WorkerDescription) returns (google.protobuf.Any) {};
 * }
 */
function InitWorkersClient(logging, host, port, credentials) {
    var address = [host, port].join(':');
    this._log = logging;
    this._deadline = 30;
    this._log.info('InitWorkersClient at:', address);
    this._client = new grpcInitWorkersClient(
                          address
                        , credentials || grpc.credentials.createInsecure()
                        , {
                              'grpc.max_send_message_length': 80 * 1024 * 1024
                            , 'grpc.max_receive_message_length': 80 * 1024 * 1024
                          }
                        );
}

var _p = InitWorkersClient.prototype;
_p.constructor = InitWorkersClient;

_p._raiseUnhandledError = function(err) {
    this._log.error(err);
    throw err;
};

Object.defineProperty(_p, 'deadline', {
    get: function() {
        if(this._deadline === Infinity)
            return this._deadline;
        var deadline = new Date();
        deadline.setSeconds(deadline.getSeconds() + this._deadline);
        return deadline;
    }
});

/**
 * rpc Init (WorkerDescription) returns (google.protobuf.Any) {};
 */
_p.init = function(workerDescription) {
    return nodeCallback2Promise((callback)=>
        this._client.init(workerDescription, {deadline: this.deadline}, callback))
    .then(null, error=>this._raiseUnhandledError(error));
};


/**
 * A higher level init with more detailed knowledge.
 */
_p.initialize = function(workerName, initMessage, processCommand/*optional*/) {
    // This setup is kind of annoying.
    var initMessageTypes = {
            'fontbakery': 'StorageKey'
          , 'diffenator': 'StorageKey'
          , 'diffbrowsers': 'StorageKey'
        }
      , answerMessageTypes = {
            'fontbakery': FamilyJob
          , 'diffenator': Empty
          , 'diffbrowsers': Empty
        }
      , workerDescription = new WorkerDescription()
      , any = pack(initMessage, initMessageTypes[workerName])
      ;

    workerDescription.setWorkerName(workerName);
    workerDescription.setJob(any);
    if(processCommand)
        workerDescription.setProcessCommand(processCommand);

    return this.init(workerDescription)
    .then(anyAnswer=>{
        var AnswerType = answerMessageTypes[workerName];
        return unpack(anyAnswer, AnswerType);
    });
};

_p.waitForReady = function() {
    return nodeCallback2Promise((callback)=>
                    this._client.waitForReady(this.deadline, callback))
        .then(null, error=>{throw new Error(this.constructor.name + '' + error);});
};

exports.InitWorkersClient = InitWorkersClient;

if (typeof require != 'undefined' && require.main==module) {
    throw new Error ('Does not implemented a CLI!');
}
