#! /usr/bin/env node
"use strict";
/* jshint esnext:true, node:true */

const messages_pb = require('protocolbuffers/messages_pb')
  , { StorageKey } = messages_pb
  , { status: grpcStatus } = require('grpc')
  , fs = require('fs')
  , mime = require('mime')
  , { nodeCallback2Promise } = require('../util/nodeCallback2Promise')
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
    this._app.get('/:storage/:key_extension/:filename', this._browse.bind(this));

    this._dataDir = '/tmp/storage_browse';

    // TODO: garbage collection
    // keep messages in dataDir for 60 min or so, if there was no cache
    // hit in between, delete!
}

const _p = StorageBrowse.prototype;
_p.constructor = StorageBrowse;

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

_p.init = function() {
    return mkdirRecursive(this._dataDir);
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
    }, error=>{
        if(error.code === 'ENOENT')
            return false;
        throw error;// re-raise
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
        return Promise.resolve([
            false, 'Not Found: data has no browsable representation.']);

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
            this._log.debug('StorageBrowse: writing file:', filePath);
            promises.push(mkdirRecursive(fileDirname)
                .then(()=>nodeCallback2Promise(fs.writeFile, filePath, buffer))
                .then(null, error=>{
                    // Exists if there's a race condition.
                    // Should not happen once using AsyncQueue is implemented.
                    if(error.code === 'EEXIST')
                        return;
                    throw error;
                });
            ); // jshint ignore:line
        }
        return Promise.all(promises)
        .then(()=>[true, null]);
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


    var storageClient, key, extension, dirname, filename;

    if(!(req.params.storage in this._storages)) {
        res.status(404)
           .send('Not Found: unknown storage parameter.');
        return;
    }
    storageClient = this._storages[req.params.storage];

    [key, extension] = _parseKeyExt(req.params.key_extension);
    if(extension) {
        res.status(404)
           .send('Not Found: -> extension are not implemented.');
        return;
    }

    // TODO:FIXME: from here on: use asyncQueue for dir name,
    // so we don't have race conditions.

    dirname = path.join(this._dataDir, req.params.storage + '_' + key);
    // FIXME: req.params.filename must not contain ".."
    filename = path.join(dirname, req.params.filename);


    // TODO: we should ask the storage if it "has" the key, otherwise
    // send 404, that way we cannot access files that are cached here
    // but deleted otherwise and "has" is little overhead!

    // just try to send the file now!
    return this._sendFile(filename, res)
    .then(success=>{
        if(success) return;
        // check if this._dataDir/storage_key/ already exists
        return nodeCallback2Promise(fs.stat, dirname)
        .then(stats=> stats.isDirectory()
        , error=>{
            if(error.code === 'ENOENT')
                return false;
            throw error;
        })
        .then(dirExists=>{
            if(dirExists) {
                // we tried to send the file and failed, but the dir existst
                // so the file is not in the message from which the dir was
                // created.
                return [false, '404 File Not Found in directory.'];
            }
            // get the message
            var storageKey = new StorageKey();
            storageKey.setKey(key);
            return storageClient.get(storageKey)
                .then(message=>this._makeMessageDir(req.params.storage+'/'+key
                                                    , message, dirname));
         })
        .then(([success, errorMessage])=>{
            if(!success){
                res.status(404).send(errorMessage);
                return;
            }
            // try to send again
            return this._sendFile(filename, res)
            .then(success=>{
                if(!success)
                    res.status(404).send('404 File Not Found');
                // that's it;
            });
        });
    })
    .then(null, err=> {
       // ... 404 not found OR 500 depends on the message!
       var statusCode = 500
         , message = 'Internal Error'
         ;
       if(err.code === grpcStatus.NOT_FOUND) {
           statusCode = 404;
           message = 'Not Found: ' + err.details;
       }

       this._log.error('browse storage [GET]', req.params.storage
                                               , key, extension, err);
       res.status(statusCode).send(message);
    });
};


module.exports.StorageBrowseService = StorageBrowse;

if (typeof require != 'undefined' && require.main==module) {
    throw new Error ('Does not implemented a CLI!');
}
