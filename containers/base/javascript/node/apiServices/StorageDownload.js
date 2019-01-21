#! /usr/bin/env node
"use strict";
/* jshint esnext:true, node:true */

const yazl = require('yazl')
  , messages_pb = require('protocolbuffers/messages_pb')
  , {StorageKey, File, Files} = messages_pb
  , { status: grpcStatus } = require('grpc')
  ;

/**
 *
 */
function StorageDownload(server, app, logging, storages /* { e.g.: cache, persistence } */) {
    this._server = server;
    this._app = app;// === express()
    this._log = logging;
    this._storages = storages;
    this._knownTypes = messages_pb;
    this._app.get('/:storage/:key_extension', this._download.bind(this));
}

const _p = StorageDownload.prototype;
_p.constructor = StorageDownload;

function _parseKeyExt(keyExt){
    var dotPos = keyExt.indexOf('.')
      , key, ext
      ;
    if(dotPos === -1)
        return [null, null, 'Extension not found'];
    key = keyExt.slice(0, dotPos);
    ext = keyExt.slice(dotPos+1);
    // more checks?
    return [key, ext, null];
}


function getZipableTypeName(message) {
    var zippableTypes = { file: File, files: Files };
    return getTypeName(zippableTypes, message);
}
function getTypeName(knownTypes, message) {
    // as in protobufAnyHandler.getTypeNameForMessage(message)
    for(let [typeName, Ctor] of Object.entries(knownTypes) ) {
        if(message instanceof Ctor)
            return typeName;
    }
    return null;
}

function _zipAndSendMessage(res, message, filename) {
    res.setHeader('Content-Type', 'application/zip');
    // mark as downloadable file
    res.setHeader('Content-Disposition'
                            , 'attachment; filename=' + filename);
    var zipfile = new yazl.ZipFile()
      , files
      ;

    if(message instanceof Files)
        files = message.getFilesList();
    else
        // getName and getData_asU8 are expected
        files = [message];

    for(let file of files)
        zipfile.addBuffer(Buffer.from(file.getData_asU8()), file.getName());

    zipfile.outputStream.pipe(res);
    zipfile.end();
}

/**
 * GET
 *
 */
_p._download = function(req, res, next) {
    // jshint unused:vars
    var storage, errorMessage, key, extension, filename
      , storageKey, typeName, contentType, data;

    if(!(req.params.storage in this._storages)) {
        res.status(404)
           .send('Not Found: unknown storage parameter.');
        return;
    }
    storage = this._storages[req.params.storage];

    [key, extension, errorMessage] = _parseKeyExt(req.params.key_extension);
    if(errorMessage) {
        res.status(404)
           .send('Not Found: -> ' + errorMessage);
        return;
    }
    filename = key + '.' + extension;

    storageKey = new StorageKey();
    storageKey.setKey(key);
    storage.get(storageKey).then(
        message=>{
            // extensions:
            if(extension === 'zip') {
                // => zipapble [File, Files] => needs a getTypeNameForMessage
                //    but for the zip, we also need to decide if the message
                //    is a Files or a File in order to treat it right.
                typeName = getZipableTypeName(message);
                if(!typeName) {
                    res.status(404)
                       .send('Not Found: data has no zip representation.');
                    return;
                }
                contentType = 'application/zip';
                // is sent none-blocking and as a stream
                _zipAndSendMessage(res, message, filename);
                return;
            }
            else if(extension === 'proto.bin') {
                contentType = 'application/octet-stream';
                data =  Buffer.from(message.serializeBinary());
            }
            else if(extension === 'proto') {
                contentType = 'text/plain';
                // => text format: compare with  getMetaDataPB, we'd have to use
                // a python process to generate the text format file!
                // python >>> from google.protobuf import text_format
                // text_proto = text_format.MessageToString(message)
                res.status(501)
                   .send('Not Implemented: putting protobufs into text format.');
                return;
            }
            else {
                // protocol buffers are not self-explanatory, hence we don't know
                // naturally how to treat a 'proto.bin' or 'proto', this would be
                // an interface to help with this, returns 404 if the result is
                // not {type}, not super useful hence ;-) It's a stricter contract
                // as an API though, may be helpful for possible clients.
                //  -> if we get a 404 we don't have to validate any further
                //  -> if we get a file, we still have to see if it opens, this
                //     still is external i/o and can't be trusted blindly :-/
                // {type}.bin => // => same as 'proto.bin' type must be the getTypeName result
                // {type} => // => same as 'proto' type must be the getTypeName result
                typeName = getTypeName(this._knownTypes, message);
                if(extension === typeName + '.bin') {
                    contentType = 'application/octet-stream';
                    data = Buffer.from(message.serializeBinary());
                }
                else if (extension === typeName) {
                    contentType = 'text/plain';
                    res.status(501)
                       .send('Not Implemented: putting protobufs into text format.');
                    return;
                }
                else {
                    res.status(404)
                       .send('Not Found: can\'t handle extension ".'+extension+'".');
                    return;
                }
            }

            res.setHeader('Content-Type', contentType);
            // mark as downloadable file
            res.setHeader('Content-Disposition'
                            , 'attachment; filename=' + filename);
            res.send(data);
        }
      , err=> {
            // ... 404 not found OR 500 depends on the message!

            var statusCode = 500
              , message = 'Internal Error'
              ;
            if(err.code === grpcStatus.NOT_FOUND) {
                statusCode = 404;
                message = 'Not Found: ' + err.details;
            }

            this._log.error('_download storage [GET]', req.params.storage
                                                    , key, extension, err);
            res.status(statusCode).send(message);
            return;
        });
};


module.exports.StorageDownloadService = StorageDownload;

if (typeof require != 'undefined' && require.main==module) {
    throw new Error ('Does not implemented a CLI!');
}
