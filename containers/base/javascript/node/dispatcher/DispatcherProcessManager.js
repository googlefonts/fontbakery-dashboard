#! /usr/bin/env node
"use strict";
/* jshint esnext:true, node:true*/

const { ProcessManager } = require('./dispatcher/framework/ProcessManager')
  , { FamilyPRDispatcherProcess } = require('./dispatcher/FamilyPRDispatcherProcess')
  ;

if (typeof require != 'undefined' && require.main==module) {
    var setup = getSetup(), processManager, port=50051;

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
    // Combine ProcessManager and the process definition:FamilyPRDispatcherProcess.
    processManager = new ProcessManager(setup.logging, setup.db, port, secret, FamilyPRDispatcherProcess);
    processManager.serve()
        .catch(err => {
            setup.logging.error('Can\'t initialize server.', err);
            process.exit(1);
        });
}
