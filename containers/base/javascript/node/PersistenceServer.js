#! /usr/bin/env node
"use strict";
// this is expected to run in nodejs
/* global require, module */
/* jshint esnext:true */

const getSetup = require('./util/getSetup').getSetup
  , { PersistenceServer } = require('./util/StorageServers')
  ;

if (typeof require != 'undefined' && require.main==module) {
    var setup = getSetup(), persistenceServer, port=50051
      , dataItemTimeOutMinutes = 60
      , dataDirDefault = '/tmp/persistence_server'
      , dataDir = null
      ;

    for(let i=0,l=process.argv.length;i<l;i++) {
        if(process.argv[i] === '-p' && i+1<l) {
            let foundPort = parseInt(process.argv[i+1], 10);
            if(foundPort >= 0) // not NaN or negative
                port = foundPort;
            i++;
        }
        if(process.argv[i] === '-d' && i+1<l) {
            dataDir = process.argv[i+1];
            i++;
        }
    }
    setup.logging.info('Init server, port: '+ port +' ...');
    setup.logging.log('Loglevel', setup.logging.loglevel);

    if('FONTBAKERY_PERSISTENT_DATA_DIR' in process.env)
        dataDir = process.env.FONTBAKERY_PERSISTENT_DATA_DIR;
    else {
        setup.logging.warning('dataDir is not specified. Default:', dataDirDefault);
        dataDir = dataDirDefault;
    }

    persistenceServer = new PersistenceServer(setup.logging, port
                            , dataDir, dataItemTimeOutMinutes);
    persistenceServer.serve();
}
