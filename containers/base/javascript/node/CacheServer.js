#! /usr/bin/env node
"use strict";
// this is expected to run in nodejs
/* global require, module */
/* jshint esnext:true */

const getSetup = require('./util/getSetup').getSetup
  , crypto = require('crypto')
  , grpc = require('grpc')
  , { CacheService } = require('protocolbuffers/messages_grpc_pb')
  , {
        CacheStatus: CacheStatusMessage
      , CacheKey: CacheKeyMessage
    } = require('protocolbuffers/messages_pb')
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
    this._counter = 0;
    this._subKeys = new Set();
    this._reads = 0;
}
var _p = CacheItem.prototype;

_p.createSubKey = function() {
    var subKey = (this._counter++).toString(16);
    this._subKeys.add(subKey);
    return subKey;
};

_p.destroySubKey = function(subKey) {
    this._subKeys.delete(subKey);
    return this._subKeys.size;
};

Object.defineProperty(_p, 'instances', {
    get: function() {
        return this._subKeys.size;
    }
});

Object.defineProperty(_p, 'reads', {
    get: function() {
        return this._reads;
    }
});

Object.defineProperty(_p, 'data', {
    get: function() {
        this._reads += 1;
        return this._data;
    }
});

return CacheItem;
})();

function CacheServer(logging, port) {
    this._logging = logging;
    this._data = new Map();

    this._server = new grpc.Server({
        'grpc.max_send_message_length': 80 * 1024 * 1024
      , 'grpc.max_receive_message_length': 80 * 1024 * 1024
    });

    this._server.addService(CacheService, this);
    this._server.bind('0.0.0.0:' + port, grpc.ServerCredentials.createInsecure());
}

var _p = CacheServer.prototype;

_p.serve =  function() {
    this._server.start();
};

_p._hash = function(data) {
    var hash = crypto.createHash('sha256');
    hash.update(data);
    return hash.digest('hex');
};

_p._put = function(pb_message) {
    var hash = this._hash(pb_message.serializeBinary())
      , key_ = hash
      , item = this._data.get(key_)
      , subKey
      ;
    if(!item) {
        item = new CacheItem(pb_message);
        this._data.set(key_, item);
    }
    subKey = item.createSubKey();
    return [[key_, subKey].join(':'), hash];
};

_p._purge = function(key, force) {
    var keys = key.split(':')
      , key_ = keys[0]
      , subKey = keys[1]
      , item = this._data.get(key_)
      , instances
      ;
    if(!item) return 0;
    if(!force) {
      instances = item.destroySubKey(subKey);
      if (instances)
        return instances;
    }
    this._data.delete(key_);
    return 0;
};

_p._get = function(key) {
    var key_ = key.split(':')[0]
      , item = this._data.get(key_)
      ;
    //if(item && item.reads >= 3) {
    //    // simulate a cleanupjob, that purged the cache before
    //    // all subjobs could run.
    //    // produces an exception in the report "Can't find key AB123..."
    //    this._purge(key);
    //    item = undefined;
    //}
    return item ? item.data : undefined;
};

// Cache.service implementation (public methods ... do we need to .bind(this)?):

_p.put = function(call) {
    call.on('data', function(cacheItem) {
        var message = cacheItem.getPayload() // a CacheItemMessage
          , [key, hash] = this._put(message)
          , cacheKey = new CacheKeyMessage()
          , clientId = cacheItem.getClientid()
          ;
        this._logging.debug('[PUT] on:data key', key, 'is a', message.getTypeUrl());
        // How to handle an error properly? i.e.
        // catch it, send an error message to the client then hang up
        // this kills the server:
        // throw  new Error('Generic error in put on:data');
        // this is a good way to do it, terminates the call, notices the client:
        // call.emit('error',  new Error('Generic error in put on:data'));

        cacheKey.setKey(key);
        cacheKey.setHash(hash);
        if(clientId)
            cacheKey.setClientid(clientId);
        call.write(cacheKey);
    }.bind(this));

    call.on('end', function() {
        // client stopped sending.
        this._logging.debug('[PUT] on:end');
        call.end();
    }.bind(this));
};

_p.get = function(call, callback) {
    var key = call.request.getKey() // call.request is a CacheKey
      , message = this._get(key) || null
      , err = null
      ;
    if(!message) {
        err = new Error('Can\'t find key ' + key + '.');
        err.name = 'NOT_FOUND';
        // This is either a problem with the client implementation
        // or the cache was down and lost it's internal state.
        // state is not persistent yet
        this._logging.error('[GET]', err);
    }
    else
        this._logging.debug('[GET] key', key, 'is a',  message.getTypeUrl());
    callback(err, message);
};

_p.purge = function(call, callback) {
    var key = call.request.getKey() // call.request is a CacheKey
      , force = call.request.getForce()
      , instances = this._purge(key, force)
      , cachStatus = new CacheStatusMessage()
      ;
    this._logging.debug('[PURGE] key', key, 'force', force
                                            , 'instances', instances);
    cachStatus.setKey(key);
    cachStatus.setInstances(instances);
    callback(null, cachStatus);
};

exports.CacheServer = CacheServer;

if (typeof require != 'undefined' && require.main==module) {
    var setup = getSetup(), cacheServer, port=50051;

    for(let i=0,l=process.argv.length;i<l;i++) {
        if(process.argv[i] === '-p' && i+1<l) {
            let foundPort = parseInt(process.argv[i+1], 10);
            if(foundPort >= 0) // not NaN or negative
                port = foundPort;
            break;
        }
    }
    setup.logging.info('Init server, port: '+ port +' ...');
    setup.logging.log('Loglevel', setup.logging.loglevel);
    cacheServer = new CacheServer(setup.logging, port);
    cacheServer.serve();
}
