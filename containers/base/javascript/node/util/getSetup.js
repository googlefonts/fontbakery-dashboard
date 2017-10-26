#! /usr/bin/env node
"use strict";
// this is expected to run in nodejs
/* jshint esnext:true */

const Logging = require('./Logging').Logging
  , rethinkdbdash = require('rethinkdbdash')
  // https://github.com/squaremo/amqp.node
  , amqplib = require('amqplib')
  ;

function getSetup() {
    var rethinkSetup = {
            host: null
          , port: null
          , db: 'fontbakery' // this db will be created
        }
      , dbSetup = {
            rethink: rethinkSetup
          , tables: {
                // these tables will be created
                family: 'familytests'
              , collection: 'collectiontests'
            }

        }
      , amqpSetup = {
            host: process.env.RABBITMQ_SERVICE_SERVICE_HOST
                        || process.env.BROKER
                        || 'amqp://localhost'
        }
      , cacheSetup = {
            // call it: "fontbakery-cache"
            host: process.env.FONTBAKERY_CACHE_SERVICE_HOST
          , port: process.env.FONTBAKERY_CACHE_SERVICE_PORT
        }
      , logging = new Logging(process.env.FONTBAKERY_LOG_LEVEL || 'INFO')
      ;

    if(process.env.RETHINKDB_PROXY_SERVICE_HOST) {
        // in gcloud, we use a cluster with proxy setup
        // the proxy service is called: "rethinkdb-proxy" hence:
        rethinkSetup.host = process.env.RETHINKDB_PROXY_SERVICE_HOST;
        rethinkSetup.port = process.env.RETHINKDB_PROXY_SERVICE_PORT;
    }
    else {
        // Fall back to "rethinkdb-driver"
        rethinkSetup.host = process.env.RETHINKDB_DRIVER_SERVICE_HOST;
        rethinkSetup.port = process.env.RETHINKDB_DRIVER_SERVICE_PORT;
    }

    return {
        amqp: amqpSetup
      , db: dbSetup
      , cache: cacheSetup
      , logging: logging
    };
}

exports.getSetup = getSetup;

function initDB(log, dbSetup) {
    var r = rethinkdbdash(dbSetup.rethink);

    function createDatabase() {
        return r.dbCreate(dbSetup.rethink.db)
            .run()
            //.then(function(response) {/* pass */})
            .error(function(err){
                if (err.message.indexOf('already exists') !== -1)
                    return;
                throw err;
            });

    }

    function createTable(dbTable) {
        return r.tableCreate(dbTable)
            .run()
            //.then(function(response) {/* pass */})
            .error(function(err){
            if (err.message.indexOf('already exists') !== -1)
                return;
            throw err;
        });
    }

    function createTableIndex(tableName, index) {
        return r.table(tableName)
            .indexCreate(index)
            .run()
            .error(function(err){
                if (err.message.indexOf('already exists') !== -1)
                    return;
                throw err;
            });
    }

    return createDatabase()
        //.then(createTable.bind(this, this._dbFamilyTable))
        .then(function() {
            return Promise.all(Object.values(dbSetup.tables).map(createTable));
        })
        .then(function() {
            return createTableIndex(dbSetup.tables.family
                                  , dbSetup.tables.collection + '_id');
        })
        .then(function(){return r;})
        .catch(function(err) {
            // It's not an error if the table already exists
            log.warning('Error while initializing database.', err);
            throw err;
        });
}

exports.initDB = initDB;

function initAmqp(log, amqpSetup) {
    return amqplib.connect('amqp://' + amqpSetup.host)
            .then(function(connection) {
                process.once('SIGINT', connection.close.bind(connection));
                function oncreateChannel(channel) {
                    return {
                        connection: connection
                      , channel: channel
                    };
                }
                return connection.createChannel()
                                 .then(oncreateChannel);
            })
            .catch(function(err) {
                log.error('Error while connecting to queue.', err);
                throw err;
            });
}

exports.initAmqp = initAmqp;
