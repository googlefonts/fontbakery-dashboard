#! /usr/bin/env node
"use strict";
/* jshint esnext:true, node:true*/

const { ProcessManager:Parent } = require('./framework/ProcessManager')
  , { FamilyPRDispatcherProcess } = require('./FamilyPRDispatcherProcess')
  , { DispatcherProcessManagerService } = require('protocolbuffers/messages_grpc_pb')
  , { ProcessList, ProcessListItem, DispatcherInitProcess } = require('protocolbuffers/messages_pb')
  ;

function DispatcherProcessManager(...args) {

    var anySetup = {
        knownTypes: { DispatcherInitProcess }
      , typesNamespace: 'fontbakery.dashboard'
    };

    args.push(anySetup, FamilyPRDispatcherProcess);
    Parent.call(this, ...args);
    this._server.addService(DispatcherProcessManagerService, this);
}

const _p = DispatcherProcessManager.prototype = Object.create(Parent.prototype);

_p._examineProcessInitMessage = function(initMessage) {
    // This is a basic validation, the super class does not do this.
    // Especially if it knows how to get other message types from an Any,
    // it is possible to send other types here, probably nothing security
    // relevant, but a Murphy's law case after all.
    // Type annotations would be a winner here ;-)
    if(!(initMessage instanceof DispatcherInitProcess))
        throw new Error('Expected initMessage to be an instance of '
                        + 'DispatcherInitProcess, which it isn\'t.');
    var payload = JSON.parse(initMessage.getJsonPayload())
      , requester = initMessage.getRequester()
        // initArgs = {familyName, requester, repoNameWithOwner /*, ... ? */}
      , [errorMessage, initArgs] = this.ProcessConstructor.callbackPreInit(requester, payload)
      ;

    // TODO;
    // Does the familyName exist?
    // Is the requester authorized to do this?
    // Is it OK to init the process now or are there any rules why not?
    // => [ errorMessage, initArgs]
    return [errorMessage || null, errorMessage ? null : initArgs];
};

/**
 * What are the basics that we want to query:
 *      - all processes for a family
 *      - closed/pending/failed processes
 *      - processes with pending user interactions
 *      - processes with pending user interactions, that can be answered
 *        by the authenticated user (role based, where one role is e.g
 *        maintainer:creepster for special cases ...)
 *
 *      - order by last change date
 *      - order by creation
 *      - (more?)
 *      - it should be possible to combine most of the the above!
 *
 *      Do this together with the caching strategy. It's questionable if
 *      we want to go via the Database at all for some of these queries
 *      if the state of the ProcessManager is the canonical state, or,
 *      if using the DB can be fine.
 *      It should be fine to use the DB change feed for lists, as the
 *      process manager put's changes immediately into the persistence
 *      layer. The DB has good options to query, even for live feeds
 *      the interface should be superior than what reasonably can be
 *      implemented in the process manager.
 *
 */
_p.subscribeProcessList = function(call) {
    var processListQuery = call.request
      , unsubscribe = ()=> {
            if(!timeout) // marker if there is an active subscription/call
                return;
            // End the subscription and delete the call object.
            // Do this only once, but, `unsubscribe` may be called more than
            // once, e.g. on `call.destroy` via FINISH, CANCELLED and ERROR.
            this._log.info('subscribeProcessList ... UNSUBSCRIBE');
            clearInterval(timeout);
            timeout = null;
        }
      ;

    this._log.info('processListQuery subscribing to', processListQuery.getQuery());
    this._subscribeCall('process-list', call, unsubscribe);

    var counter = 0, maxIterations = Infinity
      , timeout = setInterval(()=>{
        this._log.debug('subscribeProcessList call.write counter:', counter);

        var processList = new ProcessList();
        for(let i=0,l=3;i<l;i++) {
            let processListItem = new ProcessListItem();
            processListItem.setProcessId(
                            '#' + i + '+-+' + new Date().toISOString());
            processList.addProcesses(processListItem);
        }

        counter++;
        if(counter === maxIterations) {
            //call.destroy(new Error('Just a random server fuckup.'));
            //clearInterval(timeout);
            call.end();
        }
        else
            call.write(processList);

    }, 1000);
};

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


    // FIXME: temprorary local setup overrides.
    setup.db.rethink.host = '127.0.0.1';
    setup.db.rethink.port = '32769';
    setup.amqp = null;


    processManager = new DispatcherProcessManager(
                                        setup.logging
                                      , setup.db
                                      , setup.amqp
                                      , port
                                      , secret);
    processManager.serve()
        .then(
            ()=>setup.logging.info('Server ready!')
          , err => {
                setup.logging.error('Can\'t initialize server.', err);
                process.exit(1);
            }
        );
}
