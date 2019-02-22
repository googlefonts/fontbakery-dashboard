#! /usr/bin/env node
"use strict";
// this is expected to run in nodejs
/* global require */
/* jshint esnext:true */

const { getSetup } = require('./util/getSetup')
  , { IOOperations } = require('./util/IOOperations')
  , messages_pb = require('protocolbuffers/messages_pb')
  , { StorageClient }  = require('./util/StorageClient')
  , { InitWorkersClient } = require('./util/InitWorkersClient')
  ;

/**
 * The ManifestMaster receives requests for tests from the Manifests
 * via a queue.
 * It then decides whether to execute the test run or if it can just
 * shortcut the execution, because an identical test already exists.
 *
 * A test is identical when the testing environment (fontbakery etc.
 * see ENVIRONMENT_VERSION) and it's data (test_data_hash) are equal.
 *
 * Thus the familytest table has a secondary key: [environment_version test_data_hash]
 *
 * On an incoming request we query the familytest table for the
 * [environment_id test_data_hash] key. if an entry comes up, we can use
 * the familytests_id otherwise, we create a new entry then a) dispatch to
 * the worker-distributor
 * b) use the familytests_id to create an entry in the collections table
 *
 * This skips the test if it already exists!
 *
 * the collectiontests table:
 *
 * collection_id | family_name | familytests_id | date (sorting) | family_metadata
 *
 * Don't do consecutive entries that are the same
 *  collection_id | family_name | familytests_id
 * the last entry must not be like that, if there's somewhere another entry
 * like this, we're probably watching at a rollback, which is fine.
 *
 * get collection_id | family_name
 * if there is a an entry and familytests_id == new familytest_id
 *      dont' create the entry
 * else
 *      create the full entry
 */
function ManifestMaster(logging, amqpSetup, dbSetup, cacheSetup) {
    this._log = logging;
    this._dbSetup = dbSetup;
    this._io = new IOOperations(logging, dbSetup, amqpSetup);
    this._manifestMasterJobQueueName = 'fontbakery-manifest-master-jobs';
    this._cache = new StorageClient(logging, cacheSetup.host, cacheSetup.port);
    this._initWorkers = new InitWorkersClient(logging, initWorkers.host, initWorkers.port);

    // Start serving when the database and rabbitmq queue is ready
    Promise.all([
                 this._io.init()
               , this._cache.waitForReady()
               , this._initWorkers.waitForReady()
               ])
    //.then(resources => {
    //    amqp = resources[0][1];
    //})
    .then(this._listen.bind(this))
    .catch(err => {
        this._log.error('Can\'t initialize server.', err);
        process.exit(1);
    });
}

var _p = ManifestMaster.prototype;

_p._listen = function() {
    return this._io.queueListen(
        this._manifestMasterJobQueueName, this._consumeQueue.bind(this));
};

_p._getCollectionFamilyJob = function(messageContent) {
    var arr = new Uint8Array(Buffer.from(messageContent))
      , job = messages_pb.CollectionFamilyJob.deserializeBinary(arr)
      ;
    // this._log.debug('collectionFamilyJob', job.toObject());
    return job;
};

/*
 * On an incoming request we
 * a) query the familytest table for the [environment_id test_data_hash] key.
 *      if an entry comes up, we can use the familytest id (docid)
 *      else we create a new entry and dispatch to the worker-distributor
 *          then use the familytest id
 *
 * b) use the familytests_id to create an entry in the collections table
 */
_p._consumeQueue = function(message) {
    var job = this._getCollectionFamilyJob(message.content)
      , cacheKey = job.getCacheKey()
      ;

    return this._initWorkers.initialize('fontbakery', cacheKey)
    .then(familyJob=>{
        var docid = familyJob.getDocId();
        return this._createCollectionEntry(job, docid);
    })
    .then(() => this._io.ackQueueMessage(message))
    .catch(err=>this._log.error(err)) // die now?
    ;
};


/**
 * These are only created and never changed again.
 * we try to not create consecutive entries
 * of equal [collection_id | family_name | familytests_id], but this
 * is not quaranteed du to race conditions
 *
 * We can thus monitor changes in here and then update a latest/live view
 * when new entries are created.
 */
_p._createCollectionEntry = function(job, familytests_id) {
  var collection_id = job.getCollectionid()
    , family_name = job.getFamilyName()
    , metadata = job.getMetadata()
    , doc = {
        collection_id: collection_id
      , family_name: family_name
      , familytests_id: familytests_id
      , date: job.getDate().toDate()
      , metadata: metadata ? JSON.parse(metadata) : {}
    }
    ;

    // Don't do consecutive entries that are the same
    // [collection_id | family_name | familytests_id]
    return this._io.getLatesCollectionEntry(collection_id, family_name)
        // => collectiontests_id;
        .then(collectionDoc => {
            if(collectionDoc && collectionDoc.familytests_id === familytests_id) {
                // don't insert, it's equal
                this._log.debug('collectionDoc is already latest:'
                            , collection_id, family_name, familytests_id);
                return collectionDoc.id;
            }
            return this._io.insertDoc('collection', doc)
                           .then(response=>response.generated_keys[0]);// => collectiontests_id;
        })
        ;
};

if (typeof require != 'undefined' && require.main==module) {
    var setup = getSetup();
    setup.logging.log('Loglevel', setup.logging.loglevel);
    new ManifestMaster(setup.logging, setup.amqp, setup.db, setup.cache);
}
