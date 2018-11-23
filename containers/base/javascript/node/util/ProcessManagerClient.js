#! /usr/bin/env node
"use strict";
// this is expected to run in nodejs
/* global require */
/* jshint esnext:true */

const { nodeCallback2Promise } = require('./nodeCallback2Promise')
  , grpc = require('grpc')
  , { ProcessManagerClient: GrpcProcessManagerClient } = require('protocolbuffers/messages_grpc_pb')
  ;

/**
 * new ProcessManagerClient(logging, 'localhost', 1234)
 */
function ProcessManagerClient(logging, host, port, credentials) {
    var address = [host, port].join(':');
    this._logging = logging;
    // in seconds, we use this to get an error when the channel is broken
    // 30 secconds is a lot time, still, under high load I guess this
    // can take some time. 5 seconds was sometimes not enough on my minikube
    // setup.
    // TODO: maybe we can have multiple retries with increasing deadlines
    //       and still fail eventually.
    this._deadline = 30;
    this._logging.info('ProcessManagerClient at:', address);
    this._client = new GrpcProcessManagerClient(
                          address
                        , credentials || grpc.credentials.createInsecure()
                        , {
                              'grpc.max_send_message_length': 80 * 1024 * 1024
                            , 'grpc.max_receive_message_length': 80 * 1024 * 1024
                          }
                        );
}

var _p = ProcessManagerClient.prototype;

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

_p._getStreamAsList = function(method, message) {
    var METHOD = '[' + method.toUpperCase() + ']';
    return new Promise((resolve, reject) => {
        // Instead of passing the method a request and callback, we pass it
        // a request and get a Readable stream object back.
        var call = this._client[method](message, {deadline: this.deadline})
          , result = []
          ;

        // The client can use the Readable’s 'data' event to read the server’s responses.
        // This event fires with each Feature message object until there are no more messages.
        // Errors in the 'data' callback will not cause the stream to be closed!
        call.on('data', report=>{
            this._logging.debug(METHOD+' receiving a', [report.getType()
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
            this._logging.error('reports ' + METHOD + ' on:error', error);
            reject(error);
        });

        // Only one of 'error' or 'end' will be emitted.
        // Finally, the 'status' event fires when the server sends the status.
        call.on('status', status=>{
            if (status.code !== grpc.status.OK) {
                this._logging.warning('reports ' + METHOD + ' on:status', status);
                // on:error should have rejected already OR on:end already
                // resolved!
                // reject(status);
            }
        });

    });
};


/**
 * crucial for a subscription
 *
 * guess what I want to do is:
 *
 * for await(let process of this._getStreamAsGenerator('subscribeProcess', processQuery))
 *      doSomething(process); // i.e. send it down a socket
 *
 */
_p._getStreamAsGenerator = async function* (method, message) { // jshint ignore:line
    var METHOD = '[' + method.toUpperCase() + ']'
      , call = this._client[method](message, {deadline: Infinity})
      , currentResolve, currentReject
      ;

    // TODO:
    //        * How can the client hang up?
    //        * What happens when the server hangs up?
    //

    call.on('data', message=>{
        this._logging.debug(METHOD, 'receiving a:', message.toString());
        currentResolve(message);
        currentResolve = currentReject = null;
    });

    // The 'end' event indicates that the server has finished sending
    // and no errors occured.
    // => return an ending promises?
    //      OR break the while loop?
    // call.on('end', ()=>resolve(result));

    // An error has occurred and the stream has been closed.
    call.on('error', error => {
        this._logging.error('reports ' + METHOD + ' on:error', error);
        currentReject(error);
        currentResolve = currentReject = null;
    });

    // Only one of 'error' or 'end' will be emitted.
    // Finally, the 'status' event fires when the server sends the status.
    call.on('status', status=>{
        if (status.code !== grpc.status.OK) {
            this._logging.warning('reports ' + METHOD + ' on:status', status);
            // on:error should have rejected already OR on:end already
            // resolved!
            // reject(status);
        }
    });

    // as a Generator, we should return a {value: promise, done: false}
    // whenever gen.next() is called.
    //
    // so, this being a "async generator" the above is happening anyways
    // and all we do is:
    while(true) {
        let promise = new Promise((resolve, reject)=>{ // jshint ignore:line
            currentResolve = resolve;
            currentReject = reject;
        });
        // so we always return a promise here, BUT if the call is ended
        // the promise will never be fullfilled anymore and shouldn't
        // be rejected as well, I guess. So how do we end this generator
        // regularly with an promise being waited for? A falsy value
        // to resolve comes to my mind? a value that is not the expected
        // message.
        //try {
            // await needed here?
            // the function is marked as async already
            // maybe it's just enough to yield the promise directly?
            // and the caller will use await then.
            yield promise; // jshint ignore:line
        //} catch(e) {
        //    console.log(e); // 30
            // should we throw this?
        //    break;
        //}
    }
}; // jshint ignore:line

_p.subscribeProcess = function(processQuery) {
    return this._getStreamAsGenerator('subscribeProcess', processQuery);
};

_p.subscribeProcessList = function(processListQuery) {
    return this._getStreamAsGenerator('subscribeProcessList', processListQuery);
};

_p.execute = function(processCommand) {
    return nodeCallback2Promise((callback)=>
            this._client.execute(processCommand, {deadline: this.deadline}, callback))
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
