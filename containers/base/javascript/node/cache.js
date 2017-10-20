#! /usr/bin/env node
"use strict";
// this is expected to run in nodejs
/* global require, module */
/* jshint esnext:true */

const getSetup = require('./util/getSetup').getSetup
  , crypto = require('crypto')
  , grpc = require('grpc')
  , messages_pb = require('protocolbuffers/messages_pb')
  , services_pb = require('protocolbuffers/messages_grpc_pb')
  , CacheService = services_pb.CacheService
  , CacheKeyMessage = messages_pb.CacheKey
  , CacheStatusMessage = messages_pb.CacheStatus
  ;

/**
What we want:

A) POST Files: returns an identifier where to GET Files
B) GET Files:
C) PURGE Files

use gRPC

Files is one "Family" of TTF files and metadata. Ideally we don't even look into the serialized message

There's probably a client-id in this message, so that the client can identify the answer
I guess gRPC has something buildin for us ;-)

Post Files can actually post a stream of files, which will conclude a whole collection
The answer then is a stream of identifiers that can be used to GET or PURGE the files

If you post the same Files twice, you got to PURGE the same file twice (unless force===true)

TODO: let's say a job died and is never going to PURGE. We need some
automatic cache invalidation (time based?), maybe pick something from
here: https://en.wikipedia.org/wiki/Cache_replacement_policies

TODO: paralell cache instances, that talk to each other for replcation
      if speed or memory size becomes a problem?

TODO: some form of persistence, if the pod dies, so that the cache still
      has it's state after bein up again.
*/
const CacheItem = (function() {
function CacheItem(data) {
    this._data = data;
    this._instances = 1;
}
var _p = CacheItem.prototype;

_p.increment = function() {
    this._instances += 1;
    return this._instances;
};

_p.decrement = function() {
    if(this._instances > 0)
        this._instances -= 1;
    else
        this._instances = 0;
    return this._instances;
};

Object.defineProperty(_p, 'instances',{
    get: function() {
        return this._instances;
    }
});

return CacheItem;
})();

function Cache(logging, port) {
    this._logging = logging;
    this._data = new Map();
    this._server = new grpc.Server();
    this._server.addService(CacheService, this);
    this._server.bind('0.0.0.0:' + port, grpc.ServerCredentials.createInsecure());
}

var _p = Cache.prototype;

_p.serve =  function(){
    this._server.start();
};

_p._hash = function(data) {
    var hash = crypto.createHash('sha256');
    hash.update(data);
    return hash.digest('hex');
};

_p._put = function(pb_message) {
    var key = this._hash(pb_message.serializeBinary())
      , item = this._data.get(key)
      ;
    if(!item) {
        item = new CacheItem(pb_message);
        this._data.set(key, item);
    }
    else
        item.increment();
    return key;
};

_p._purge = function(key, force) {
    var item = this._data.get(key)
      , instances
      ;
    if(!item) return 0;
    if(!force) {
      instances = item.decrement();
      if (instances)
        return instances;
    }
    this._data.delete(key);
    return 0;
};

_p._get = function(key) {
    return this._data.get(key);
};

// Cache.service implementation (public methods ... do we need to .bind(this)?):

_p.put = function(call) {
    this._logging.debug('put started');
    call.on('data', function(cacheItem) {
        this._logging.debug('put on:data', cacheItem.toObject());
        var message = cacheItem.getPayload() // a CacheItemMessage
          , key = this._put(message)
          , cacheKey = new CacheKeyMessage()
          , clientId = cacheItem.getClientid()
          ;

        cacheKey.setKey(key);
        if(clientId)
            cacheKey.setClientid(clientId);
        this._logging.debug('put on:data response', cacheKey.toObject());
        call.write(cacheKey);
    }.bind(this));
    call.on('end', function() {
        // client stopped sending.
        this._logging.debug('put on:end');
        call.end();
    });
};

_p.get = function(call, callback) {
    this._logging.debug('get', call.request.toObject());
    var key = call.request.key // call.request is a CacheKey
      , response = this._get(key) || null
      , err = null
      ;
    if(!response) {
        err = new Error('Can\'t find key "' + key + '".');
        err.name = 'NOT_FOUND';
        this._logging.debug('get', err);
    }
    callback(err, response);
};

_p.purge = function(call, callback) {
    this._logging.debug('purge', call.request.toObject());
    var key = call.request.getKey() // call.request is a CacheKey
      , force = call.request.getForce()
      , instances = this._purge(key, force)
      , response = new CacheStatusMessage()
      ;
    response.setKey(key);
    response.setInstances(instances);
    this._logging.debug('purge response:', response.toObject());
    callback(null, response);
};

if (typeof require != 'undefined' && require.main==module) {
    var setup = getSetup(), cache, port=50051;

    for(let i=0,l=process.argv.length;i<l;i++) {
        if(process.argv[i] === '-p' && i+1<l) {
            let foundPort = parseInt(process.argv[i+1], 10);
            if(foundPort >= 0) // not NaN or negative
                port = foundPort
            break;
        }
    }

    setup.logging.info('Init server, port: '+ port +' ...');
    setup.logging.debug('Loglevel DEBUG');
    cache = new Cache(setup.logging, port);
    cache.serve();
}
