#! /usr/bin/env node
"use strict";
// this is expected to run in nodejs
/* global require */
/* jshint esnext:true */

const { nodeCallback2Promise } = require('./nodeCallback2Promise')
  , grpc = require('grpc')
  , { ReportsClient: GrpcReportsClient } = require('protocolbuffers/messages_grpc_pb')
  //, { Empty } = require('google-protobuf/google/protobuf/empty_pb.js')
  ;

/**
 * new ReportsClient(logging, 'localhost', 1234)
 */
function ReportsClient(logging, host, port, credentials) {
    var address = [host, port].join(':');
    this._logging = logging;
    // in seconds, we use this to get an error when the channel is broken
    // 30 secconds is a lot time, still, under high load I guess this
    // can take some time. 5 seconds was sometimes not enough on my minikube
    // setup.
    // TODO: maybe we can have multiple retries with increasing deadlines
    //       and still fail eventually.
    this._deadline = 30;
    this._logging.info('ReportsClient at:', address);
    this._client = new GrpcReportsClient(
                          address
                        , credentials || grpc.credentials.createInsecure()
                        , {
                              'grpc.max_send_message_length': 80 * 1024 * 1024
                            , 'grpc.max_receive_message_length': 80 * 1024 * 1024
                          }
                        );
}

var _p = ReportsClient.prototype;

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

_p.file = function(report) {
    return nodeCallback2Promise((callback)=>
            this._client.file(report, {deadline: this.deadline}, callback))
        .then(null, error=>this._raiseUnhandledError(error));
};

_p._getStream = function(method, message) {
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

_p.query = function(reportsQuery) {
    return this._getStream('query', reportsQuery);
};


_p.get = function(reportIds) {
    return this._getStream('get', reportIds);
};

/**
 * returns a ReportsQuery.Filter describing all possible filters
 * i.e. the value filters have all values set, all date filters are listed
 */
/*
_p.describe = function() {
    return nodeCallback2Promise((callback)=>
            this._client.query(new Empty, {deadline: this.deadline}, callback))
        .then(null, error=>this._raiseUnhandledError(error));
}
*/

_p.waitForReady = function() {
    return nodeCallback2Promise((callback)=>
                    this._client.waitForReady(this.deadline, callback));
};

exports.ReportsClient = ReportsClient;

if (typeof require != 'undefined' && require.main==module) {
    throw new Error ('Does not implemented a CLI!');
}
