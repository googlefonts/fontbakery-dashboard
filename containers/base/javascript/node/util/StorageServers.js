#! /usr/bin/env node
"use strict";
/* jshint esnext:true, node:true */

const crypto = require('crypto')
  , path = require('path')
  , fs = require('fs')
  , { nodeCallback2Promise } = require('./nodeCallback2Promise')
  , { AsyncQueue } = require('./AsyncQueue')
  , { StorageService: GRPCStorageService} = require('protocolbuffers/messages_grpc_pb')
  , { StorageStatus, StorageKey } = require('protocolbuffers/messages_pb')
  , { Any } = require('google-protobuf/google/protobuf/any_pb.js')
  , grpc = require('grpc')
  ;

const DataItem = (function() {
function DataItem(data, _reads, _counter, _changed, _instanceKeys) {
    // used for garbage collection
    this._accessed = new Date();
    // used to determine if the items needs to be persisted
    this._changed = _changed !== undefined ? _changed : true;

    // not all implementations store the data here
    this._data = data || null;
    this._counter = _counter || 0;
    this._instanceKeys = new Set(_instanceKeys || []);
    this._reads = _reads || 0;
}
var _p = DataItem.prototype;

_p.accessed = function() {
    this._accessed = new Date();
};

_p.createInstanceKey = function() {
    var instanceKey = (this._counter++).toString(16);
    this._instanceKeys.add(instanceKey);
    this.changed = true;
    this.accessed();
    return instanceKey;
};

_p.destroyInstanceKey = function(subKey) {
    if(this._instanceKeys.delete(subKey)) {
        // only if something really got deleted
        this.changed = true;
        this.accessed();
    }
    return this._instanceKeys.size;
};

_p.hasInstance = function(instanceKey) {
    return this._instanceKeys.has(instanceKey);
};

_p.getData = function(){
    this._reads += 1;
    // changed is set to true because reads changed
    this.changed = true;
    this.accessed();
    return this._data;
};

Object.defineProperties(_p, {
    instances: {
        get: function() {
            return this._instanceKeys.size;
        }
    }
  , lastAccessed: {
        get: function() {
            return this._accessed;
        }
    }
  , reads: {
        get: function() {
            return this._reads;
        }
    }
  , data: {
        get: function() {
            return this.getData();
        }
    }
  , changed: {
        get: function(){
            return this._changed;
        }
      , set: function(val) {
            this._changed = !!val;
        }
    }
});

_p.serialize = function() {
    var object = {
        reads: this._reads
      , counter: this._counter
      , instanceKeys: Array.from(this._instanceKeys)
    };
    if(this._data !== null)
        // must be serializable, currently with JSON.stringify!
        // but only if this feature is used!
        object.data = this._data;
    return object;
};


DataItem.load = function(data){
    return new DataItem(
            data.data
          , data.reads
          , data.counter
          , data.instanceKeys
          , false // don't safe immediateley after load ...
    );
};

return DataItem;
})();


const AbstractStore = (function() {
function AbstractStore(dataItemTimeOutMinutes) {
    this._dataItems = new Map();
    // every 5 minutes
    this._garbageCollectorInterval = 5 * 60 * 1000;

    if(typeof dataItemTimeOutMinutes !== 'number')
        throw new Error('Argument "dataItemTimeOutMinutes" muste be '
            + 'typeof "number" but is "'+(typeof dataItemTimeOutMinutes)+'"');
    // Zero, negative numbers and -Infinity mean basically: delete when
    // the garbage collector comes around, it's not really a practical
    // thing, but at least it's technically possible, maybe someone can
    // use it in development or testing.
    // +Infinity means: never delete my data
    this._dataItemTimeOutMinutes = dataItemTimeOutMinutes > 0
                                        ? dataItemTimeOutMinutes
                                        : 0
                                        ;
    if(dataItemTimeOutMinutes !== Infinity)
        this._scheduleGarbageCollector();
}

const _p = AbstractStore.prototype;

_p.has = function(){
    //jshint unused:vars
    throw new Error('"has" is not implemented');
};

_p.set = function(){
    //jshint unused:vars
    throw new Error('"set" is not implemented');
};

_p.get = function(){
    //jshint unused:vars
    throw new Error('"get" is not implemented');
};

_p.delete = function(){
    //jshint unused:vars
    throw new Error('"delete" is not implemented');
};

_p._dataItemIsTimedOut = function(dataItem) {
    var timeOutDate = new Date();
    timeOutDate.setMinutes(timeOutDate.getMinutes() - this._dataItemTimeOutMinutes);
    return (dataItem.lastAccessed.getTime() - timeOutDate.getTime() < 0);
};

_p._collectGarbage = function(){
    for(let [key, dataItem] of this._dataItems.entries()) {
        if(this._dataItemIsTimedOut(dataItem))
            this._dataItems.delete(key);
    }
};

_p._scheduleGarbageCollector = function() {
    setTimeout(()=>{
        this._collectGarbage();
        // recursive
        this._scheduleGarbageCollector();
    }, this._garbageCollectorInterval);
};

return AbstractStore;
})();


/**
 * dataItemTimeOutMinutes only affects the dataItems in Memory!
 */
const FileSystemStore = (function(){
const Parent = AbstractStore
    , METADATA_FILENAME = 'meta.json'
    , DATA_FILENAME = 'data'
    ;
function FileSystemStore(dataDir, dataItemTimeOutMinutes
                       , serializeData, deserializeData) {
    Object.defineProperty(this, 'isAsync', {value: true});
    this._queues = new Map();
    this._serializeData = serializeData || null;
    this._deserializeData = deserializeData || null;
    this._dataDir = dataDir;
    Parent.call(this, dataItemTimeOutMinutes);
}

const _p = FileSystemStore.prototype = Object.create(Parent.prototype);

/**
 * In this case, the items are still persisted on disk, this is to manage
 * the memory footprint. Items will be reloaded from disk when needed.
 */
_p._collectGarbage = function() {
    for(let [key, dataItem] of this._dataItems.entries()) {
        if(this._queues.has(key))
            // an operation for key is pending, we don't delete it now
            continue;
        if(this._dataItemIsTimedOut(dataItem))
            this._dataItems.delete(key);
    }
};

/**
 * could be:
 * path/{cachKeyHash}/data
 * path/{cachKeyHash}/meta
 *
 * where data is written only once and meta is SSOT in memory and only backed
 * up on disk. A timer based garbage collection can delete the memory entry.
 *
 * We'll do a as path:
 *
 * root/cachKeyHash[0:4]/cachKeyHash[4:8]/cachKeyHash}[6:12]/cachKeyHash[12:]/
 *
 * The key is represented as hexadecimal, hence 4 chars represent 2^16
 * possible directories, which is the max amount of files FAT32 can store
 * in one dir. We're probably using a more potent file system, so this is
 * conservative...
 *
 * For layers deep we get: 2^16 * 2^16 * 2^16 * 2^16 -> 2^64
 * possible entries.
 *
 * > getDirPathParts(digest)
 * [ '0f5c',
 *   '512c',
 *   '7779',
 *   '8eeb751bf68ba2d1de815d10dd921da46c77968c5c16fa645a6f' ]
 * > getDirPathParts(digest).join('') === digest
 * true
 */
function getDirPathParts (key) {
    var result = [], i, l;

    if(typeof key !== 'string' || key.length < 13)
        throw new Error('Key is expected to be a string and at least '
                          + '13 chars in length: "'+key+'"');

    for(i=0,l=3;i<l;i++)
        result.push(key.slice(i*4, i*4+4));
    result.push(key.slice(i*4));
    return result;
}

_p._getPathFromKey = function(key) {
    var keyPathParts = [this._dataDir, ...getDirPathParts(key)];
    return path.join(...keyPathParts);
};

_p._readFile = function(...args) {
    return nodeCallback2Promise(fs.readFile, ...args);
};

_p._writeFile = function(...args) {
    return nodeCallback2Promise(fs.writeFile, ...args);
};

_p._mkDirAndWriteFile = function(filename, buffer) {
    // First create parent dirs if not exising.
    // {recursive: true} Creates /tmp/a/apple, regardless of
    //                   whether `/tmp` and /tmp/a exist.
    var dirname = path.dirname(filename);
    // From node v10.0.something
    //var mkdirRecursive  = dirName=>nodeCallback2Promise(fs.mkdir, dirName, { recursive: true });
    var mkdirForgiveExisting =
        (dirName)=>{
            return nodeCallback2Promise(fs.mkdir, dirName)
            .then(null, error=>{
                if(error.code === 'EEXIST')
                    return;
                throw error;
            });
        }
      , mkdirRecursive = (dir)=>{
            var promise = Promise.resolve(true)
              , currentParts = []
              , pathParts = dir.split(path.sep)
              ;
            if(pathParts[0] === '')
                pathParts[0] = path.sep;
            // builds a promise chain of consecutive calls to mkdir
            for(let part of pathParts) {
                currentParts.push(part);
                let currentPath = path.join(...currentParts);
                promise = promise.then(()=>mkdirForgiveExisting(currentPath)); // jshint ignore:line
            }
            return promise;
        };
    return mkdirRecursive(dirname)
        .then(()=>this._writeFile(filename, buffer));
};

_p._rmDirAndFiles = function(dir) {
    return nodeCallback2Promise(fs.readdir, dir)
    .then(files=>{
        return Promise.all(files.map(
            file=>nodeCallback2Promise(fs.unlink, path.join(dir, file))));
    })
    .then(()=>nodeCallback2Promise(fs.rmdir, dir));
};

_p._queueForKey = function(key) {
    var queue = this._queues.get(key);
    if(!queue) {
        // if queue runs empty after a scheduled job, delete it
        let onRunEmpty=()=>this._queues.delete(key);
        queue = new AsyncQueue(onRunEmpty);
        this._queues.set(key, queue);
    }
    return queue;
};

function _decorateCallToKey(method) {
    return function(key, ...args) {
        //jshint validthis:true
        var job = (key, ...args)=>{
            // call the function
            return method.call(this, key, ...args)
            // after-care:
            .then(result=>{
                // save key/METADATA_FILENAME if necessary
                var dataItem = this._dataItems.get(key)
                  , dir, fileName, data
                  ;
                if(!dataItem || !dataItem.changed)
                    return result;

                dir = this._getPathFromKey(key);
                fileName = path.join(dir, METADATA_FILENAME);
                data = JSON.stringify(dataItem.serialize());
                dataItem.changed = false;
                return this._mkDirAndWriteFile(fileName, data)
                    .then(()=>result);
            });
        };
        return this._queueForKey(key).schedule(job, key, ...args);
    };
}

// we can use this without instanceKey as well, but the common form
// would usually include that instanceKey
_p._has = function(key, instanceKey) {
    var dataItem = this._dataItems.get(key)
      , promise
      ;
    if(dataItem)
        promise = Promise.resolve(dataItem);
    else {
        let dir = this._getPathFromKey(key)
          , fileName = path.join(dir, METADATA_FILENAME)
          ;
        promise = this._readFile(fileName,  'utf8')// -> returns a string
        .then(data=>{
            // dataItem should have a `lastAccessed` property set to `new Date()` now
            dataItem = DataItem.load(JSON.parse(data));
            this._dataItems.set(key, dataItem);
            return dataItem;
        });
    }
    return promise.then(
        dataItem=>instanceKey ? dataItem.hasInstance(instanceKey) : true
      , err=>{
            if(err.code === 'ENOENT')
                return false;
            // could be e.g. EACCES: permission denied
            throw err;
        }
    );
};



// returns a buffer or raises an error
// we could inject a function to wrap the data on get and to
// unwrap the data on put ...
// then we could put and return a pbAny
// also, the data could be cached in memory for some minutes, so this could
// replace the cache service completely, as a hybrid. Though, it's kind
// of nice to be able to reset CacheServer by merely restarting it.
_p._get = function(key, instanceKey) {
    return this._has(key, instanceKey)
    .then(has=>{
        if(!has) {
            var err = new Error('Can\'t find key: ' + key
                            + (instanceKey ? ':'+instanceKey : ''));
            err.name = 'NOT_FOUND';
            throw err;
        }
        var dir = this._getPathFromKey(key)
          , fileName = path.join(dir, DATA_FILENAME)
          ;
        // -> returns a buffer!
        return this._readFile(fileName)
        .then((buffer)=>{
            // touches the accessed date for garbage collection
            // and increases the reads counter, data is not stored by
            // the dataItem, though.
            this._dataItems.get(key).getData();
            return this._deserializeData
                        ? this._deserializeData(buffer)
                        : buffer
                        ;
        }, err=>{
            if(err.code === 'ENOENT') {
                var error = new Error('Can\'t find data file "'+fileName+'".');
                error.name = 'NOT_FOUND';
                throw error;
            }
            // could be e.g. EACCES: permission denied
            throw err;
        });
    });
    // METADATA_FILENAME needs save ...
};

// returns an instanceKey for key
_p._set = function(key, data) {
    return this._has(key)
    .then(has=>{
        if(has)
            return this._dataItems.get(key).createInstanceKey();
        var dir = this._getPathFromKey(key)
          , fileName = path.join(dir, DATA_FILENAME)
          , buffer = this._serializeData
                            ? this._serializeData(data)
                            : data
          ;

        return this._mkDirAndWriteFile(fileName, buffer).then(()=>{
           var dataItem = new DataItem()
             , instanceKey = dataItem.createInstanceKey()
             ;
           this._dataItems.set(key, dataItem);
           return instanceKey;
        });
    });
    // METADATA_FILENAME needs save ...
};

_p._delete = function(key, instanceKey, force) {
    return this._has(key)
    .then(has=>{
        if(!has)
            return 0;
        var dataItem = this._dataItems.get(key)
          , dir
          ;

        // doesn't do anything if instanceKey doesn't exists
        dataItem.destroyInstanceKey(instanceKey);

        if(!force && dataItem.instances !== 0)
            // METADATA_FILENAME needs save ...
            return dataItem.instances;

        // force || dataItem.instances === 0
        dir = this._getPathFromKey(key);
        return this._rmDirAndFiles(dir)
        .then(()=>{
            this._dataItems.delete(key);
            return 0;
        });
    });
    // METADATA_FILENAME needs no save obviously
};

// all operations for a key must be queued and after-cared!
_p.has = _decorateCallToKey(_p._has);
_p.get = _decorateCallToKey(_p._get);
_p.set = _decorateCallToKey(_p._set);
_p.delete = _decorateCallToKey(_p._delete);

return FileSystemStore;
})();


const MemoryStore = (function(){
const Parent = AbstractStore;
function MemoryStore(dataItemTimeOutMinutes) {
    Object.defineProperty(this, 'isAsync', {value: false});
    this._dataItems = new Map();
    // in this case dataItemTimeOutMinutes is a real delete
    // other than in FileSystemStore, where all items are always
    // backed up on disk.
    Parent.call(this, dataItemTimeOutMinutes);
}

const _p = MemoryStore.prototype = Object.create(Parent.prototype);

// we can use this without instanceKey as well, but the common form
// would usually include that instanceKey
_p.has = function(key, instanceKey) {
    var dataItem = this._dataItems.get(key);
    if(!dataItem)
        return false;
    return instanceKey
                ? dataItem.hasInstance(instanceKey)
                : true
                ;
};

// returns a buffer or raises an error
// we could inject a function to wrap the data on get and to
// unwrap the data on put ...
// then we could put and return a pbAny
// also, the data could be cached in memory for some minutes, so this could
// replace the cache service completely.
_p.get = function(key, instanceKey) {
    if(!this.has(key, instanceKey)){
        var err = new Error('Can\'t find key: ' + key
                            + (instanceKey ? ':'+instanceKey : ''));
        err.name = 'NOT_FOUND';
        throw err;
    }
    // Marks data as accessed and changed, changed because
    // of an increase of the read counter. Changed is not important for
    // this implementation, though.
    return this._dataItems.get(key).data;
};

// returns an instanceKey for key
_p.set = function(key, data) {
    var dataItem = this._dataItems.get(key);
    if(!dataItem) {
        dataItem = new DataItem(data);
        this._dataItems.set(key, dataItem);
    }
    return dataItem.createInstanceKey();
};

_p.delete = function(key, instanceKey, force) {
    if(!this.has(key, force ? null : instanceKey))
        return dataItem.instances;

    var dataItem = this._dataItems.get(key);
    // doesn't do anything if instanceKey doesn't exists
    dataItem.destroyInstanceKey(instanceKey);
    if(!force && dataItem.instances !== 0)
        return dataItem.instances;

    // force || dataItem.instances === 0
    this._dataItems.delete(key);
    return 0;
};

return MemoryStore;
})();


/**
 * The actual Service
 */
const StorageService = (function(){
function StorageService(logging, port, storageImplementation) {
    this._log = logging;
    this._data = storageImplementation;
    this._keyLength = 64; // when using sha256 and hash.digest('hex')

    this._server = new grpc.Server({
        'grpc.max_send_message_length': 80 * 1024 * 1024
      , 'grpc.max_receive_message_length': 80 * 1024 * 1024
    });

    this._server.addService(GRPCStorageService, this);
    this._server.bind('0.0.0.0:' + port, grpc.ServerCredentials.createInsecure());
}

var _p = StorageService.prototype;

_p.serve =  function() {
    this._server.start();
};

_p._hash = function(data) {
    var hash = crypto.createHash('sha256');
    hash.update(data);
    return hash.digest('hex');
};

/**
 * Used in the server, where the hash/key is created (in put)
 * and where the hashing/digest is defined
 * and where the key is user input, in FileSystemStore we expect a
 * properly formated key!
 */
_p._checkKey = function(key) {
    var message = null;
    if(typeof key !== 'string')
        message = 'Key data type string expected but got "'
                                       + (typeof key) +'".';
    // for file system paths we may split this key multiple times,
    // this is to make sure it's the expected length.
    // the min-length must be checked where its expected.
    else if(key.length !== this._keyLength)
        //depends on hashing function and digest type
        // sha265 + hexadecimal === 64 chars (32 bit)
        message = 'Key is expected to have a length of '
            + this._keyLength + ' but is actually ' + key.length + ' long';
    // this is important  for e.g. file system path, don't want to have
    // special path chars like '/' injected
    else if(!key.match(/^[a-f0-9]+$/))
       message = 'Key must consist of only a-f and 0-9 hexadecimal chars.';

    return [!message, message];
};

_p.put = function(call) {
    var onPut = (typeUrl, clientId, hash, instanceKey)=>{
            var fullKey = [hash, instanceKey].join(':')
              , storageKey = new StorageKey()
              ;
            this._log.debug('[PUT] key:', fullKey, 'type:', typeUrl);
            // How to handle an error properly? i.e.
            // catch it, send an error message to the client then hang up
            // this kills the server:
            // throw  new Error('Generic error in put on:data');
            // this is a good way to do it, terminates the call, notices the client:
            // call.emit('error',  new Error('Generic error in put on:data'));
            storageKey.setKey(fullKey);
            storageKey.setHash(hash);
            if(clientId)
                storageKey.setClientid(clientId);
            call.write(storageKey);
        }
      , onError = (error)=>{
            this._log.error('[PUT]', error);
        }
      , promises = []
      ;
    call.on('data', function(storageItem) {
        this._log.debug('[PUT] on:data');
        var pbAnyMessage = storageItem.getPayload() // a google.protobuf.Any
          , clientId = storageItem.getClientid()
          , hash = this._hash(pbAnyMessage.serializeBinary())
          , args = [pbAnyMessage.getTypeUrl(), clientId, hash]
          , putResult
          ;

        try {
            // does I/O
            // -> a intanceKey or a a promise
            putResult = this._data.set(hash, pbAnyMessage);
        }
        catch(error) {
            onError(error);
            return;
        }

        if(this._data.isAsync)
            promises.push(
                putResult.then(intanceKey=>onPut(...args, intanceKey), onError)
            );
        else
            onPut(...args, putResult);
    }.bind(this));

    call.on('end', function() {
        // client stopped sending.
        this._log.debug('[PUT] on:end');
        if(this._data.isAsync)
            Promise.all(promises).then(()=>call.end());
        else
            call.end();
    }.bind(this));
};

_p.get = function(call, callback) {
    var fullKey = call.request.getKey() // call.request is a StorageKey
      , [key, instanceKey] = fullKey.split(':')
      , getResult
      , onGet = (message)=>{
            this._log.debug('[GET] key', key, 'is a',  message.getTypeUrl());
            callback(null, message);
        }
      , onError = (error)=>{
            // This is either a problem with the client implementation
            // or the cache was down and lost it's internal state.
            // state is not persistent yet
            if(!('code' in error) && error.name in grpc.status)
                error.code = grpc.status[error.name];
            this._log.error('[GET]', error);
            callback(error, null);
        }
      ;

    // Would need acces to dataItem
    // `reads` could be used to create a cache invalidation scheme
    // where data can only be read a certain number of times.
    // if(dataItem && dataItem.reads >= 3) {
    //     // simulate a cleanupjob, that purged the cache before
    //     // all subjobs could run.
    //     // produces an exception in the report "Can't find key AB123..."
    //     this._purge(key, null, true);
    //     item = undefined;
    // }
    let [valid, message] = this._checkKey(key);
    if(!valid) {
        console.error('!!!!!message', message);
        let error = new Error(message);
        error.name = 'NOT_FOUND';
        onError(error);
        return;
    }
    try {
        // does I/O
        // -> a google.protobuf.Any or a promise
        getResult = this._data.get(key, instanceKey);
    }
    catch(error) {
        onError(error);
        return;
    }

    if(this._data.isAsync)
        getResult.then(onGet, onError);
    else
        onGet(getResult);
};

_p.purge = function(call, callback) {
    var fullKey = call.request.getKey() // call.request is a StorageKey
      , [key, instanceKey] = fullKey.split(':')
      , force = call.request.getForce()
      , purgeResult
      , onPurge = (instances)=>{
            this._log.debug('[PURGE] key', key, 'force', force
                                            , 'instances', instances);
            var cachStatus = new StorageStatus();
            cachStatus.setKey(key);
            cachStatus.setInstances(instances);
            callback(null, cachStatus);
        }
      , onError = (error)=>{
            // This is either a problem with the client implementation
            // or the cache was down and lost it's internal state.
            // state is not persistent yet
            this._log.error('[Purge]', error);
            if(!('code' in error) && error.name in grpc.status)
                error.code = grpc.status[error.name];
            callback(error, null);
        }
      ;
    let [valid, ] = this._checkKey(key);
    if(!valid) {
        // i.e. NOT_FOUND
        onPurge(0);
        return;
    }
    try {
        // -> an interger number of still available instances or a promise
        purgeResult = this._data.delete(key, instanceKey, force);
    }
    catch(error) {
        onError(error);
        return;
    }

    if(this._data.isAsync)
        purgeResult.then(onPurge, onError);
    else
        onPurge(purgeResult);
};

return StorageService;
})();


const CacheServer = (function(){
const Parent = StorageService;
function CacheServer(logging, port, dataItemTimeOutMinutes){
    var storageImplementation = new MemoryStore(dataItemTimeOutMinutes);
    Parent.call(this, logging, port, storageImplementation);
}
CacheServer.prototype = Object.create(Parent.prototype);

return CacheServer;
})();


const PersistenceServer = (function(){
const Parent = StorageService;
function PersistenceServer(logging, port, dataDir, dataItemTimeOutMinutes){
    var serializeData = data=>data.serializeBinary()
      , deserializeData = buffer => Any.deserializeBinary(new Uint8Array(buffer))
      , storageImplementation = new FileSystemStore(
                                      dataDir, dataItemTimeOutMinutes
                                    , serializeData, deserializeData)
      ;
    Parent.call(this, logging, port, storageImplementation);
}
PersistenceServer.prototype = Object.create(Parent.prototype);

return PersistenceServer;
})();

exports.DataItem = DataItem;
exports.AbstractStore = AbstractStore;
exports.MemoryStore = MemoryStore;
exports.FileSystemStore = FileSystemStore;
exports.StorageService = StorageService;
exports.PersistenceServer = PersistenceServer;
exports.CacheServer = CacheServer;
