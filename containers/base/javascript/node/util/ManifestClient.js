#! /usr/bin/env node
"use strict";
// this is expected to run in nodejs
/* global require */
/* jshint esnext:true */

const { nodeCallback2Promise } = require('./nodeCallback2Promise')
  , grpc = require('grpc')
  , { ManifestClient: GrpcManifestClient } = require('protocolbuffers/messages_grpc_pb')
  ;

/**
 * new ManifestClient(logging, 'localhost', 9012)
 */
function ManifestClient(logging, host, port, credentials) {
    var address = [host, port].join(':');
    this._log = logging;
    this._deadline = 30;
    this._log.info('ManifestClient at:', address);
    this._client = new GrpcManifestClient(
                          address
                        , credentials || grpc.credentials.createInsecure()
                        , {
                              'grpc.max_send_message_length': 80 * 1024 * 1024
                            , 'grpc.max_receive_message_length': 80 * 1024 * 1024
                          }
                        );
}

var _p = ManifestClient.prototype;
_p.constructor = ManifestClient;

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

//  rpc Poke (ManifestSourceId) returns (google.protobuf.Empty) {};
_p.poke = function(manifestSourceId){
    return nodeCallback2Promise((callback)=>
        this._client.poke(manifestSourceId, {deadline: this.deadline}, callback))
    .then(null, error=>this._raiseUnhandledError(error));
};

//  rpc Get (FamilyRequest) returns (FamilyData){}
_p.get = function(familyRequest, deadline=this.deadline){
    return nodeCallback2Promise((callback)=>
        this._client.get(familyRequest, {deadline: deadline}, callback))
    .then(null, error=>this._raiseUnhandledError(error));
};

_p.getDelayed = function(familyRequest, deadline=this.deadline){
    return nodeCallback2Promise((callback)=>
        this._client.getDelayed(familyRequest, {deadline: deadline}, callback))
    .then(null, error=>this._raiseUnhandledError(error));
};


//  rpc List (ManifestSourceId) returns (FamilyNamesList){}
_p.list = function(manifestSourceId){
    return nodeCallback2Promise((callback)=>
        this._client.list(manifestSourceId, {deadline: this.deadline}, callback))
    .then(null, error=>this._raiseUnhandledError(error));
};

//  rpc GetSourceDetails (FamilyRequest) returns (SourceDetails){}
_p.getSourceDetails = function(familyRequest) {
    return nodeCallback2Promise((callback)=>
        this._client.getSourceDetails(familyRequest, {deadline: this.deadline}, callback))
    .then(null, error=>this._raiseUnhandledError(error));
};


_p.waitForReady = function() {
    return nodeCallback2Promise((callback)=>
                    this._client.waitForReady(this.deadline, callback))
        .then(null, error=>{throw new Error(this.constructor.name + '' + error);});
};

exports.ManifestClient = ManifestClient;

if (typeof require != 'undefined' && require.main==module) {
    throw new Error ('Does not implemented a CLI!');
}
