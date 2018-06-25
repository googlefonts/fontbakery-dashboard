#! /usr/bin/env node
"use strict";
// this is expected to run in nodejs
/* global require */
/* jshint esnext:true */


const { initDB, initAmqp }= require('./getSetup')
  , messages_pb = require('protocolbuffers/messages_pb')
  ;

function IOOperations(logging, dbSetup, amqpSetup) {
    this._log = logging;
    this._dbSetup = dbSetup;
    this._amqpSetup = amqpSetup;
    this._initPromise = null;
    this._r = null;
    this._amqp = null;
    this._distributorQueueName = 'fontbakery-worker-distributor';
}

var _p = IOOperations.prototype;

_p.init = function() {
    if(!this._initPromise)
        this._initPromise = Promise.all([
                initDB(this._log, this._dbSetup)
              , initAmqp(this._log, this._amqpSetup)
            ])
            .then(resources => {
                this._r= resources[0];
                this._amqp = resources[1];
                return resources;
            });
    return this._initPromise;
};

Object.defineProperty(_p, 'r', {
    get: function(){
        return this._r;
    }
});

_p.query = function(dbTable) {
    return this._r.table(dbTable);
};

_p.insertDoc = function(dbTable, doc) {
    return this.query(dbTable).insert(doc).run()
        .error(function(err) {
            this._log.error('Creating a doc failed ', err);
            throw err; // re-raise
        });
};

/**
 * a family-test document
 */
_p._createFamilyDoc = function(environment_version, test_data_hash) {
    var doc = {
          created: new Date()
        , test_data_hash: test_data_hash
        , environment_version: environment_version
    };

    return this.insertDoc(this._dbSetup.tables.family, doc)
        .then(function(dbResponse) {
            var docid = dbResponse.generated_keys[0];
            return docid;
        });
};

_p.getLatesCollectionEntry = function(collection_id, family_name) {
    return this.query(this._dbSetup.tables.collection)
            .getAll([collection_id, family_name], {index:'collection_family'})
            .orderBy(this._r.desc('date'))
            .limit(1)
            // => should return just the first element
            // .nth(0) there's no description what it does if the element doesn't exist!
            // but it looks like we get an error
            .run()
            .then(entries=>entries[0]) // => entry or undefined
            ;
};


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
_p.getDocId = function(test_data_hash) {
    // I'm using this envirionment variable directly here in the hope
    // it is kept up to date by kubernetes and thus that we don't need to
    // restart the pods when it is updated.
    var environment_version = process.env.ENVIRONMENT_VERSION;

    return this.query(this._dbSetup.tables.family)
        .getAll([environment_version, test_data_hash], {index:'env_hash'})
        .run()
        .then(function(docs) {
            if(docs.length)
                // it already exists!
                return [false, docs[0].id, environment_version];
            return this._createFamilyDoc(environment_version, test_data_hash)
                       .then(docid => [true, docid, environment_version]);
        }.bind(this))
        ;
};

_p.sendQueueMessage = function (queueName, message) {
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

_p.dispatchFamilyJob = function(cacheKey, docid) {
    this._log.debug('dispatchFamilyJob:', docid);
    var job = new messages_pb.FamilyJob()
     , buffer
     ;
    job.setDocid(docid);
    job.setCacheKey(cacheKey);
    buffer = new Buffer(job.serializeBinary());
    return this.sendQueueMessage(this._distributorQueueName, buffer);
};

_p.queueListen = function(channelName, consumer) {
    return this._amqp.channel.assertQueue(channelName)
        .then(reply=>this._amqp.channel.consume(reply.queue, consumer));
};

_p.ackQueueMessage = function(message) {
    this._amqp.channel.ack(message);
};

exports.IOOperations = IOOperations;
