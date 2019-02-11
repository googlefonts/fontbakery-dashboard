#! /usr/bin/env node
"use strict";
// this is expected to run in nodejs
/* global require */
/* jshint esnext:true */


const { initDB, initAmqp }= require('./getSetup')
  , { FamilyJob } = require('protocolbuffers/messages_pb')
  ;

function IOOperations(logging, dbSetup, amqpSetup) {
    this._log = logging;
    this._dbSetup = dbSetup;
    this._amqpSetup = amqpSetup;
    this._initPromise = null;
    this._r = null;
    this._dbTables = this._dbSetup && this._dbSetup.tables || {};
    this._amqp = null;
}

var _p = IOOperations.prototype;

/**
 * same as pythons builtin `zip` function
 */
function zip(...arrays) {
    var result = [];
    for(let i=0,l=Math.min(...arrays.map(a=>a.length));i<l;i++) {
        let row = [];
        for(let a of arrays) row.push(a[i]);
        result.push(row);
    }
    return result;
}

_p.init = function() {
    if(!this._initPromise) {
        let promises = [], names = []
          , pushPromise = (name, promise) => {
                promises.push(promise);
                names.push(name);
            }
          ;
        if(this._dbSetup)
            pushPromise('_r', initDB(this._log, this._dbSetup));
        if(this._amqpSetup)
            pushPromise('_amqp', initAmqp(this._log, this._amqpSetup));

        this._initPromise = Promise.all(promises)
            .then(resources=>{
                let names_resources = zip(names, resources);
                for(let [name, resource] of names_resources)
                    this[name] = resource;
                return resources;
            });
    }
    return this._initPromise;
};

Object.defineProperties(_p, {
    r: {
        get: function() {
            if(!this._r)
                throw new Error('Database resource "this._r" was not configured.');
            return this._r;
        }
    }
  , amqp: {
        get: function() {
            if(!this._amqp)
                throw new Error('Messaging Queue resource "this._amqp" was not configured.');
            return this._amqp;
        }
    }
  , hasAmqp: {
        get: function() {
            return !!this._amqp;
        }
    }

});

_p.query = function(dbTable) {
    let r = this.r // raises if db was not configured;
      , realTableName = this._dbTables[dbTable]
      ;
    return r.table(realTableName);
};

_p.insertDoc = function(dbTable, doc) {
    return this.query(dbTable).insert(doc).run()
        .error(function(err) {
            this._log.error('Creating a doc failed ', err);
            throw err; // re-raise
        });
};

_p.getLatesCollectionEntry = function(collection_id, family_name) {
    return this.query('collection')
            .getAll([collection_id, family_name], {index:'collection_family'})
            .orderBy(this.r.desc('date'))
            .limit(1)
            // => should return just the first element
            // .nth(0) there's no description what it does if the element doesn't exist!
            // but it looks like we get an error
            .run()
            .then(entries=>entries[0]) // => entry or undefined
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
        // this._log.info('sendToQueue: ', queueName);
        return this.amqp.channel.sendToQueue(queueName, message, options);
    }
    return this.amqp.channel.assertQueue(queueName, {durable: true})
           .then(sendMessage.bind(this))
           ;
};

_p.queueListen = function(channelName, consumer) {
    return this.amqp.channel.assertQueue(channelName)
        .then(reply=>this.amqp.channel.consume(reply.queue, consumer));
};

_p.ackQueueMessage = function(message) {
    this.amqp.channel.ack(message);
};

exports.IOOperations = IOOperations;
