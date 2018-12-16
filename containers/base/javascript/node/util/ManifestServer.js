#! /usr/bin/env node
"use strict";
// this is expected to run in nodejs
/* global require */
/* jshint esnext:true */

const { initAmqp }= require('./getSetup')
  , { CacheClient } = require('./CacheClient')
  , grpc = require('grpc')
  , messages_pb = require('protocolbuffers/messages_pb')
  , { File, Files, CollectionFamilyJob, FamilyData, FamilyNamesList } = messages_pb
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
        this._cache = new CacheClient(logging, cacheSetup.host, cacheSetup.port
                            , messages_pb, 'fontbakery.dashboard');
    else
        // that's a feature used in development sometimes
        this._log.warning('cacheSetup is not defined!');

    this._sourcesSetup = sources;
    this._amqpSetup = amqpSetup;
    this._amqp = null;
    this._manifestMasterJobQueueName = 'fontbakery-manifest-master-jobs';
    //
    // FIXME: do we need this?
    // if it's only about the POKE function, we may as well just wait for
    // incoming queues or such.
    // this._manifestMasterRegisterSourceQueueName = 'fontbakery-manifest-master-register-source';

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
    // Discussion in the constructor at _manifestMasterRegisterSourceQueueName
    // return this._sendAMQPMessage(this._manifestMasterRegisterSourceQueueName, buffer);
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
_p._wrapFamilyData = function(filesData) {
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
        file.setName(filename);
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
    return this._sendAMQPMessage(this._manifestMasterJobQueueName, buffer);
};

_p._dispatchFamily = function(sourceid, familyName, filesData, metadata) {
    var filesMessage = this._wrapFamilyData(filesData); // => filesMessage
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

// rpc List (ManifestSourceId) returns (FamilyNamesList){}
_p.list = function(call, callback) {
    if(!this._ready) {
        callback(new Error('Not ready yet'));
        return;
    }
    var sourceId = call.request.getSourceId() // call.request is a ManifestSourceId
      , error = null
      ;

    if(sourceId === '') {
        error = new Error('sourceId can\t be empty, must be one of: '
                                + Object.keys(this._sources).join(', '));
    }
    if( !(sourceId in this._sources) ) {
        error = new Error('Not Found: The source "' + sourceId + '" is unknown.'
                    + 'Known sources are: '
                    + Object.keys(this._sources).join(', '));
    }

    return (error ? Promise.reject(error)
                  : this._sources[sourceId].list())
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

_p.get = function(call, callback) {
    var sourceId = call.request.getSourceId() // call.request is a FamilyRequest
     , familyName = call.request.getFamilyName() // call.request is a FamilyRequest
     , err = null
     ;

    if(!this._ready)
        err = new Error('Not ready yet');
    else if(!(sourceId in this._sources))
        err = new Error('sourceId "'+sourceId+'" not found.');

    (err ? Promise.reject(err)
         : this._sources[sourceId].get(familyName))
    .then(([familyName, filesData, metadata])=>{
        var familyData = new FamilyData()
          , collectionId = [this._id, sourceId].join('/')
          , filesMessage = this._wrapFamilyData(filesData)
          , timestamp = new Timestamp()
          ;
        timestamp.fromDate(new Date());
        familyData.setCollectionid(collectionId);
        familyData.setFamilyName(familyName);
        familyData.setFiles(filesMessage);
        familyData.setDate(timestamp);
        familyData.setMetadata(JSON.stringify(metadata));
        return familyData;
    })
    .then(
          familyData=>callback(null, familyData)
        , err=>{
            this._log.error('[GET:'+sourceId+'/'+familyName+']', err);
            callback(err, null);
          }
    );
};

exports.ManifestServer = ManifestServer;
