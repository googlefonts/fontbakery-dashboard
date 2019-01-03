#! /usr/bin/env node
"use strict";
/* jshint esnext:true, node:true*/

const { ProcessManager:Parent } = require('./framework/ProcessManager')
  , { FamilyPRDispatcherProcess } = require('./FamilyPRDispatcherProcess')
  , { DispatcherProcessManagerService } = require('protocolbuffers/messages_grpc_pb')
  , { ManifestClient } = require('../util/ManifestClient')
  , {
        ProcessList
      , ProcessListItem
      , DispatcherInitProcess
      , ManifestSourceId
      , FamilyRequest
    } = require('protocolbuffers/messages_pb')
  ;

function DispatcherProcessManager(setup, ...args) {
    var anySetup = {
        knownTypes: { DispatcherInitProcess }
      , typesNamespace: 'fontbakery.dashboard'
    };
    args.push(anySetup, FamilyPRDispatcherProcess);
    Parent.call(this, setup, ...args);
    this._server.addService(DispatcherProcessManagerService, this);

    this._manifestSpreadsheetClient = new ManifestClient(
                            setup.logging
                          , setup.manifestSpreadsheet.host
                          , setup.manifestSpreadsheet.port);
    this._asyncDependencies.push([this._manifestSpreadsheetClient, 'waitForReady']);

    Object.defineProperties(this._processResources, {
        // I prefer not to inject the this._manifestSpreadsheetClient
        // directly, but instead provide simplified interfaces.
        getUpstreamFamilyList: {
            value: ()=>{
                var sourceIdMessage = new ManifestSourceId();
                sourceIdMessage.setSourceId('upstream');
                return this._manifestSpreadsheetClient
                    .list(sourceIdMessage)
                    .then(familyNamesList=>familyNamesList.getFamilyNamesList());
            }
        }
      , getUpstreamFamilyFiles: {
            value: (familyName)=>{
                // rpc Get (FamilyRequest) returns (FamilyData){}
                var familyRequestMessage = new FamilyRequest();
                familyRequestMessage.setSourceId('upstream');
                familyRequestMessage.setFamilyName(familyName);
                // returns a promise for FamilyData
                return this._manifestSpreadsheetClient.get(familyRequestMessage);
            }

        }
    });
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
      ;

    return this.ProcessConstructor.callbackPreInit(this._processResources, requester, payload)
    .then(([errorMessage, initArgs])=>{
        // TODO;
        // Does the familyName exist?
        // Is the requester authorized to do this?
        // Is it OK to init the process now or are there any rules why not?
        // => [ errorMessage, initArgs]
        return [errorMessage || null, errorMessage ? null : initArgs];
    });
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


    // FIXME: temporary local setup overrides.
    setup.db.rethink.host = '127.0.0.1';
    setup.db.rethink.port = '32769';
    setup.amqp = null;
    setup.manifestSpreadsheet={host: '127.0.0.1', port: '9012'};

    processManager = new DispatcherProcessManager(
                                        setup
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
