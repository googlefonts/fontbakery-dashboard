#! /usr/bin/env node
"use strict";
// this is expected to run in nodejs
/* global require, module */
/* jshint esnext:true */

const messages_pb = require('protocolbuffers/messages_pb')
  , grpc = require('grpc')
  , { FamilyJob, StorageKey, CompletedWorker, FontBakeryFinished
      , WorkerJobDescription } = messages_pb
  , { InitWorkersService } = require('protocolbuffers/messages_grpc_pb')
  , { Timestamp } = require('google-protobuf/google/protobuf/timestamp_pb.js')
  , { getSetup } = require('./util/getSetup')
  , { StorageClient }  = require('./util/StorageClient')
  , { IOOperations } = require('./util/IOOperations')
  , { ProtobufAnyHandler, unpack} = require('./util/ProtobufAnyHandler')
  ;



const WorkerDefinition = (function() {

function WorkerDefinition(logging) {
    this._log = logging;
}

var _p = WorkerDefinition.prototype;

Object.defineProperties(_p, {
    InitMessage: {
        get: function() {
            throw new Error('InitMessage is not implemented');
        }
    }
  , CompletedMessage: {
        get: function() {
            throw new Error('CompletedMessage is not implemented');
        }
    }
});

/**
 * -> [id, answer, finishedMessage || null]
 *
 * If it's not finished, finishedMessage should be null.
 * If it's finished, but there's not really a finishedMessage use pb Empty
 */
_p.callInit = function(initMessage) {
    // jshint unused:vars
    throw new Error('callInit is not implemented');
};

/**
 * -> [id, finishedMessage || null]
 *
 * If it's not finished, finishedMessage should be null.
 * If it's finished, but there's not really a finishedMessage use pb Empty
 */
_p.registerCompleted = function(completedMessage) {
    // jshint unused:vars
    throw new Error('registerCompleted is not implemented');
};

return WorkerDefinition;
})();

/**
 * The job of this service is to init and clean up jobs done by
 * the workers.
 * Initially this was just the cleanup service for fontbakery-workers
 * but we have a lot more tools running in workers now and this is
 * supposed to provide a unified handling for these.
 */
// listen to queue_out_name='fontbakery-worker-cleanup'
// if feasible, finish the family job
function InitWorkers(logging, port, io, resources, workerDefinitions) {
    this._cleanupQueueName = 'fontbakery-worker-cleanup';
    this._log = logging;
    this._io = io;
    this._workerDefinitions = this._initWorkerDefinitions(workerDefinitions, resources);
    // only used for pack, so we can make it know all messages
    this._any = new ProtobufAnyHandler(this._log, messages_pb);

    this._server = new grpc.Server({
        'grpc.max_send_message_length': 80 * 1024 * 1024
      , 'grpc.max_receive_message_length': 80 * 1024 * 1024
    });

    this._server.addService(InitWorkersService, this);
    this._server.bind('0.0.0.0:' + port, grpc.ServerCredentials.createInsecure());

    this._processCommands = new Map();
}

var _p = InitWorkers.prototype;

_p._initWorkerDefinitions = function(workerDefinitions, resources) {
    var defs = new Map();
    for(let [workerName, def] of Object.entries(workerDefinitions)){
        let Ctor = def[0]
          , dependencyNames = def.slice(1)
          , dependencies = []
          ;
        for(let name of dependencyNames) {
            if(!(name in resources)){
                throw new Error('Dependency "'+name+'" is not in resources.');
            }
            dependencies.push(resources[name]);

        }
        defs.set(workerName, new Ctor(...dependencies));
    }
    return defs;
};

_p._getWorkerDefinition = function(workerName) {
    var workerDef = this._workerDefinitions.get(workerName)
      , error = null
      ;
    if(!workerDef) {
        error = new Error('Unknown worker name:' + workerName);
        error.name = 'NOT_FOUND';
        error.code = grpc.status[error.name];
    }
    return [error, workerDef || null];
};

/**
 * messageProperty is 'InitMessage' or 'CompletedMessage'
 */
_p._unpackWorkerMessage = function(workerName, messageProperty, any) {
    var [error, workerDef] = this._getWorkerDefinition(workerName)
      , MessageType, message
      ;
    if(error)
        return [error, null];

    try {
        MessageType = workerDef[messageProperty];
        message = unpack(any, MessageType);
    }
    catch(error) {
        return [error, null];
    }
    return [null, message];
};

_p._getJobInitMessage = function(workerName, any) {
    return this._unpackWorkerMessage(workerName, 'InitMessage', any);
};

_p._getJobCompletedMessage = function(workerName, any) {
    return this._unpackWorkerMessage(workerName, 'CompletedMessage', any);
};


_p._callWorkerAPI = function(workerName, methodName, ...args) {
    var [error, workerDef] = this._getWorkerDefinition(workerName)
      , result
      ;
    if(error)
        return Promise.reject(error);

    try {
       result = workerDef[methodName](...args);
    }
    catch(error) {
        return Promise.reject(error);
    }

    return Promise.resolve(result);
};

/**
 * -> [id, answer, finishedMessage || null]
 *
 * If it's not finished, finishedMessage should be null.
 * If it's finished, but there's not really a finishedMessage use pb Empty
 *
 */
_p._callInitWorker = function(workerName, initMessage) {
    return this._callWorkerAPI(workerName, 'callInit', initMessage);
};

/**
 * -> [id, finishedMessage || null]
 *
 * If it's not finished, finishedMessage should be null.
 * If it's finished, but there's not really a finishedMessage use pb Empty
 */
_p._registerCompletedWorker = function(workerName, completedMessage) {
    return this._callWorkerAPI(workerName, 'registerCompleted', completedMessage);
};

_p._keepProcessCommand = function(workerName, id, processCommand) {
    var key = workerName + ':'  + id
      , data = this._processCommands.get(key)
      ;
    if(!data){
        data = {
            // FIXME: some sort of cleanup/timeout seems very appropriate.
            date: new Date()
          , processCommands: []
        };

        this._processCommands.set(key, data);
    }
    data.processCommands.push(processCommand);
};

_p._dispatchProcessCommands = function(workerName, id, finishedMessage) {
    var key = workerName + ':'  + id
      , anyPayload = this._any.pack(finishedMessage)
      , data = this._processCommands.get(key)
      , processCommands = data && data.processCommands || []
      ;
    for(let processCommand of processCommands) {
        processCommand.setRequester('Worker: ' + workerName);
        processCommand.setPbPayload(anyPayload);
        // expecting these to be already set
        // processCommand.setTicket(ticket);
        // processCommand.setTargetPath(targetPath);
        // processCommand.setCallbackName(callbackName);
        // processCommand.setResponseQueue(responseQueue);
        let responseQueue = processCommand.getResponseQueueName()
          , buffer = Buffer.from(processCommand.serializeBinary())
          ;
        this._io.sendQueueMessage(responseQueue, buffer);
    }
    this._processCommands.delete(key);
};

/**
 * gRPC
 * rpc Init (WorkerDescription) returns (google.protobuf.Any) {};
 *
 *   - Depending on the workerName, run a different init method.
 *   - Depending on the workerName, return a different response.
 *   - If job has a process command, keep it and run it when
 *     the workers have truly finished.
 *
 * message WorkerDescription {
 *     string worker_name = 1;
 *     // the message type of job is worker implementation dependent
 *     google.protobuf.Any job = 2;
 *     ProcessCommand process_command = 3;
 * }
 */
_p.init = function(call, callback) {
    var workerDescription = call.request
      , workerName = workerDescription.getWorkerName()
      , processCommand = workerDescription.getProcessCommand()
      , anyJob = workerDescription.getJob()
      , error, jobInitMessage
      ;

    [error, jobInitMessage] = this._getJobInitMessage(workerName, anyJob);
    if(!jobInitMessage) {
        callback(error);
        return;
    }

    // There would be a gain in not creating finishedMessage if we don't
    // need it, when there are no processCommands for workerName + id.
    // but that we often know the id after the db query anyways and the
    // finishedMessage is hopefully not too complicated to create.
    return this._callInitWorker(workerName ,jobInitMessage)
    .then(([id, answer, finishedMessage])=>{
        callback(null, this._any.pack(answer));
        if(processCommand)
            this._keepProcessCommand(workerName, id, processCommand);
        if(finishedMessage)
            // The worker is done already, i.e. there's a cached result.
            // This is an optional feature in the worker implementation.
            this._dispatchProcessCommands(workerName, id, finishedMessage);
    });
};

/**
 * consuming this._cleanupQueueName
 * All workers will have to report to this method via amqp.
 *
 * For Font Bakery this is FamilyJob messages.
 *
 * string workerName
 * Any anyFinishedMessage
 */
_p._consumeQueue = function(message) {
    // depending on the job, run a different cleanup method
    // depending on the job, this may run multiple times!
    // depending on the job, we may have multiple  process commands
    // to send out as an answer!

    // -- TODO unwrap that job! How else can we know what to do!
    var u8A = new Uint8Array(Buffer.from(message.content))
      , completedWorker = CompletedWorker.deserializeBinary(u8A)
      , workerName = completedWorker.getWorkerName()
      , anyCompletedMessage = completedWorker.getCompletedMessage()
      , error, completedMessage
      ;

    [ error, completedMessage ] = this._getJobCompletedMessage(workerName, anyCompletedMessage);
    if(error) {
        this._log.error(error);
        // If we wouldn't ack here, a requeuing
        // wouldn't help here either
        this._io.ackQueueMessage(message);
        return;
    }
    // _consumeQueueFontBakery
    return this._registerCompletedWorker(workerName, completedMessage)
    .then(([id, finishedMessage])=>{
        if(finishedMessage)
            // The worker is done.
            this._dispatchProcessCommands(workerName, id, finishedMessage);
    })
    // catch all and log, there's no direct client to answer
    .then(null, error=>{
        // We are going to ack this, so this action is
        // the last registration of that error!
        // e.g. GCP will register this via its Stackdriver Error Reporting.
        // There's no back-channel to report to.
        this._log.error('_consumeQueue for worker "' + workerName + '"', error);
    })
    .then(() => this._io.ackQueueMessage(message));
};

// start the server
_p.serve = function() {

    this._io.queueListen(this._cleanupQueueName
                                        , this._consumeQueue.bind(this))
    .then(()=>this._server.start());
};


// FONT BAKERY SPECIFIC //
//////////////////////////

const FontBakeryWorker = (function() {

function FontBakeryWorker(logging, io, cache) {
    WorkerDefinition.call(this, logging);
    this._io = io;
    this._cache = cache;
    // only used for pack, so we can make it know all messages
    this._any = new ProtobufAnyHandler(this._log, messages_pb);
}

var _p = FontBakeryWorker.prototype = Object.create(WorkerDefinition.prototype);

Object.defineProperties(_p, {
    InitMessage: { value: StorageKey, enumerable:true }
  , CompletedMessage: { value: FamilyJob, enumerable:true }
});

/**
 * a family-test document
 */
_p._createFamilyDoc = function(environment_version, test_data_hash) {
    var doc = {
          created: new Date()
        , test_data_hash: test_data_hash
        , environment_version: environment_version
    };
    return this._io.insertDoc('family', doc)
        .then(function(dbResponse) {
            var docid = dbResponse.generated_keys[0];
            doc.id = docid;
            return doc;
        });
};

// jobs: needed for _checkFamilyDoc
// finished: needed for all is-finished checking
// rest for finished message reporting
const _PLUCK_FAMILY_TEST_DOC = ['id', 'jobs', 'created', 'started'
                                , 'finished', 'results', 'exception'];


function timestampFromDate(date){
    var ts = new Timestamp();
    ts.fromDate(date);
    return ts;
}

/**
 * message FontBakeryFinished {
 *     string docid = 1;
 *     bool finished_orderly = 2;
 *     string results_json = 3;
 *     google.protobuf.Timestamp created = 4;
 *     google.protobuf.Timestamp started = 5;
 *     google.protobuf.Timestamp finished = 6;
 * }
 */
function _finishedMessageFromDoc(doc) {
    var message = new FontBakeryFinished()
      , exceptions = [doc.exception
                     , ...(Object.entries(doc.jobs || {})).map(job=>job.exception)
                     ].filter(e=>!!e)
       ;
    message.setDocid(doc.id);
    // If the job has any exception, it means
    // the job failed to finish orderly
    message.setFinishedOrderly(!exceptions.length);
    // TODO: add a metadataMessage? Each of doc.jobs has the same fields.
    for(let key of ['created', 'started', 'finished']) {
        let date = doc[key]
            // setCreated, setStarted, setFinished
          , setter = 'set' + key[0].toUpperCase() + key.slice(1)
          ;
        if(!date)
            continue;
        message[setter](timestampFromDate(date));
    }
    if(doc.results)
        message.setResultsJson(JSON.stringify(doc.results));
    return message;
}

/**
 * If not present, create the doc
 *
 * CAUTION: This is prone to race conditions, we may end up with
 * multiple entries that have the [ENVIRONMENT_VERSION, test_data_hash]
 * key. That is not too bad, though, since the contents should be identical
 * all we did is running an identical test multiple times.
 *
 * Enforcing uniqueness here using rethink is possible but not straight
 * forward at this point:
 *
 * https://rethinkdb.com/api/javascript/table_create/:
 *      "The data type of a primary key is usually a string (like a UUID) or a
 *       number, but it can also be a time, binary object, boolean or an array.
 *       Data types can be mixed in the primary key field, but all values must
 *       be unique. Using an array as a primary key causes the primary key
 *       to behave like a compound index;"
 *
 * TODO:
 * - use the primary index:
 *   doc = {
 *        id: [ENVIRONMENT_VERSION, test_data_hash]
 *      , created: new Date()
 *   }
 * - make sure docid can be an array everwhere
 *      OR use something like id: [ENVIRONMENT_VERSION, test_data_hash].join(':')
 * - handle cases where inserting fails because of the uniqueness constraint!
 *   Be careful an don't forget to delete the cache entry!
 * - remove the env_hash secondary index
 */
_p._getOrCreateDoc = function(test_data_hash) {
    // FIXME: environment variables are created on process startup, to
    // change the ENVIRONMENT_VERSION the pod has to be restarted.
    // This service stores processCommands in memory, so these will be
    // lost in case of a restart AND ENVIRONMENT_VERSION is more interesting
    // in terms of fontbakery-worker version than in terms of the
    // infrastructure, yet also infrastructure changes can have an impact
    // here. e.g. the creation routine of the job files could be updated
    // and hence would create a different job (yet also a different
    // test_data_hash...
    var environment_version = process.env.ENVIRONMENT_VERSION;

    // we DON'T know docid
    return this._io.query('family')
        // WHY getAll? Well: environment_version, test_data_hash
        // should be just one document, BUT: the env_hash index is
        // not unique, meaning that while this query runs or is waiting
        // to run, maybe another async job is already creating
        // a document with these properties using, _createFamilyDoc....
        // so ... we can use an async queue in here to handle this.
        .getAll([environment_version, test_data_hash], {index:'env_hash'})
        .pluck(..._PLUCK_FAMILY_TEST_DOC)
        .run()
        .then(function(docs) {
            if(docs.length)
                // it already exists!
                return [false, docs[0].id,  docs[0]];
            return this._createFamilyDoc(environment_version, test_data_hash)
                       .then(doc => [true, doc.id, doc]);
        }.bind(this))
        ;
};

_p._queryFamilyTestDoc = function(docid) {
    // we know docid
    return this._io.query('family')
        .get(docid)
        .pluck(..._PLUCK_FAMILY_TEST_DOC)
        .run()
        ;
};

_p._queueFontBakeryFamilyJob = function(cacheKey, docid) {
    this._log.debug('dispatchFamilyJob:', docid);
    var distributorQueueName = 'fontbakery-worker'
      , job = new FamilyJob()
      , jobDescription = new WorkerJobDescription()
      , anyJob, buffer
      ;
    job.setDocid(docid);
    job.setCacheKey(cacheKey);
    anyJob = this._any.pack(job);
    jobDescription.setWorkerName('fontbakery');
    jobDescription.setJob(anyJob);
    buffer = Buffer.from(jobDescription.serializeBinary());
    return this._io.sendQueueMessage(distributorQueueName, buffer);
};

_p.callInit = function(cacheKey) {
    var test_data_hash = cacheKey.getHash()
      ;
    return this._getOrCreateDoc(test_data_hash)
    .then(([created, docId, doc]) => {
        var isFinished = !!doc.finished
          , answer, promise
          , finishedMessage = null
          ;
        if(!created) {
            // Purge cacheKey, this one is not needed anymore.
            promise = this._cache.purge(cacheKey);

        }
        else {
            // just now created
            // `finished` is not truish ever here, this is just stating
            // stating the obvious, to make it clear to read.
            isFinished = false;
            // dispatch to worker-distributor
            promise = this._queueFontBakeryFamilyJob(cacheKey, docId);
        }

        // why not answer with a FamilyJob, it already has a docid
        // and the semantics of that field match perfectly...
        answer = new FamilyJob();
        answer.setDocid(docId);

        if(isFinished)
            //- if there's a process command run it now
            //- since gRPC/callback and amqp/processCommand are different
            //  means of transport processCommand could arrive before!
            //  callback, which could lead to strange errors, because
            //  its unexpected!
            //  In our current case, with ProcessManager this can't
            //  hapen though, because there's a queue guarding each
            //  process anyways.
            finishedMessage = _finishedMessageFromDoc(doc);

        return Promise.resolve(promise)
                .then(()=>[docId, answer, finishedMessage]);
    });
};

function _familyDocNeedsFinish(doc) {
    if(doc.finished)
        // could have exceptions or finished successfully in here
        return false;
    // check if all sub-jobs are finished
    // assert('jobs' in doc);
    // if(!('jobs' in doc))
    // This should never happen, because:
    // either doc.finished is true and distributor (see doc.exception)
    // failed or distributor was successful and that includes creating
    // the jobs property of the doc.
    for(let id in doc.jobs)
        if(!doc.jobs[id].finished)
            // still waiting for another job to be marked as finished
            return false;
    // All jobs have finished, does not imply without exception though!
    return true;
}

/**
 * Finish the family job if it is feasible.
 * Return the doc, finished or not finished.
 */
_p._checkFamilyDoc = function(docId) {
    return this._queryFamilyTestDoc(docId)
    .then(doc=>{
        var needsFinish = _familyDocNeedsFinish(doc)
          , promise = null
          ;
        if(needsFinish) {
            let finished = new Date();
            promise = this._io.query('family')
                              .get(docId)
                              .update({finished: finished})
                              .run();
            doc.finished = finished;
        }
        return Promise.resolve(promise).then(()=>doc);
    });
};

// -> [id, finishedMessage | null]
_p.registerCompleted = function(job) {
    var docId = job.getDocid();
    this._log.debug('fontbakery: cleaning up job for docid', docId);
    return this._checkFamilyDoc(docId)
    .then(doc=>{
        var isFinished = !!doc.finished
          , purgePromise = null
          , finishedMessage = null
          ;
        if(isFinished) {
            // will force other open sub-jobs into failing
            // but at this point, this is our best option.
            // We don't know if another cleanup message will
            // come again for this cacheKey!
            purgePromise = this._cache.purge(job.getCacheKey());
            finishedMessage = _finishedMessageFromDoc(doc);
        }
        return Promise.resolve(purgePromise)
            .then(()=>[docId, finishedMessage]);
    });
};

return FontBakeryWorker;
})();

if (typeof require != 'undefined' && require.main==module) {
    var setup = getSetup()
      ,  port=50051
      ;
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

    var workerDefinitions = {
            fontbakery: [FontBakeryWorker, 'logging', 'io', 'cache']
        }
      , resources = {
            logging: setup.logging
          , io: new IOOperations(setup.logging, setup.db, setup.amqp)
          , cache: new StorageClient(setup.logging, setup.cache.host, setup.cache.port, {})
        }
      ;

    Promise.all([resources.cache.waitForReady()
               , resources.io.init()
               ])
    .then(()=>{
        var initWorkers = new InitWorkers(setup.logging, port, resources.io
                                        , resources, workerDefinitions);
        return initWorkers.serve();
    })
    .then(
        ()=>setup.logging.info('Server ready!')
      , error=>{
            setup.logging.error('Can\'t initialize server.', error);
            process.exit(1);
        }
    );
}
