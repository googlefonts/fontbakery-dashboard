#! /usr/bin/env node
"use strict";
/* jshint esnext:true, node:true*/

const { ProcessManager } = require('./framework/ProcessManager')
  , { FamilyPRDispatcherProcess } = require('./FamilyPRDispatcherProcess')
  ;

if (typeof require != 'undefined' && require.main==module) {
    var { getSetup } = require('../util/getSetup')
      , setup = getSetup(), processManager, port=50051
      , secret = "// TODO: define secret!"
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
    if(!secret.length || secret.indexOf('TODO:') !== -1)
        setup.logging.warning('You really should define a proper secret');
    // Combine ProcessManager and the process definition:FamilyPRDispatcherProcess.


    // FIXME: temprorary local setup overrides.
    setup.db.rethink.host = '127.0.0.1';
    setup.db.rethink.port = '32769';
    setup.amqp = null;


    processManager = new ProcessManager(setup.logging
                                      , setup.db
                                      , setup.amqp
                                      , port
                                      , secret
                                      , FamilyPRDispatcherProcess);
    processManager.serve()
        .then(
            ()=>setup.logging.info('Server ready!')
          , err => {
                setup.logging.error('Can\'t initialize server.', err);
                process.exit(1);
            }
        );
}
