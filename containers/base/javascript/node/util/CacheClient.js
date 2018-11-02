#! /usr/bin/env node
"use strict";
// this is expected to run in nodejs
/* global require */
/* jshint esnext:true */

const { nodeCallback2Promise } = require('./nodeCallback2Promise')
  , grpc = require('grpc')
  , messages_pb = require('protocolbuffers/messages_pb')
  , { CacheItem, Files, File } = messages_pb
  , { CacheClient: GrpcCacheClient } = require('protocolbuffers/messages_grpc_pb')
  , { ProtobufAnyHandler } = require('./ProtobufAnyHandler')
  ;

/**
 * knownTypes: i.e. require('protocolbuffers/messages_pb')
 * typesNamespace: i.e. 'fontbakery.dashboard'
 *
 *
 * new CacheClient(logging, 'localhost', 1234, messages_pb, 'fontbakery.dashboard')
 */
function CacheClient(logging, host, port, knownTypes, typesNamespace, credentials) {
    var address = [host, port].join(':');
    this._logging = logging;
    // in seconds, we use this to get an error when the channel is broken
    // 30 secconds is a lot time, still, under high load I guess this
    // can take some time. 5 seconds was sometimes not enough on my minikube
    // setup.
    // TODO: maybe we can have multiple retries with increasing deadlines
    //       and still fail eventually.
    this._deadline = 30;
    this._logging.info('CacheClient at:', address);
    this._client = new GrpcCacheClient(
                          address
                        , credentials || grpc.credentials.createInsecure()
                        , {
                              'grpc.max_send_message_length': 80 * 1024 * 1024
                            , 'grpc.max_receive_message_length': 80 * 1024 * 1024
                          }
                        );

    this._any = new ProtobufAnyHandler(knownTypes, typesNamespace);
}

var _p = CacheClient.prototype;

_p._raiseUnhandledError = function(err) {
    this._log.error(err);
    throw err;
};

_p._getTypeForTypeName = function(typeName) {
    var name = typeName.split('.').pop();
    if(name in this._knownTypes)
        return this._knownTypes[name];
    this._logging.debug('Unknown type name ', typeName);
    throw new Error('Can\'t find type for type name,');
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

_p.put = function (payloads) {
    this._logging.debug('cache [PUT] with', payloads.length, 'payloads');
    function onData(call, promiseAPI, result, cacheKey) {
        /*jshint validthis: true*/
        result[cacheKey.getClientid()] = cacheKey;
    }

    function onEnd(call, promiseAPI, result) {
        /*jshint validthis: true*/
        promiseAPI.resolve(result);
    }

    function onStatus(call, promiseAPI, status) {
        /*jshint validthis: true*/
        // status is an object with the keys:
        //                      code, details, metadata
        // This is the status that we expect: {code: 0, details: 'OK'}
        // everything else is bad.
        // if onError is triggered, this will not be triggered anymore.
        if (status.code !== grpc.status.OK) {
            this._logging.warning('cache [PUT] on:status', status);
            promiseAPI.reject(status);
        }
    }

    function onError(call, promiseAPI, error) {
        /*jshint validthis: true*/
        this._logging.error('cache [PUT] on:error', error);
        promiseAPI.reject(error);
        call.end();
    }



    function sendMessage(call, result, payload, index) {
        /*jshint validthis: true*/
        var any = this._any.pack(payload)
          , cacheItem = new CacheItem()
          , clientid = '' + index // must be a string for message
          ;
        cacheItem.setPayload(any);
        cacheItem.setClientid(clientid);
        result[clientid] = false;
        call.write(cacheItem);
    }

    return new Promise(function(resolve, reject) {
        var call = this._client.put({deadline: this.deadline})
          , promiseAPI = {resolve: resolve, reject: reject}
          , result = []
          ;
        call.on('data', onData.bind(this, call, promiseAPI, result));
        call.on('end', onEnd.bind(this, call, promiseAPI, result));
        call.on('status', onStatus.bind(this, call, promiseAPI));
        call.on('error', onError.bind(this, call, promiseAPI));
        try {
            payloads.forEach(sendMessage.bind(this, call, result));
        }
        catch(err) {
            reject(err);
        }
        call.end();
    }.bind(this));
};

_p.get = function(cacheKey) {
    var func = this._client.get.bind(this._client);
    return nodeCallback2Promise(func, cacheKey, {deadline: this.deadline})
           .then(any=>this.any.unpack(any))
           .then(null, error=>this._raiseUnhandledError(error))
           ;
};

_p.purge = function(cacheKey) {
    var func = this._client.purge.bind(this._client);
    return nodeCallback2Promise(func, cacheKey, {deadline: this.deadline})
                    .then(null, error=>this._raiseUnhandledError(error))
                    ;
};

_p.waitForReady = function() {
    return new Promise(function(resolve, reject) {
        function cb(error) {
            if(error) reject(error);
            else resolve();
        }
        this._client.waitForReady(this.deadline, cb);
    }.bind(this));
};

exports.CacheClient = CacheClient;

/*
 * Run in one shell the server:
 * $ FONTBAKERY_LOG_LEVEL=DEBUG
 * $ export FONTBAKERY_LOG_LEVEL
 * $ node/CacheServer.js
 *
 * and in another shell the client:
 * $ FONTBAKERY_LOG_LEVEL=DEBUG
 * $ export FONTBAKERY_LOG_LEVEL
 * $ node node/utile/CacheClient.js
 *
 * This client command implementation is just to play around/for quick
 * testing.
 */
if (typeof require != 'undefined' && require.main==module) {
    var { logging } = require('./getSetup').getSetup()
      , client = new CacheClient(logging, 'localhost', 50051
                            , messages_pb, 'fontbakery.dashboard')
      , messages = []
      ;
     for(let i=0;i<10;i++) {
       let file = new File()
         , files = new Files()
         ;
       file.setName('Hello_' + i +'.ttf');
       file.setData(new Uint8Array(Buffer.from('My Data ' + i + ' äöÄ€»«', 'utf8')));
       files.addFiles(file);
       messages.push(files);
     }

     client.put(messages)
         //.then(function(cacheKeys) {
         //    return Promise.all(cacheKeys.map(client.purge, client));
         //})
         //.then(function(responses) {
         //    return responses.map(response => response.toObject());
         //})
         .then(function(cacheKeys) {
             return Promise.all(cacheKeys.map(client.get, client));
         })
         .then(function(messages) {
             return messages.map(message => message.getFilesList().map(file => file.toObject()));
         })
         .then(console.log.bind(console, 'Success'), console.error.bind(console, 'Errrrrr'));
}
