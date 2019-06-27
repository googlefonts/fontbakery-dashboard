#! /usr/bin/env node
"use strict";
/* jshint esnext:true, node:true*/

const { ProcessManager:Parent } = require('./framework/ProcessManager')
  , { FamilyPRDispatcherProcess } = require('./FamilyPRDispatcherProcess')
  , { DispatcherProcessManagerService } = require('protocolbuffers/messages_grpc_pb')
  , { ManifestClient } = require('../util/ManifestClient')
  , { StorageClient } = require('../util/StorageClient')
  , { PullRequestDispatcherClient } = require('../util/PullRequestDispatcherClient')
  , { InitWorkersClient } = require('../util/InitWorkersClient')
  , {
        ProcessList
      , ProcessListItem
      , DispatcherInitProcess
      , ManifestSourceId
      , FamilyRequest
      , File
      , Files
    } = require('protocolbuffers/messages_pb')
  ;

function _makeFamilyRequest(sourceId, familyName) {
    var familyRequestMessage = new FamilyRequest();
    familyRequestMessage.setSourceId(sourceId);
    familyRequestMessage.setFamilyName(familyName);
    return familyRequestMessage;
}

function DispatcherProcessManager(setup, ...args) {
    var anySetup = {
        knownTypes: { DispatcherInitProcess }
    };
    args.push(anySetup, FamilyPRDispatcherProcess);
    Parent.call(this, setup, ...args);
    this._executeQueueName = 'fontbakery-dispatcher-process-manager-execute';
    this._server.addService(DispatcherProcessManagerService, this);

    this._manifestUpstreamClient = new ManifestClient(
                            setup.logging
                          , setup.manifestUpstream.host
                          , setup.manifestUpstream.port);
    this._asyncDependencies.push([this._manifestUpstreamClient, 'waitForReady']);

    this._manifestGoogleFontsAPIClient = new ManifestClient(
                            setup.logging
                          , setup.manifestGoogleFontsAPI.host
                          , setup.manifestGoogleFontsAPI.port);
    this._asyncDependencies.push([this._manifestGoogleFontsAPIClient, 'waitForReady']);

    this._persistenceClient = new StorageClient(
                              setup.logging
                            , setup.persistence.host
                            , setup.persistence.port
                            , {File, Files});
    this._asyncDependencies.push([this._persistenceClient, 'waitForReady']);

    this._cacheClient = new StorageClient(
                              setup.logging
                            , setup.cache.host
                            , setup.cache.port
                            , {File, Files});
    this._asyncDependencies.push([this._cacheClient, 'waitForReady']);

    this._initWorkers = new InitWorkersClient(
                              setup.logging
                            , setup.initWorkers.host
                            , setup.initWorkers.port);
    this._asyncDependencies.push([this._initWorkers, 'waitForReady']);

    this._gitHubPRClient = new PullRequestDispatcherClient(
                              setup.logging
                            , setup.gitHubPR.host
                            , setup.gitHubPR.port
                            );
    this._asyncDependencies.push([this._gitHubPRClient, 'waitForReady']);

    Object.defineProperties(this._processResources, {
        // I prefer not to inject the this._manifestUpstreamClient
        // directly, but instead provide simplified interfaces.
        getUpstreamFamilyList: {
            value: ()=>{
                var sourceIdMessage = new ManifestSourceId();
                sourceIdMessage.setSourceId('upstream');
                return this._manifestUpstreamClient
                    .list(sourceIdMessage)
                    .then(familyNamesList=>familyNamesList.getFamilyNamesList());
            }
        }
      , getUpstreamFamilyFiles: {
            value: familyName=>{
                // rpc Get (FamilyRequest) returns (FamilyData){}
                // returns a promise for FamilyData
                var familyRequestMessage = _makeFamilyRequest('upstream', familyName);
                return this._manifestUpstreamClient.get(familyRequestMessage)
                    .then(null, error=>{
                        this._log.error(`Error getUpstreamFamilyFiles(${familyName})`, error);
                        // re-raise
                        throw error;
                    });
            }
        }
      , getUpstreamFamilySourceDetails: {
            value: familyName=>{
                // rpc GetSourceDetails (FamilyRequest) returns (SourceDetails){}
                // returns a promise for SourceDetails
                var familyRequestMessage = _makeFamilyRequest('upstream', familyName);
                return this._manifestUpstreamClient.getSourceDetails(familyRequestMessage)
                    .then(null, error=>{
                        this._log.error(`Error getUpstreamFamilyFiles(${familyName})`, error);
                        // re-raise
                        throw error;
                    });
            }
        }
      , getGoogleFontsAPIFamilyFiles: {
            value: familyName=>{
                // rpc Get (FamilyRequest) returns (FamilyData){}
                // returns a promise for FamilyData
                var familyRequestMessage = _makeFamilyRequest('production', familyName);
                return this._manifestGoogleFontsAPIClient.get(familyRequestMessage);
            }
        }
      , persistence: {
            value: this._persistenceClient
        }
      , cache: {
            value: this._cacheClient
        }
      , initWorker: {
            value: (...args)=>this._initWorkers.initialize(...args)
        }
      , executeQueueName: {
            value: this._executeQueueName
        }
      , dispatchPR: {
                   // -> Promise.resolve(new Empty())
            value: pullRequestMessage=>this._gitHubPRClient.dispatch(pullRequestMessage)
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
    processManager = new DispatcherProcessManager(
                                        setup
                                      , port
                                      , setup.dispatcherManagerSecret);
    processManager.serve()
        .then(
            ()=>setup.logging.info('Server ready!')
          , err => {
                setup.logging.error('Can\'t initialize server.', err);
                process.exit(1);
            }
        );
}
