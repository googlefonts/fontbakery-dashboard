#! /usr/bin/env node
"use strict";
/* jshint esnext:true, node:true */

const messages_pb = require('protocolbuffers/messages_pb')
  , { StorageKey } = messages_pb
  , { status: grpcStatus } = require('grpc')
  , fs = require('fs')
  , mime = require('mime')
  , { nodeCallback2Promise } = require('../util/nodeCallback2Promise')
  , { AsyncQueue } = require('../util/AsyncQueue')
  , path = require('path')
  ;

/**
 * TODO:
 * It would be nice to add a kind of generic protocolbuffer inspector.
 * Known special types, like files etc. can be treated as now.
 * If a message like FamilyData has a Files/File or repeated File entry
 * that should be made available automatically.
 * Should work with nested messages.
 *
 * Eventually I think StorageDowload could be consolidated whith this.
 */
function StorageBrowse(server, app, logging, storages /* { e.g.: cache, persistence } */) {
    this._server = server;
    this._app = app;// === express()
    this._log = logging;
    this._storages = storages;
    this._knownTypes = messages_pb;
    this._dataDir = '/tmp/storage_browse';

    this._messageRequests = new Map();
    this._queues = new Map();

    this._app.get('/:storage/:key_extension/:filename', this._browse.bind(this));

    // garbage collection
    // keep messages in dataDir for 60 min or so, if there was no cache
    // hit in between, delete!

    // every 5 minutes
    this._garbageCollectorInterval = 5 * 60 * 1000;

    var dataItemTimeOutMinutes = 60;
    // If dataItemTimeOutMinutes becomes an argument/configurable we got
    // sanity checks built in.
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

const _p = StorageBrowse.prototype;
_p.constructor = StorageBrowse;

_p.init = function() {
    return mkdirRecursive(this._dataDir);
};

function mkdirRecursive(dirname) {
    // First create parent dirs if not exising.
    // {recursive: true} Creates /tmp/a/apple, regardless of
    //                   whether `/tmp` and /tmp/a exist.
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
    return mkdirRecursive(dirname);
}

_p._itemIsTimedOut = function(lastAccessed) {
    var timeOutDate = new Date();
    timeOutDate.setMinutes(timeOutDate.getMinutes() - this._dataItemTimeOutMinutes);
    return (lastAccessed.getTime() - timeOutDate.getTime() < 0);
};

_p._rmDirRecursive = function(dir) {
    return nodeCallback2Promise(fs.readdir, dir, {withFileTypes: true})
    .then(entries=>{
        var promises = [];
        for(let entry of entries) {
            let entryPath = path.join(dir, entry.name);
            if(entry.isDirectory())
                promises.push(this._rmDirRecursive(entryPath));
            else if(entry.isFile())
                promises.push(nodeCallback2Promise(fs.unlink, entryPath));
            else
                // likely fs.rmdir will fail!
                this._log.warning('Can\'t remove entry "'+entry.name+'"'
                                , 'of directory "'+dir+'" because it is'
                                , 'neither a regular file nor a directory:'
                                , entry);
        }
        return Promise.all(promises);
    })
    .then(()=>nodeCallback2Promise(fs.rmdir, dir));
};

_p._checkGarbage = function(messageId) {
    var directory = path.join(this._dataDir, messageId);
    return this._getDirAccessTime(directory)
    .then(lastAccessed=>this._itemIsTimedOut(lastAccessed))
    .then(timedOut=>{
        if(timedOut){
            this._log.info('Removing timed out message cache: "'+messageId+'".');
            return this._rmDirRecursive(directory);
        }
        else
            this._log.debug('Message cache is fresh for: "'+messageId+'".');
    });
};

_p._getQueue = function(key) {
    var queue = this._queues.get(key);
    if(!queue) {
        // if queue runs empty after a scheduled job, delete it
        let onRunEmpty=()=>this._queues.delete(key);
        queue = new AsyncQueue(onRunEmpty);
        this._queues.set(key, queue);
    }
    return queue;
};

_p._collectGarbage = function() {
    return nodeCallback2Promise(fs.readdir, this._dataDir, {withFileTypes: true})
    .then(entries=>{
        var promises = [];
        for(let entry of entries) {
            if(!entry.isDirectory()) {
                // unexpected, should be investigated
                this._log.warning('Entry "'+entry.name+'" is not a directory'
                                , 'in: ', this._dataDir);
                continue;
            }
            let messageId = entry.name
              , promise
              ;
            promise = this._getQueue(messageId)
            .schedule(this._checkGarbage.bind(this), messageId)
            .then(null, error=>{// jshint ignore:line
                if(error.code === 'ENOENT')
                    return;
                this._log.error('Can\'t checkGarbage for'
                                            , '"'+messageId+'":', error);
            });
            promises.push(promise);
        }
        return Promise.all(promises);
    });
};

_p._scheduleGarbageCollector = function() {
    setTimeout(()=>{
        this._collectGarbage();
        // recursive
        this._scheduleGarbageCollector();
    }, this._garbageCollectorInterval);
};

_p._accessedFileName = function(dirname) {
    // Using two dots because that's an "illegal" filename to query.
    // and it's super uncommon. If that is not good enough, putting the
    // file somewhere outside of the directory would be a more solid solution.
    return path.join(dirname, '..accessed');
};

_p._touchDir = function(dirname) {
    var file = this._accessedFileName(dirname)
      , timestamp = new Date().toISOString()
      ;
    return nodeCallback2Promise(fs.writeFile, file, timestamp);
};

_p._getDirAccessTime = function(dirname) {
    var file = this._accessedFileName(dirname);
    return nodeCallback2Promise(fs.readFile, file, 'UTF-8')
    .then(
        str=>{
            var d = new Date(str);
            return isNaN(d.getTime()) ? new Date(0) : d;
        }
      , (/*err*/)=>new Date(0)
    );
};

function _parseKeyExt(keyExt) {
    var dotPos = keyExt.indexOf('.')
      , key, ext
      ;
    if(dotPos === -1) {
        key = keyExt;
        ext = null;
    }
    else {
        key = keyExt.slice(0, dotPos);
        ext = keyExt.slice(dotPos+1);
    }
    return [key, ext];
}

function getTypeName(knownTypes, message) {
    // as in protobufAnyHandler.getTypeNameForMessage(message)
    for(let [typeName, Ctor] of Object.entries(knownTypes) ) {
        if(message instanceof Ctor)
            return typeName;
    }
    return null;
}

/**
 * return true on success
 * false if file does not exist
 * raise otherwise
 */
_p._sendFile = function(filename, res) {
    return nodeCallback2Promise(fs.readFile, filename)
    // .then(buffer=>resolve(new Uint8Array(buffer)), reject);
    .then(data=>{
        let contentType = mime.getType(filename);
        if(contentType) {
            let charset = null;
            if(contentType.indexOf('text/') === -1)
                charset = 'UTF-8';
            res.setHeader('Content-Type', contentType + (charset ? '; charset=' + charset : ''));
        }
        res.send(data);
        return true;
    });
};


_p._makeMessageDir = function(messageId, message, directory) {
    // if applicable, dump its files into this._dataDir/storage_key/ ...
    // right now we only do flat structures, no nested files
    // so we won't create subdirs and fail if asked to. But, this could
    // become the swiss army knife of message inspection.
    var typeName = getTypeName(messages_pb, message)
      , files
      ;
    this._log.debug('getTypeName returned', typeName);
    if(typeName === 'Files')
        files = message.getFilesList();
    else if(typeName === 'File')
        files = [message];
    else
        throw new Error('Not Found: data type "'+typeName+'" of message '
                    + '"'+messageId+'" has no browsable representation.');

    return mkdirRecursive(directory)
    .then(()=>{
        // copy files to disk
        var promises = [];
        for(let file of files) {
            // NOTE: using `let` is really important in this loop!
            let filename = file.getName()
              , filePath = path.join(directory, filename)
              , fileDirname = path.dirname(filePath)
              , buffer
              ;
            if(filename.indexOf('..') !== -1) {
                let message = 'Invalid filename "' + filename + '" '
                        + 'in message "'+messageId+'"';
                this._log.error(message);
                // rejecting completely seems too much, other files
                // could still be accessible.
                // promises.push(Promise.reject(new Error(message)));

                //always continue
                continue;
            }
            buffer = Buffer.from(file.getData_asU8());
            this._log.debug('StorageBrowse: writing'
                                    , 'file:', '"'+filePath+'"'
                                    , 'of message', '"'+messageId+'"');
            promises.push(mkdirRecursive(fileDirname)
                .then(()=>nodeCallback2Promise(fs.writeFile, filePath, buffer)) // jshint ignore:line
                .then(null, error=>{// jshint ignore:line
                    // Exists if there's a race condition.
                    // Should not happen once using AsyncQueue is implemented.
                    if(error.code !== 'EEXIST')
                        // someone should have a look
                        this._log.error('Can\'t create'
                                    , 'file:', '"'+filePath+'"'
                                    , 'of message', '"'+messageId+'"'
                                    , ':', error);
                })
            );
        }
        return Promise.all(promises).then(()=>true);
    });
};

/**
 * GET
 */
_p._browse = function(req, res, next) {
    // jshint unused:vars


    // else:
    // get the message
    //     if applicable, dump it's files into this._dataDir/storage_key/ ...
    //     right now we only do flat structures, no nested files
    //     so we won't create subdirs and fail if asked to. But, this could
    //     become the swiss army knife of message inspection.
    // check if the file exists
    // touch the garbage collection accessed date
    // serve the file, with the right MIME type


    var messageId, storageKey, extension;
    if(!(req.params.storage in this._storages)) {
        res.status(404)
           .send('Not Found: unknown storage parameter "'+req.params.storage+'".');
        return;
    }

    [storageKey, extension] = _parseKeyExt(req.params.key_extension);
    if(extension) {
        res.status(404)
           .send('Not Found: -> extension are not implemented.');
        return;
    }

    if(req.params.filename.indexOf('..') !== -1) {
        res.status(404)
           .send('Not Found: ".." is not allowed in filename: "'+req.params.filename+'".');
        return;
    }


    // TODO:FIXME: from here on: use asyncQueue for dir name,
    // so we don't have race conditions when creating/deleting message dirs

    messageId = [req.params.storage, req.params.key_extension].join('_');


    // sendFile before could speed up delivery of existing files tremendously!
    // especially paralell requests for the same message would not have to
    // be answered one after another!
    //
    // to make things more efficient, in this scenario, all requests to one message
    // could be collected, the message could be fetched, then a sendFile
    // for each request could be dispatched...
    //
    // how do we know the message exists?
    // that'sbasically the main question the queue should answer.
    // A requets comes in
    //      * create a queued get-job that answers *all* requests for the queue
    //        when fetching or failing to fetch the message has been done.
    //      * add request to get-job data
    // A new request comes in, there is an actual get-job waiting in queue
    //      * add request to get-job data
    // when get-job is done, sendFile all requests, if at least one
    // is successfully sent (not 404 or such), touch the accessed date of
    // the message (array.some(success=>success)?? || Promise.race()??)

    var needsQueue = false
      , requests = this._messageRequests.get(messageId)
      ;
    if(!requests || !requests.length) {
        needsQueue = true;
        requests = [];
        this._messageRequests.set(messageId, requests);
    }

    // Pushing before scheduling the job, because it would
    // start immediately if the queue is empty.
    requests.push([res, req.params.filename]);

    if(!needsQueue)
        return;
    this._getQueue(messageId).schedule(this._checkMessage.bind(this), req.params.storage, storageKey, messageId);
};

/**
 * This must be run in an AsyncQueue for, so that there's no race condition.
 *
 *
 */
_p._checkMessage = function(storage, storageKey, messageId) {
    var dirname = path.join(this._dataDir, messageId);

    // TODO: we should ask the storage if it "has" the key, otherwise
    // send 404, that way we cannot access files that are cached here
    // but deleted otherwise and "has" is little overhead!

    // check if this._dataDir/messageId/ already exists
    return nodeCallback2Promise(fs.stat, dirname)
    .then(stats=>{
        if(!stats.isDirectory())
            throw new Error('A file system entry "' + dirname + '" '
                            + 'exist, but is not a directory.');
        return true;
    }
    , error=>{
        if(error.code !== 'ENOENT')
            throw error;
        return false;
    })
    .then(dirExists=>{
        if(dirExists)
            return true; // just try to send the files
        // get the message
        var storageKeyMessage = new StorageKey();
        storageKeyMessage.setKey(storageKey);
        return this._storages[storage].get(storageKeyMessage)
            .then(message=>this._makeMessageDir(
                                       messageId, message, dirname));
     })
    .then(()=>{
        var requests = this._messageRequests.get(messageId)
          , request
          ;
        // Consume requests using shift() so we don't handle them in
        // the catch handler below if we end there.
        while((request = requests.shift())) {
            let [res, filename] = request
              , filepath = path.join(dirname, filename);
            this._sendFile(filepath, res)
            .then(null, error=>{// jshint ignore:line
                if(error.code === 'ENOENT')
                    res.status(404).send('404 File Not Found');
                else {
                    this._log.error('Sending file "'+filepath+'" failed:', error);
                    res.status(500).send('Internal Server Error:' + error);
                }
            });
        }
        this._messageRequests.delete(messageId);
        // Mark as accessed for garbage collector/cache invalidation.
        return this._touchDir(dirname);
    })
    .then(null, err=> {
        // ... 404 not found OR 500 depends on the message!
        var statusCode = 500
          , message = 'Internal Error'
          , requests = this._messageRequests.get(messageId) || []
          ;
        if(err.code === grpcStatus.NOT_FOUND) {
            statusCode = 404;
            message = 'Not Found: ' + err.details;
        }
        else
            this._log.error('browse storage [GET]', messageId, err);

        for(let [res, /*filename*/] of requests)
            res.status(statusCode).send(message);
        this._messageRequests.delete(messageId);

        //if(statusCode === 500)
        // should probably clean up directory ... ???
    });
};


module.exports.StorageBrowseService = StorageBrowse;

if (typeof require != 'undefined' && require.main==module) {
    throw new Error ('Does not implemented a CLI!');
}
