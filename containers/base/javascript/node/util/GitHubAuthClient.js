#! /usr/bin/env node
"use strict";
// this is expected to run in nodejs
/* global require */
/* jshint esnext:true */

const { nodeCallback2Promise } = require('./nodeCallback2Promise')
  , grpc = require('grpc')
  , { AuthServiceClient: GrpcAuthServiceClient } = require('protocolbuffers/messages_grpc_pb')
  , { Empty } = require('google-protobuf/google/protobuf/empty_pb.js')
  ;

/**
 * new GitHubAuthClient(logging, 'localhost', 5678)
 *
 *
 *   service AuthService {
 *       rpc InitSession (google.protobuf.Empty) returns (AuthStatus) {};
 *       rpc Logout (SessionId) returns (google.protobuf.Empty) {};
 *       rpc Authorize (AuthorizeRequest) returns (AuthStatus) {};
 *       rpc CheckSession (SessionId) returns (AuthStatus) {};
 *   }
 */
function GitHubAuthClient(logging, host, port, credentials) {
    var address = [host, port].join(':');
    this._log = logging;
    this._deadline = 30;
    this._log.info('GitHubAuthClient at:', address);
    this._client = new GrpcAuthServiceClient(
                          address
                        , credentials || grpc.credentials.createInsecure()
                        , {
                              'grpc.max_send_message_length': 80 * 1024 * 1024
                            , 'grpc.max_receive_message_length': 80 * 1024 * 1024
                          }
                        );
}

var _p = GitHubAuthClient.prototype;
_p.constructor = GitHubAuthClient;

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


_p.initSession = function(){
    var message = new Empty();
    return nodeCallback2Promise((callback)=>
        this._client.initSession(message, {deadline: this.deadline}, callback))
    .then(null, error=>this._raiseUnhandledError(error));
};

_p.logout = function(sessionId) {
    return nodeCallback2Promise((callback)=>
        this._client.logout(sessionId, {deadline: this.deadline}, callback))
    .then(null, error=>this._raiseUnhandledError(error));
};

_p.authorize = function(authorizeRequest) {
    return nodeCallback2Promise((callback)=>
        this._client.authorize(authorizeRequest, {deadline: this.deadline}, callback))
    .then(null, error=>this._raiseUnhandledError(error));
};

_p.checkSession = function(sessionId) {
    return nodeCallback2Promise((callback)=>
        this._client.checkSession(sessionId, {deadline: this.deadline}, callback))
    .then(null, error=>this._raiseUnhandledError(error));
};

_p.waitForReady = function() {
    return nodeCallback2Promise((callback)=>
                    this._client.waitForReady(this.deadline, callback))
        .then(null, error=>{throw new Error(this.constructor.name + '' + error);});
};

exports.GitHubAuthClient = GitHubAuthClient;

if (typeof require != 'undefined' && require.main==module) {
    throw new Error ('Does not implemented a CLI!');
}
