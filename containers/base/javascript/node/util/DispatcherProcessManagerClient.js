#! /usr/bin/env node
"use strict";
// this is expected to run in nodejs
/* global require */
/* jshint esnext:true */

const { nodeCallback2Promise } = require('./nodeCallback2Promise')
  , { ProcessManagerClient:Parent } = require('./ProcessManagerClient')
  , { DispatcherProcessManagerClient: GrpcDispatcherProcessManagerClient
                        } = require('protocolbuffers/messages_grpc_pb')
  ;

/**
 * new DispatcherProcessManagerClient(logging, 'localhost', 1234)
 */
function DispatcherProcessManagerClient(...args) {
    Parent.call(this, ...args);
    // In a GRPC server I can add many services, but for the client, it
    // seems that I have to initialize separate clients.
    this._clientDispatcher = new GrpcDispatcherProcessManagerClient(...this._grpcClientArgs);
}

var _p = DispatcherProcessManagerClient.prototype = Object.create(Parent.prototype);

_p.subscribeProcessList = function(processListQuery) {
    return this._getStreamAsGenerator(this._clientDispatcher
                            , 'subscribeProcessList', processListQuery);
};

_p.waitForReady = function() {
    return Promise.all([
        Parent.prototype.waitForReady.call(this)
      , nodeCallback2Promise((callback)=>
                    this._clientDispatcher.waitForReady(this.deadline, callback))
    ]);
};

exports.DispatcherProcessManagerClient = DispatcherProcessManagerClient;

if (typeof require != 'undefined' && require.main==module) {
    throw new Error ('Does not implemented a CLI!');
}
