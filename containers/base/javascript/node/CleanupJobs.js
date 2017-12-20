#! /usr/bin/env node
"use strict";
// this is expected to run in nodejs
/* global require, module */
/* jshint esnext:true */

const messages_pb = require('protocolbuffers/messages_pb')
  , { getSetup, initDB, initAmqp } = require('./util/getSetup')
  , { CacheClient }  = require('./util/CacheClient')
  ;

// listen to queue_out_name='fontbakery-cleanup-distributor'
// if feasible, finish the family job
// if the job is finished and if the job was a collection job
//      if feasible, finish collection job
function CleanupJobs(logging, amqpSetup, dbSetup, cacheSetup) {
    this._log = logging;
    this._cache = new CacheClient(logging, cacheSetup.host, cacheSetup.port);
    this._dbSetup = dbSetup;
    this._collectiontest_key = this._dbSetup.tables.collection + '_id';
    this._cleanupQueueName = 'fontbakery-cleanup-distributor';
    this._r = null;
    this._amqp = null;
    Promise.all([
                 initDB(this._log, dbSetup)
               , initAmqp(this._log, amqpSetup)
               , this._cache.waitForReady()
               ])
    .then(function(resources){
        this._r = resources[0];
        this._amqp = resources[1];
    }.bind(this))
    .then(this._listen.bind(this))
    .catch(function(err) {
        this._log.error('Can\'t initialize server.', err);
        process.exit(1);
    }.bind(this));
}

var _p = CleanupJobs.prototype;


_p._query = function(dbTable) {
    return this._r.table(dbTable);
};

/*
_p._queryCollectionTest = function(docid) {
    // jshint unused:vars
    throw new Error('Not implemented "_queryCollectionTest".');
    //return this._query(this._dbSetup.tables.collection)
    //....
    //    .get(docid)
    //      ???
    //    .pluck(this._collectiontest_key, "jobs", "created", "started"
    //                            , "finished", "exception", "isFinished")
    //    .run()
};
*/
_p._queryFamilyTestDoc = function(docid) {
    return this._query(this._dbSetup.tables.family)
        .get(docid)
        .pluck(this._collectiontest_key, "jobs", "finished")
        .run()
        ;
};

/*
_p._checkCollectionDoc = function(docid, doc) {
    // jshint unused:vars
    throw new Error('Not implemented "_checkCollectionDoc".');
};
*/

// check if it is feasible, to finish the family job
_p._checkFamilyDoc = function(job, doc) {
    var isFinished // if doc has a `finished` date
       , needsFinish
       , promises = [], promise
       ;
    function _needsFinish(doc) {
        if(doc.finished)
            return false;
        // check if all sub-jobs are finished
        for(let id in doc.jobs)
            if(!doc.jobs[id].finished)
                return false;
        return true;
    }

    needsFinish = _needsFinish(doc);
    if(needsFinish) {
        promises.push(this._query(this._dbSetup.tables.family)
                          .get(job.getDocid())
                          .update({finished: new Date()})
                          .run()

        );
    }

    isFinished = needsFinish || doc.finished;

    if(isFinished) {
        // will force other open sub-jobs into failing
        // but at this point, this is our best option.
        // We don't know if another cleanup message will come again for
        // this cacheKey!
        promises.push(this._cache.purge(job.getCachekey()));
    }

    promise = Promise.all(promises);
    // This (`collectiontest_id`) is not in the db-model anymore!
    // if(isFinished && this._collectiontest_key in doc) {
    //     let collectiontest_id = doc[this._collectiontest_key];
    //     // this is part of a collection test
    //     // we must check if the collection test is finished
    //     return promise.then(this._queryCollectionTest
    //                             .bind(this, collectiontest_id))
    //                   .then(this._checkCollectionDoc
    //                             .bind(this, collectiontest_id /* -> doc */))
    //                   ;
    // }
    return promise;
};

// consuming this._cleanupQueueName
_p._consumeQueue = function(channel, message) {
    this._log.debug('_consumeQueue');
    // message = {
    //     content: Buffer
    //   , fields: Object
    //   , properties: Object
    // }

    // if this has a job id it's a distributed job
    var job = messages_pb.FamilyJob.deserializeBinary(
                                new Uint8Array(Buffer.from(message.content)));
    this._log.info('cleaning up job for docid', job.getDocid());
    // Actually, I'm not interested in the test results here (maybe to check
    // if they are complete, what they should be if there's no exception
    // anywhere in the doc;).

    this._queryFamilyTestDoc(job.getDocid())
        .then(this._checkFamilyDoc.bind(this, job /* -> doc */))
        // when finishing without errors
        .then(()=>channel.ack(message))
        .catch(function(error) {
            this._log.error(error);
            // re-raise => makes it unhandled, but better than stopping it,
            // we don't have a good concept for this now.
            throw error;
        }.bind(this))
        ;

};

// start the server
_p._listen = function() {
    this._log.debug('_listen');
    function consume(reply) {
        // jshint validthis:true
        /*
        "ok" reply of assertQueue from the server, which includes fields
        for the queue name (important if you let the server name it),
        a recent consumer count, and a recent message count; e.g.,
        {
             queue: 'foobar',// === this._cleanupQueueName
             messageCount: 0,
             consumerCount: 0
        }
        */
        return this._amqp.channel.consume(reply.queue, this._consumeQueue.bind(this, this._amqp.channel));
    }
    return this._amqp.channel.assertQueue(this._cleanupQueueName)
        .then(consume.bind(this))
        /*
        .then(function(reply) {
            // consumerTag: It is necessary to remember this somewhere
            // if you will later want to cancel this consume operation
            // (i.e., to stop getting messages).
            reply.consumerTag;
        })
        */
        ;
};

if (typeof require != 'undefined' && require.main==module) {
    var setup = getSetup();
    setup.logging.log('Loglevel', setup.logging.loglevel);
    new CleanupJobs(setup.logging, setup.amqp, setup.db, setup.cache);
}
