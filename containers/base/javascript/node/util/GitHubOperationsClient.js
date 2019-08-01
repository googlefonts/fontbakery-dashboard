#! /usr/bin/env node
"use strict";
// this is expected to run in nodejs
/* global require */
/* jshint esnext:true */

const { nodeCallback2Promise } = require('./nodeCallback2Promise')
  , grpc = require('grpc')
  , { GitHubOperationsClient: grpcGitHubOperationsClient } = require('protocolbuffers/messages_grpc_pb')
  ;

/**
 * new GitHubOperationsClient(logging, 'localhost', 5678)
 *
 * service GitHubOperations {
 *   rpc Dispatch (PullRequest) returns (google.protobuf.Empty) {};
 * }
 */
function GitHubOperationsClient(logging, host, port, credentials) {
    var address = [host, port].join(':');
    this._log = logging;
    this._deadline = 30;
    this._log.info('GitHubOperationsClient at:', address);
    this._client = new grpcGitHubOperationsClient(
                          address
                        , credentials || grpc.credentials.createInsecure()
                        , {
                              'grpc.max_send_message_length': 80 * 1024 * 1024
                            , 'grpc.max_receive_message_length': 80 * 1024 * 1024
                          }
                        );
}

var _p = GitHubOperationsClient.prototype;
_p.constructor = GitHubOperationsClient;

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

_p.dispatchPullRequest = function(pullRequest) {
    return nodeCallback2Promise((callback)=>
        this._client.dispatchPullRequest(pullRequest, {deadline: this.deadline}, callback))
    .then(null, error=>this._raiseUnhandledError(error));
};

// rpc FileIssue (Issue) returns (GitHubReport) {};
_p.fileIssue = function(issue) {
    return nodeCallback2Promise((callback)=>
        this._client.fileIssue(issue, {deadline: this.deadline}, callback))
    .then(null, error=>this._raiseUnhandledError(error));
};

_p.waitForReady = function() {
    return nodeCallback2Promise((callback)=>
                    this._client.waitForReady(this.deadline, callback))
        .then(null, error=>{throw new Error(this.constructor.name + '' + error);});
};

exports.GitHubOperationsClient = GitHubOperationsClient;

if (typeof require != 'undefined' && require.main==module) {
    throw new Error ('Does not implemented a CLI!');
}
