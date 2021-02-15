#! /usr/bin/env node
"use strict";
// this is expected to run in nodejs
/* global require */
/* jshint esnext:true */

const { initAmqp }= require('./getSetup')
  , { StorageClient } = require('./StorageClient')
  , { ProtobufAnyHandler } = require('./ProtobufAnyHandler')
  , grpc = require('grpc')
  , messages_pb = require('protocolbuffers/messages_pb')
  , { File, Files, CollectionFamilyJob, FamilyData, FamilyNamesList
    , SourceDetails
    } = messages_pb
  , { ManifestService } = require('protocolbuffers/messages_grpc_pb')
  , { Timestamp } = require('google-protobuf/google/protobuf/timestamp_pb.js')
  , { Empty } = require('google-protobuf/google/protobuf/empty_pb.js')
  , { AsyncQueue } = require('./AsyncQueue')
  ;

/**
 * This connects the manifestSources to the world (cluster)
 *
 * We currently run this from main within the manifestSources
 */
function ManifestServer(logging, id, sources, port, cacheSetup, amqpSetup) {
    this._log = logging;
    this._id = id;
    this._ready = false;
    this._server = new grpc.Server();
    this._server.addService(ManifestService, this);
    this._server.bind('0.0.0.0:' + port, grpc.ServerCredentials.createInsecure());

    if(cacheSetup)
        this._cache = new StorageClient(logging, cacheSetup.host, cacheSetup.port
                            , messages_pb);
    else
        // that's a feature used in development sometimes
        this._log.warning('cacheSetup is not defined!');

    this._sourcesSetup = sources;
    this._amqpSetup = amqpSetup;
    this._amqp = null;
    this._manifestMainJobQueueName = 'fontbakery-manifest-main-jobs';

    this._any = new ProtobufAnyHandler(this._log, {FamilyData:FamilyData});

    // FIXME: do we need this?
    // if it's only about the POKE function, we may as well just wait for
    // incoming queues or such.
    // this._manifestMainRegisterSourceQueueName = 'fontbakery-manifest-main-register-source';

    this._sources = Object.create(null);
    this._queues = new Map();
    this.__queue = this._queue.bind(this);
}

var _p = ManifestServer.prototype;

_p.serve = function() {
    // Start serving when the database and rabbitmq queue is ready
    return Promise.all([
                 initAmqp(this._log, this._amqpSetup)
               , this._cache && this._cache.waitForReady() || null
               , this._addSources(this._sourcesSetup)
               ])
    .then(resources => {
        this._amqp = resources[0];
    })
    .then(()=>{
        this._ready = true;
        return this._server.start();
    })
   ;
};

_p._addSources = function(sources) {
    return Promise.all(sources.map(this._addSource, this)
                              .filter(promise=>!!promise));
};

_p._registerSource = function(sourceID) {
    // jshint unused:vars
    // PASS.
    // Discussion in the constructor at _manifestMainRegisterSourceQueueName
    // return this._sendAMQPMessage(this._manifestMainRegisterSourceQueueName, buffer);
};

_p._addSource = function(source) {
    if(source.id in this._sources)
        throw new Error('Source ID "' + source.id + '" already exists.');

    source.setDispatchFamily(this._dispatchFamily.bind(this, source.id));
    source.setQueue(this.__queue);

    this._sources[source.id] = source;
    this._registerSource(source.id);
    return source.schedule('init');
};

_p.updateAll = function() {
    var updates = [], sourceId;
    for(sourceId in this._sources)
        updates.push(this.update(sourceId));
    return Promise.all(updates);
};

_p.update = function(sourceId) {
    return this._sources[sourceId].schedule('update')
        .then(
              () => {
                  this._log.info('Finished updating ', sourceId);
            }
            , err => {
                this._log.error('ManifestServer problem updating'
                                    , 'source:', sourceId
                                    , 'error:', err
                                    , 'CAUTION: Error is suppressed!');
        });
};

/**
 * Manifest source? This is useful for all Manifests.
 * filesData is is an array of arrays:
 *          [ [string filename, Uint8Array fileData], ... ]
 */
_p._wrapFilesData = function(filesData, baseDir) {
    var filesMessage = new Files();

    // sort by file name
    function sortFilesData(a, b) {
        var nameA = a[0], nameB = b[0];
        if(nameA === nameB) return 0;
        return nameA > nameB ? 1 : -1;
    }

    function makeFile(item) {
        var file = new File()
          , [filename, arrBuff] = item
          ;
        file.setName(baseDir ? `${baseDir}/${filename}` : filename);
        file.setData(arrBuff);
        return file;
    }

    // this important, so that we get exact hashes from the FilesPB serialization
    filesData.sort(sortFilesData)
             .map(makeFile)
             // equals filesMessage.addFiles(file);
             .forEach(file=>filesMessage.addFiles(file));
    return filesMessage;
};

/**
 * Manifest source? This is useful for all Manifests.
 * familyData is is an array of [string filename, messages_pb.Files filesMessage]
 */
_p._cacheFamily = function (filesMessage) {
    return this._cache.put([filesMessage])
        // only the first item is interesting/present because we only
        // put one message into: `[filesMessage]`
        .then(responses=>responses[0]  // [cacheKey] => cacheKey
            , err=>{ this._log.error(err); throw err; });
};

_p._sendAMQPMessage = function (queueName, message) {
    var options = {
            // TODO: do we need persistent here/always?
            persistent: true // same as deliveryMode: true or deliveryMode: 2
        }
        ;
    function sendMessage() {
        // jshint validthis:true
        this._log.info('sendToQueue: ', queueName);
        return this._amqp.channel.sendToQueue(queueName, message, options);
    }
    return this._amqp.channel.assertQueue(queueName, {durable: true})
           .then(sendMessage.bind(this))
           ;
};

_p._dispatchFamilyJob = function(sourceid, familyName, cacheKey, metadata) {
    var collectionId = [this._id, sourceid].join('/')
      , job = new CollectionFamilyJob()
      , timestamp = new Timestamp()
      , buffer
      ;
    this._log.debug('_dispatchFamilyJob:', familyName, collectionId);

    job.setCollectionid(collectionId);
    job.setFamilyName(familyName);
    job.setCacheKey(cacheKey);

    timestamp.fromDate(new Date());
    job.setDate(timestamp);// Timestamp => hoping that this is the way to do it
    if(metadata)
        job.setMetadata(JSON.stringify(metadata));

    buffer = new Buffer(job.serializeBinary());
    return this._sendAMQPMessage(this._manifestMainJobQueueName, buffer);
};

_p._dispatchFamily = function(sourceid, familyName, baseDir, filesData, metadata) {
    var filesMessage = this._wrapFilesData(filesData, baseDir); // => filesMessage
    return this._queue('cache', () => this._cacheFamily(filesMessage)) // => cacheKey
        .then(cacheKey => {
            return this._dispatchFamilyJob(sourceid, familyName
                                                    , cacheKey, metadata);
        });
};

_p._queue = function(name, job) {
    var job_, name_, queue;
    if(typeof name === 'function') {
        job_ = name;
        name_ = 'default';
    }
    else {
        job_ = job;
        name_ = name;
    }

    queue = this._queues.get(name_);
    if(!queue) {
        queue = new AsyncQueue();
        this._queues.set(name_, queue);
    }
    return queue.schedule(job_);
};

// ManifestService implementation
// rpc Poke (ManifestSourceId) returns (google.protobuf.Empty) {};
_p.poke = function(call, callback) {
    if(!this._ready) {
        callback(new Error('Not ready yet'));
        return;
    }
    var sourceId = call.request.getSourceId() // call.request is a ManifestSourceId
      , err = null
      , response
      ;

    if(sourceId !== '') {
        if( !(sourceId in this._sources) )
            err = new Error('Not Found: The source "' + sourceId + '" is unknown.');
        else
            this.update(sourceId);
    }
    else
        this.updateAll();

    response = err ? null : new Empty();
    callback(err, response);
};

_p._getSource = function(sourceId) {
    var source = null
      , error = null
      ;
    if(!this._ready)
        error = new Error('Not ready yet');
    else if (sourceId === '')
        error = new Error('sourceId can\t be empty, must be one of: '
                                + Object.keys(this._sources).join(', '));
    else if ( !(sourceId in this._sources) )
        error = new Error('Not Found: The source "' + sourceId + '" is unknown.'
                    + 'Known sources are: '
                    + Object.keys(this._sources).join(', '));
    else
        source = this._sources[sourceId];
    return [error, source];
};


// rpc List (ManifestSourceId) returns (FamilyNamesList){}
_p.list = function(call, callback) {
    var sourceId = call.request.getSourceId() // call.request is a ManifestSourceId
        // checks for this._ready!
      , [error, source] = this._getSource(sourceId)
      ;
    return (error ? Promise.reject(error)
                  : source.list())
    .then(familyNamesList=>{
          var response = new FamilyNamesList();
            response.setFamilyNamesList(familyNamesList);
            callback(null, response);
        }
      , error=>{
            this._log.error('[LIST:'+sourceId+']', error);
            callback(error, null);
        }
    );
};

_p._get = function(sourceId, familyName) {
         // checks for this._ready!
     var [error, source] = this._getSource(sourceId);

    return (error ? Promise.reject(error)
                  : source.get(familyName))
    .then(([familyName, baseDir, filesData, metadata])=>{
        var familyData = new FamilyData()
          , collectionId = [this._id, sourceId].join('/')
          , filesMessage = this._wrapFilesData(filesData, baseDir)
          , timestamp = new Timestamp()
          ;
        timestamp.fromDate(new Date());
        familyData.setStatus(FamilyData.Result.OK);
        familyData.setCollectionid(collectionId);
        familyData.setFamilyName(familyName);
        familyData.setFiles(filesMessage);
        familyData.setDate(timestamp);
        familyData.setMetadata(JSON.stringify(metadata));
        return familyData;
    });
};

_p.get = function (call, callback) {
    var sourceId = call.request.getSourceId() // call.request is a FamilyRequest
      , familyName = call.request.getFamilyName() // call.request is a FamilyRequest
      ;
    this._log.info('[GET:'+sourceId+'/'+familyName+'] ...');
    return this._get(sourceId, familyName)
    .then(
          familyData=>callback(null, familyData)
        , err=>{
            this._log.error('[GET:'+sourceId+'/'+familyName+']', err);
            callback(err, null);
          }
    );
};

_p._dispatchProcessCommand = function(preparedProcessCommand, payload, sourceId=null) {
    var processCommand = preparedProcessCommand.cloneMessage()
      , anyPayload = this._any.pack(payload)
      , buffer
      , responseQueue = preparedProcessCommand.getResponseQueueName()
      , requester = 'Manifest Server ' + this._id
                                       + (sourceId ? '/' + sourceId : '')
      ;
    // expecting these to be already set
    // processCommand.setTicket(ticket);
    // processCommand.setTargetPath(targetPath);
    // processCommand.setCallbackName(callbackName);
    processCommand.setRequester(requester);
    processCommand.setPbPayload(anyPayload);
    buffer = Buffer.from(processCommand.serializeBinary());
    return this._sendAMQPMessage(responseQueue, buffer);
};


// rpc GetDelayed (FamilyRequest) returns (google.protobuf.Empty){};
_p.getDelayed = function(call, callback) {
    var sourceId = call.request.getSourceId() // call.request is a FamilyRequest
      , familyName = call.request.getFamilyName() // call.request is a FamilyRequest
      , processCommand = call.request.getProcessCommand()
      ;
    this._log.info('[GET_DELAYED:'+sourceId+'/'+familyName+'] ...');
    if(!processCommand) {
        callback(new Error('GetDelayed requires FamilyRequest to define '
                                + 'a ProcessCommand, which it doesn\'t.'));
        return;
    }
    callback(null, new Empty());
    return this._get(sourceId, familyName)
    .then(
          null
        , err=>{
            this._log.error('[GET_DELAYED:'+sourceId+'/'+familyName+']', err);
            var familyData = new FamilyData()
              , collectionId = [this._id, sourceId].join('/')
              ;
            familyData.setStatus(FamilyData.Result.FAIL);
            familyData.setError('' + err);
            // grpc status OK is 0 and that makes sense for a default.
            // But since we know that there's an error and this is
            // expected to report similar to the `get` interface,
            // with grpc codes, UNKOWN (6) seem appropriate.
            familyData.setErrorCode(err.code || grpc.status.UNKNOWN);
            familyData.setCollectionid(collectionId);
            familyData.setFamilyName(familyName);
            return familyData;
          }
    )
    .then(payloadMessage=>this._dispatchProcessCommand(processCommand
                                                , payloadMessage, sourceId));
};

// rpc GetSourceDetails (FamilyRequest) returns (SourceDetails){}
_p.getSourceDetails = function(call, callback) {
    var sourceId = call.request.getSourceId() // call.request is a FamilyRequest
       // checks for this._ready!
     , [error, source] = this._getSource(sourceId)
     , familyName = call.request.getFamilyName() // call.request is a FamilyRequest
     ;

    this._log.info('[GET_SOURCE_DETAILS:'+sourceId+'/'+familyName+'] ...');

    return (error ? Promise.reject(error)
                  : source.getSourceDetails(familyName))
    .then(
        data=>{
            var sourceDetails = new SourceDetails();
            sourceDetails.setJsonPayload(JSON.stringify(data));
            callback(null, sourceDetails);
        }
      , err=>{
            this._log.error('[GET_SOURCE_DETAILS:'+sourceId+'/'+familyName+']', err);
            callback(err, null);
        }
    );
};

exports.ManifestServer = ManifestServer;
