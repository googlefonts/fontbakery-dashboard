#! /usr/bin/env node
"use strict";
// this is expected to run in nodejs
/* jshint esnext:true */

const Logging = require('./Logging').Logging
  , rethinkdbdash = require('rethinkdbdash')
  // https://github.com/squaremo/amqp.node
  , amqplib = require('amqplib')
  ;


function _getter(target, [source, sourceName], toKey, fromKey, parser, ...defaultVal) {
    Object.defineProperty(target, toKey, {
        get: ()=> {
            var val = source[fromKey];
            if(!val || !val.length) {
                if(defaultVal.length)
                    val = defaultVal[0];
                else
                    throw new Error('SETUP MISSING value for "'+toKey+'" '
                        + 'at ' + sourceName + '["'+fromKey+'"].');
            }
            // e.g.: parser = JSON.parse
            if(!parser)
                return val;
            try {
                return parser(val);
            }
            catch(error) {
                throw new Error('SETUP PARSER value for "'+toKey+'" '
                        + 'at ' + sourceName + '["'+fromKey+'"]. '
                        + error);
            }
        }
      , configurable: false // use Inheritance to do this
      , enumerable: true
    });
    return target;
}

function _envGetter(target, toKey, fromKey, parser, ...defaultVal) {
    return _getter(target, [process.env, 'process.env'], toKey, fromKey, parser, ...defaultVal);
}

function _multiEnvGetter(target, toFromParserDefault) {
    for(let [toKey, fromKey, parser, ...defaultVal] of toFromParserDefault)
        _envGetter(target, toKey, fromKey, parser, ...defaultVal);
    return target;
}


function _subSetupGetter(target, toKey, subSetup) {
    Object.defineProperty(target, toKey, {
            get: ()=>{
                var result = {}, errors = [], message;
                for(let key of Object.keys(subSetup)) {
                    try {
                        result[key] = subSetup[key];
                    }
                    catch(e){
                        errors.push([key, e]);
                    }
                }
                if(errors.length) {
                    message = 'Setup can\'t get "'+toKey+'"; with errors:\n';
                    message += errors.map((k,e)=>'  '+k+': '+ e.message).join('\n');
                    throw new Error(message);
                }
                return result;
            }
          , configurable: false // use Inheritance to do this
          , enumerable: true
    });
    return target;
}

/**
 * The resulting setup opject will raise an error if a value that
 * is expected to be externally defined (e.g. via process.env) is
 * not available, but *ONLY* at access time, as not all pods/services
 * will need all setup variables.
 * This is to have rather failing pods than pods that start with
 * missing setup.
 */
function getSetup() {
    var setup = {}
      , rethinkSetup = {
          // host: done below
          // port: done below
            db: 'fontbakery' // this db will be created
          , buffer: 10 //<number> - Minimum number of connections available in the pool, default 50
          , max: 1000 //<number> - Maximum number of connections available in the pool, default 1000

        }
      , dbSetup = {
            // rethink: done below rethinkSetup
            tables: {
                // these tables will be created
                family: 'familytests'
              , collection: 'collectiontests'
              , statusreport: 'statusreports'
              , dispatcherprocesses: 'dispatcherprocesses'
            }
        }
      , rethinkProviderName = process.env.RETHINKDB_PROXY_SERVICE_HOST
                              // in gcloud, we use a cluster with proxy setup
                              // the proxy service is called: "rethinkdb-proxy" hence:
                              ? 'RETHINKDB_PROXY_SERVICE'
                              // Fall back to "rethinkdb-driver"
                              : 'RETHINKDB_DRIVER_SERVICE'
      ;

    _subSetupGetter(dbSetup, 'rethink', _multiEnvGetter(rethinkSetup, [
            ['host', rethinkProviderName + '_HOST']
          , ['port', rethinkProviderName + '_PORT']
        ])
    );
    setup.db = dbSetup;

    // this kind of sub-setup is so common  we can
    // define it more compact it in here
    for(let [key, toFromParserDefault] of Object.entries({
          amqp: [
                ['host', 'RABBITMQ_SERVICE_SERVICE_HOST'
                              , null, process.env.BROKER || '127.0.0.1']
            ]
          , cache: [
                // call it: "fontbakery-storage-cache" in kybernetes
                ['host', 'FONTBAKERY_STORAGE_CACHE_SERVICE_HOST']
              , ['port', 'FONTBAKERY_STORAGE_CACHE_SERVICE_PORT']
            ]
          , persistence: [
                // call it: "fontbakery-storage-persistence" in kybernetes
                ['host', 'FONTBAKERY_STORAGE_PERSISTENCE_SERVICE_HOST']
              , ['port', 'FONTBAKERY_STORAGE_PERSISTENCE_SERVICE_PORT']
            ]
          , reports: [
                // call it: "fontbakery-reports" in kybernetes
                ['host', 'FONTBAKERY_REPORTS_SERVICE_HOST']
              , ['port', 'FONTBAKERY_REPORTS_SERVICE_PORT']
            ]
          , dispatcher: [
                // call it: "fontbakery-dispatcher" in kybernetes
                ['host', 'FONTBAKERY_DISPATCHER_SERVICE_HOST']
              , ['port', 'FONTBAKERY_DISPATCHER_SERVICE_PORT']
            ]
          , gitHubPR: [
                // call it: "fontbakery-github-pr" in kybernetes
                ['host', 'FONTBAKERY_GITHUB_PR_SERVICE_HOST']
              , ['port', 'FONTBAKERY_GITHUB_PR_SERVICE_PORT']
            ]
          , gitHubAuth: [
                // call it: "fontbakery-github-auth" in kybernetes
                ['host', 'FONTBAKERY_GITHUB_AUTH_SERVICE_HOST']
              , ['port', 'FONTBAKERY_GITHUB_AUTH_SERVICE_PORT']
            ]
          , manifestUpstream: [
                // call it: "fontbakery-manifest-csvupstream" in kybernetes
                ['host', 'FONTBAKERY_MANIFEST_CSVUPSTREAM_SERVICE_HOST']
              , ['port', 'FONTBAKERY_MANIFEST_CSVUPSTREAM_SERVICE_PORT']
            ]
          , manifestGoogleFontsAPI: [
                // call it: "fontbakery-manifest-gfapi" in kybernetes
                ['host', 'FONTBAKERY_MANIFEST_GFAPI_SERVICE_HOST']
              , ['port', 'FONTBAKERY_MANIFEST_GFAPI_SERVICE_PORT']
            ]
          , initWorkers: [
                // call it: "fontbakery-init-workers" in kybernetes
                ['host', 'FONTBAKERY_INIT_WORKERS_SERVICE_HOST']
              , ['port', 'FONTBAKERY_INIT_WORKERS_SERVICE_PORT']
            ]
           , gitHubOAuthCredentials: [
                ['clientId', 'GITHUB_OAUTH_CLIENT_ID']
              , ['clientSecret', 'GITHUB_OAUTH_CLIENT_SECRET']
            ]
    })){
        _subSetupGetter(setup, key, _multiEnvGetter({}, toFromParserDefault));
    }

    _multiEnvGetter(setup, [
            ['webServerCookieSecret', 'WEB_SERVER_COOKIE_SECRET']
          , ['dispatcherManagerSecret', 'DISPATCHER_MANAGER_SECRET']
            // This is currently an oauth token for a specific user
            // (i.e. me, @graphicore, can definetly lead to quota trouble.)
          , ['gitHubAPIToken', 'GITHUB_API_TOKEN']
          , ['googleAPIKey', 'GOOGLE_API_KEY']
          , ['gitHubAuthEngineers', 'GITHUB_AUTH_ENGINEERS'
              , value=>new Set(JSON.parse(value))/*???default: '[]' empty list */
            ]
          , ['develFamilyWhitelist', 'DEVEL_FAMILY_WHITELIST'
              , value=>new Set(JSON.parse(value)), null
            ]
    ]);

    setup.logging = new Logging(process.env.FONTBAKERY_LOG_LEVEL || 'INFO');
    return setup;
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
            return Promise.all([
                createTableIndex('family', index)
              , createTableIndex('family', 'created')
            ]);
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
