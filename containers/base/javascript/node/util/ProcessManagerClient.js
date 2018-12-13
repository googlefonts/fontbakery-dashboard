#! /usr/bin/env node
"use strict";
// this is expected to run in nodejs
/* global require */
/* jshint esnext:true */

const { nodeCallback2Promise } = require('./nodeCallback2Promise')
  , grpc = require('grpc')
  , { ProcessManagerClient: GrpcProcessManagerClient } = require('protocolbuffers/messages_grpc_pb')
  , { ProtobufAnyHandler } = require('./ProtobufAnyHandler')
  , { Empty } = require('google-protobuf/google/protobuf/empty_pb.js')
  ;

/**
 * new ProcessManagerClient(logging, 'localhost', 1234, null, anySetup)
 */
function ProcessManagerClient(logging, host, port, credentials, anySetup) {
    var address = [host, port].join(':');
    this._log = logging;
    // in seconds, we use this to get an error when the channel is broken
    // 30 secconds is a lot time, still, under high load I guess this
    // can take some time. 5 seconds was sometimes not enough on my minikube
    // setup.
    // TODO: maybe we can have multiple retries with increasing deadlines
    //       and still fail eventually.
    this._deadline = 30;
    this._log.info('ProcessManagerClient at:', address);

    this._any = new ProtobufAnyHandler(anySetup.knownTypes, anySetup.typesNamespace);

    this._grpcClientArgs = [
        address
      , credentials || grpc.credentials.createInsecure()
      , {
            'grpc.max_send_message_length': 80 * 1024 * 1024
          , 'grpc.max_receive_message_length': 80 * 1024 * 1024
        }

    ];
    // In a GRPC server I can add many services, but for the client, it
    // seems I have to initialize separate clients.
    this._client = new GrpcProcessManagerClient(...this._grpcClientArgs);
}

var _p = ProcessManagerClient.prototype;

Object.defineProperty(_p, 'statusCANCELLED', {value: grpc.status.CANCELLED});

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
 * Only use this if the expected list is finite, a stream of events may
 * never end! Use _p._readableStreamToGenerator then.
 */
_p._getStreamAsList = function(client, method, message) {
    var METHOD = '[' + method.toUpperCase() + ']';
    return new Promise((resolve, reject) => {
        // Instead of passing the method a request and callback, we pass it
        // a request and get a Readable stream object back.
        var call = client[method](message, {deadline: this.deadline})
          , result = []
          ;

        // The client can use the Readable’s 'data' event to read the server’s responses.
        // This event fires with each Feature message object until there are no more messages.
        // Errors in the 'data' callback will not cause the stream to be closed!
        call.on('data', report=>{
            this._log.debug(METHOD+' receiving a', [report.getType()
                               , report.getTypeId(), report.getMethod()].join(':')
                               , report.hasReported() && report.getReported().toDate()
                               );
            result.push(report);
        });

        // The 'end' event indicates that the server has finished sending
        // and no errors occured.
        call.on('end', ()=>resolve(result));

        // An error has occurred and the stream has been closed.
        call.on('error', error => {
            this._log.error('reports ' + METHOD + ' on:error', error);
            reject(error);
        });

        // Only one of 'error' or 'end' will be emitted.
        // Finally, the 'status' event fires when the server sends the status.
        call.on('status', status=>{
            if (status.code !== grpc.status.OK) {
                this._log.warning('reports ' + METHOD + ' on:status', status);
                // on:error should have rejected already OR on:end already
                // resolved!
                // reject(status);
            }
        });

    });
};


/**
 * Async generator for a subscription.
 */
_p._readableStreamToGenerator = async function* (method, call, bufferMaxSize) { // jshint ignore:line
    var METHOD = '[' + method.toUpperCase() + ']'
        // Buffer will be only needed if messages are incoming faster then
        // they can be consumed, otherwise a "waiting" promise will be
        // available.
        // Only the latest bufferMaxSize_ items are held in buffer
        // defaults to 1, meaning that only the latest message is relevant.
        // This only makes sense if message have no subsequent reference
        // like a series of diffs, and instead represent the complete
        // state at once.
        // Use Infinity if you can't loose any items at all
        // Use one if only the latest incoming item is interesting.
      , bufferMaxSize_ = Math.abs(bufferMaxSize) || 1 // default 1
      , buffer = [] // a FiFo queue
      , waiting = {}
      , setWaitingHandlers = (resolve, reject) => {
            waiting.resolve = resolve;
            waiting.reject = reject;
        }
      , _putMessage = (resolveOrReject, message) => {
            if(!waiting[resolveOrReject]) {
                buffer.push(Promise[resolveOrReject](message));
                let dropped = buffer.splice(0, Math.max(0, buffer.length-bufferMaxSize_));
                if(dropped.length)
                    this._log.debug('Dropped', dropped.length, 'buffer items.'
                                   , 'Buffer size:', buffer.length);
            }
            else
                waiting[resolveOrReject](message);
            waiting.reject = waiting.resolve = null;
        }
      , resolve = message=>_putMessage('resolve', message)
      , reject = error=>_putMessage('reject', error)
      ;

    call.on('data', message=>{
        this._log.debug(METHOD, 'on:DATA', message.toString());
        resolve(message);
    });

    // The 'end' event indicates that the server has finished sending
    // and no errors occured.
    call.on('end', ()=>{
        this._log.debug(METHOD, 'on:END');
        resolve(null);//ends the generator
    });

    // An error has occurred and the stream has been closed.
    call.on('error', error => {
        if(error.code !== grpc.status.CANCELLED)
            // we expect the client to cancel here, don't log.
            this._log.error(METHOD, 'on:ERROR', error);
        reject(error);
    });

    // Finally, the 'status' event fires when the server sends the status.
    call.on('status', status=>{
        this._log.debug(METHOD + ' on:status', status);
    });
    while(true) {
        let value = null
          , promise = buffer.length
                        ? buffer.shift()
                          // If no promise is buffered we're waiting for
                          // new events to come in
                        : new Promise(setWaitingHandlers)
          ;
        value = await promise; // jshint ignore:line
        if(value === null)
            // ended
            break;
        yield value;
    }
}; // jshint ignore:line

_p._getStreamAsGenerator = function(client, method, message) {
    var call = client[method](message, {deadline: Infinity});
    return {
        generator :this._readableStreamToGenerator(method, call)
      , cancel: ()=>call.cancel()
    };
};

_p.subscribeProcess = function(processQuery) {
    return this._getStreamAsGenerator(this._client
                                    , 'subscribeProcess', processQuery);
};

_p.initProcess = function(initMessage) {
    // InitProcess (google.protobuf.Any) returns (ProcessCommandResult)
    var anyInitMessage = this._any.pack(initMessage);
    return nodeCallback2Promise((callback)=>
            this._client.initProcess(anyInitMessage
                                    , {deadline: this.deadline}, callback))
            .then(null, error=>this._raiseUnhandledError(error));
};


_p.getProcess = function(processQuery) {
    // getProcess -> processQuery -> processState
    return nodeCallback2Promise((callback)=>
            this._client.getProcess(processQuery
                                    , {deadline: this.deadline}, callback))
            .then(null, error=>this._raiseUnhandledError(error));
};

_p.getInitProcessUi = function(){
    return nodeCallback2Promise((callback)=>
            this._client.getInitProcessUi(new Empty()
                                    , {deadline: this.deadline}, callback))
            .then(null, error=>this._raiseUnhandledError(error));
};

_p.execute = function(processCommand) {
    return nodeCallback2Promise((callback)=>
            this._client.execute(processCommand
                                    , {deadline: this.deadline}, callback))
        .then(null, error=>this._raiseUnhandledError(error));
};

_p.waitForReady = function() {
    return nodeCallback2Promise((callback)=>
                    this._client.waitForReady(this.deadline, callback));
};

exports.ProcessManagerClient = ProcessManagerClient;

if (typeof require != 'undefined' && require.main==module) {
    throw new Error ('Does not implemented a CLI!');
}
