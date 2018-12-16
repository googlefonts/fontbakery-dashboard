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
          , buffer: 10 //<number> - Minimum number of connections available in the pool, default 50
          , max: 1000 //<number> - Maximum number of connections available in the pool, default 1000

        }
      , dbSetup = {
            rethink: rethinkSetup
          , tables: {
                // these tables will be created
                family: 'familytests'
              , collection: 'collectiontests'
              , statusreport: 'statusreports'
              , dispatcherprocesses: 'dispatcherprocesses'
            }
        }
      , amqpSetup = {
            host: process.env.RABBITMQ_SERVICE_SERVICE_HOST
                        || process.env.BROKER
                        || '127.0.0.1'
        }
      , cacheSetup = {
            // call it: "fontbakery-cache"
            host: process.env.FONTBAKERY_CACHE_SERVICE_HOST
          , port: process.env.FONTBAKERY_CACHE_SERVICE_PORT
        }
      , reportsSetup = {
            // call it: "fontbakery-reports"
            host: process.env.FONTBAKERY_REPORTS_SERVICE_HOST
          , port: process.env.FONTBAKERY_REPORTS_SERVICE_PORT
        }
      , dispatcherSetup = {
            // call it: "fontbakery-dispatcher"
            host: process.env.FONTBAKERY_DISPATCHER_HOST
          , port: process.env.FONTBAKERY_DISPATCHER_PORT
        }
      , logging = new Logging(process.env.FONTBAKERY_LOG_LEVEL || 'INFO')
      , develFamilyWhitelist = null
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

    // setup.develFamilyWhitelist is used in the manifestSources implementations
    if(process.env.DEVEL_FAMILY_WHITELIST) {
        develFamilyWhitelist = new Set(JSON.parse(process.env.DEVEL_FAMILY_WHITELIST));
        if(!develFamilyWhitelist.size)
            develFamilyWhitelist = null;
    }


    return {
        amqp: amqpSetup
      , db: dbSetup
      , cache: cacheSetup
      , reports: reportsSetup
      , dispatcher: dispatcherSetup
      , logging: logging
      , develFamilyWhitelist: develFamilyWhitelist
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

    function createTableIndex(dbTable, index) {
        var tableName = dbSetup.tables[dbTable]
          , query = r.table(tableName)
          , index_ =  index instanceof Array ? index : [index]
          ;
        return query.indexCreate.apply(query, index_)
            .run()
            .error(function(err) {
                if (err.message.indexOf('already exists') !== -1)
                    return;
                throw err;
            })
            // Wait for the index to be ready to use
            .then(function(){
                return r.table(tableName)
                        .indexWait(index_[0])
                        .run();
            });
    }

    return createDatabase()
        //.then(createTable.bind(this, this._dbFamilyTable))
        .then(function() {
            return Promise.all(Object.values(dbSetup.tables).map(createTable));
        })
        .then(function() {
            // create indexes for dbSetup.tables.family
            // [environment_version, test_data_hash]
            var index = [
                    'env_hash'
                  , [r.row('environment_version'), r.row('test_data_hash')]
                ];
            return createTableIndex('family', index);
        })
        .then(function() {
            // create indexes for dbSetup.tables.collection
            // TODO: dbSetup.tables.collection needs probably some more indexes!
            return Promise.all([
                // collection_id
                createTableIndex('collection', 'collection_id')
                // collection_id | family_name
              , createTableIndex('collection', ['collection_family'
                        , [r.row('collection_id'), r.row('family_name')]])
                // familytests_id
              , createTableIndex('collection', dbSetup.tables.family + '_id')
                // date
              , createTableIndex('collection', 'date')
            ]);
        })
        .then(()=>{
            //  create indexes for dbSetup.tables.statusreport
            return Promise.all([
                //reported
                createTableIndex('statusreport', 'reported')
                // reported | id
                // this index exists to make it possible to orderBy `reported`
                // while doing an (optimized by index) pagination using `id`.
              , createTableIndex('statusreport', ['reported_id'
                                        , [r.row('reported'), r.row('id')]])
            ]);
        })
        .then(()=>{
            //  create indexes for dbSetup.tables.dispatcherprocesses
            return Promise.resolve(true);// placeholder
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
    return amqplib.connect('amqp://' + amqpSetup.host + "?heartbeat=600")
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
