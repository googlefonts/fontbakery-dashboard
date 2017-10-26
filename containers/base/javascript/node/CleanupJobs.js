#! /usr/bin/env node
"use strict";
// this is expected to run in nodejs
/* global require, module */
/* jshint esnext:true */

const messages_pb = require('protocolbuffers/messages_pb')
  , { getSetup, initDB, initAmqp } = require('./util/getSetup')
  , { CacheClient }  = require('./CacheClient')
  ;

// listen to queue_out_name='fontbakery-cleanup-distributor'
// if feasible, finish the family job
// if the job is finished and if the job was a collection job
//      if feasible, finish collection job
function CleanupJobs(logging, amqpSetup, dbSetup, cacheSetup) {
    this._cache = new CacheClient(logging, cacheSetup.host, cacheSetup.port);
    this._dbSetup = dbSetup;
    this._cleanupQueueName = 'fontbakery-cleanup-distributor';
    this._r = null;
    this._amqp = null;
    Promise.all([
                 initDB(this._log, dbSetup)
               , initAmqp(this._log, amqpSetup)
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

    //?? ... return this._amqp.connection.createChannel()
}

var _p = CleanupJobs.prototype;


// check if it is feasible, to finish the family job
_p._checkFamilyJobNeedsFinish = function(doc) {
    // What if it is already finished here? That should rather not happen
    // but in race conditions, it is possible I assume. Depends on all
    // the async stuff that's going on.
    // We still should run all the closing actions (again)

    needsFinish:

    We try to figure if the document will change in the future
    unfortunately, sub jobs may fail and restart and then succeed ...
    which would change the result even after isFinished is set
    maybe, the subjob should check if it is a rerun and then at least
    reset its predecessors statuses and move them to some kind of history
    entry

    doc.isFinished is true -- will never be unset
        or doc.finished is set
        or doc.exception is set
        or in all doc.jobs `finished` or `exception` is set
        or in any doc.jobs `finished` is set

    if(true)
        return this._finishJob(job, doc);
}

// consuming this._cleanupQueueName
_p._consumeQueue = function(message) {
    // message = {
    //     content: Buffer
    //   , fields: Object
    //   , properties: Object
    // }
    var job = messages_pb.DistributedFamilyJob.deserializeBinary(
                                new Uint8Array(message.content.buffer));

    this._query(job.docid)
        .then(function(){})
    job;
    // finally
    this._amqp.channel.ack(message);
};

// start the server
_p._listen = function() {
    this._log.debug('_listen');
    function consume(reply) {
        // jshint validthis:true
        // "ok" reply from the server, which includes fields for
        // the queue name (important if you let the server name it),
        // a recent consumer count, and a recent message count; e.g.,
        // {
        //      queue: 'foobar',// === this._cleanupQueueName
        //      messageCount: 0,
        //      consumerCount: 0
        // }
        return this._amqp.channel.consume(reply.queue, this._consumeQueue.bind(this));
    }
    return this._amqp.channel.assertQueue(this._cleanupQueueName)
        .then(consume.bind(this))
        //.then(function(reply) {
        //    // consumerTag: It is necessary to remember this somewhere
        //    // if you will later want to cancel this consume operation
        //    // (i.e., to stop getting messages).
        //    reply.consumerTag;
        //})
        ;
};

if (typeof require != 'undefined' && require.main==module) {
    var setup = getSetup();
    setup.logging.log('Loglevel', setup.logging.loglevel);
    new CleanupJobs(setup.logging, setup.amqp, setup.db, setup.cache);
}
