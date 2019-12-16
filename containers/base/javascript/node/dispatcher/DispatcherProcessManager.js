#! /usr/bin/env node
"use strict";
/* jshint esnext:true, node:true*/

const { ProcessManager:Parent } = require('./framework/ProcessManager')
  , { FamilyPRDispatcherProcess } = require('./FamilyPRDispatcherProcess')
  , { DispatcherProcessManagerService } = require('protocolbuffers/messages_grpc_pb')
  , { ManifestClient } = require('../util/ManifestClient')
  , { StorageClient } = require('../util/StorageClient')
  , { GitHubOperationsClient } = require('../util/GitHubOperationsClient')
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

function _makeFamilyRequest(sourceId, familyKey, processCommand=null) {
    var familyRequestMessage = new FamilyRequest();
    familyRequestMessage.setSourceId(sourceId);
    familyRequestMessage.setFamilyName(familyKey);
    if(processCommand)
        familyRequestMessage.setProcessCommand(processCommand);
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

    this._manifestGitHubGFClient = new ManifestClient(
                            setup.logging
                          , setup.manifestGitHubGF.host
                          , setup.manifestGitHubGF.port);
    this._asyncDependencies.push([this._manifestGitHubGFClient, 'waitForReady']);

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

    this._gitHubOperationsClient = new GitHubOperationsClient(
                              setup.logging
                            , setup.gitHubOperations.host
                            , setup.gitHubOperations.port
                            );
    this._asyncDependencies.push([this._gitHubOperationsClient, 'waitForReady']);

    Object.defineProperties(this._processResources, {
        // I prefer not to inject the this._manifestUpstreamClient
        // directly, but instead provide simplified interfaces.
        getFamilyList: {
            value: (sourceID)=>{
                var sourceIdMessage = new ManifestSourceId();
                sourceIdMessage.setSourceId(sourceID);
                return this._manifestUpstreamClient
                    .list(sourceIdMessage)
                    .then(familyKeysList=>familyKeysList.getFamilyNamesList());
            }
        }
      , getFamilyDataDelayed: {
            value: (sourceID, familyKey, processCommand)=>{
               var sourceClient, familyRequestMessage;
               switch(sourceID){
                    case ('sandbox-upstream'):
                        // falls through
                    case ('upstream'):
                        sourceClient = this._manifestUpstreamClient;
                        break;
                    // TODO: not implemented GF sandbox
                    // case ('sandbox'):
                    //    // falls through
                    case ('production'):
                        sourceClient = this._manifestGoogleFontsAPIClient;
                        break;
                    // NOTE: pulls has `get` NOT IMPLEMENTED! it's just here
                    // for completeness, but unusable in this context.
                    case ('pulls'):
                        // falls through
                    case ('master'):
                        sourceClient = this._manifestGitHubGFClient;
                        break;
                    default:
                        // this is a programming error
                        throw new Error(`Family source "${sourceID}" is not known.`);
                }
                familyRequestMessage = _makeFamilyRequest(
                                    sourceID, familyKey, processCommand);
                return sourceClient.getDelayed(familyRequestMessage)
                    .then(null, error=>{
                        this._log.error('Error getFamilyDataDelayed('
                                   + `${sourceID}, ${familyKey})`, error);
                        // re-raise
                        throw error;
                    });
            }
        }
      , getFamilySourceDetails: {
            value: (sourceID, familyKey)=>{
                // rpc GetSourceDetails (FamilyRequest) returns (SourceDetails){}
                // returns a promise for SourceDetails
                var familyRequestMessage = _makeFamilyRequest(sourceID, familyKey);
                return this._manifestUpstreamClient.getSourceDetails(familyRequestMessage)
                    .then(null, error=>{
                        this._log.error(`Error getFamilySourceDetails(${sourceID}, ${familyKey})`, error);
                        // re-raise
                        throw error;
                    });
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
      , gitHub: {
            value: this._gitHubOperationsClient
        }
      , frontendBaseURL: {
            value: setup.frontendBaseURL
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
        // initArgs = {familyKey, requester, repoNameWithOwner /*, ... ? */}
      ;

    return this.ProcessConstructor.callbackPreInit(this._processResources, requester, payload)
    .then(([errorMessage, initArgs])=>{
        // TODO;
        // Does the familyKey exist?
        // Is the requester authorized to do this?
        // Is it OK to init the process now or are there any rules why not?
        // => [ errorMessage, initArgs]
        return [errorMessage || null, errorMessage ? null : initArgs];
    });
};

/**
// Many of these are combined with OR
// Though, not a hard requirement, in GitHub, for example, we can't have
// two author:{githubhandle} rules, the last one is used
// for here, if we can optimize queries like that, could be an option
family:{familyName}
initiator:@{githubhandle}
status:{ok, fail, open, closed}
    // "closed" expands to status:OK OR status:FAIL ?
pending:user pending:service pending:all
    //all = pending:user OR pending:service
// maybe pending:all is unnecessary because status:open implies the same
pr:done (only if it really was PRed), i.e. has a PR issue number
    -> this is a good one because its shows our KPI (Key Performance Indicator)


// GitHub "filters" examples
is:open is:issue
author:{githubhandle}
label:"Blocked - waiting for some feedback"
sort:comments-desc  // that's not a filter!
assignee:graphicore
*/
// changelog: figure if we can e.g. have an index for pending:user and then
//            get an info when that index is removed from an object in the query
//            i.e. new_val: none, oldval: something
// in general, having changelogs without actual data, just the info that
// the query result may have changed seems appropriate.

//example:
//    sort ==  "recently updated"
//    filter: is:open assignee:graphicore sort:updated-desc
//    url query string: /googlefonts/fontbakery/issues?q=is%3Aopen+assignee%3Agraphicore+sort%3Aupdated-desc
//
//    Interesting handling of whitespace in the url value of the label:
//    is:open assignee:graphicore sort:updated-desc label:"Blocked - waiting for some feedback"
//    googlefonts/fontbakery/issues?q=is%3Aopen+assignee%3Agraphicore+sort%3Aupdated-desc+label%3A%22Blocked+-+waiting+for+some+feedback%22
//    I wonder how a literal + in the label would be treated, maybe as '%2B' ?
/**
 *
 *     // var selection = data.selection; // ???
    // TODO;// what selections are needed?
    //   * processes by: familyName
    //   * processes by user/stakeholder => how do we know that?
    //          'initiator'
    //          maybe one day 'assignee'  (makes 'assigned to me' possible)
    //   * running/pending processes
    //   * finished processes
    //          * also finished OK/FAIL/PREMATURE(last would be new)
    //
    //   * processes that need user interaction/attention
    //   * processes that need ui/attention by the user authorized for it.
    // This will be a rather tough thing to do efficiently in the DB
    // TODO(this.grpcClient.subscribeList(selection));
 *
 * What are the basics that we want to query:
 *      - all processes for a family: familyName
 *      - closed/pending/failed processes
 *      - processes with pending user interactions
 *              -> would be easier if all expectedAnswers were stored top
 *                 level, easily accessible via a query, we can of course
 *                 try to produce all expected anwers and look for the third
 *                 entry 'requestedUserInteractionName'
 *      - processes with pending user interactions, that can be answered
 *        by the authenticated user (role based, where one role is e.g
 *              -> not in the expectedAnswer data yet!
 *              -> maybe too complex to do the right way for now! The DB
 *                 would have to store values like initiator:name with the
 *                 expectedAnswer and if we change e.g. by switching
 *                 to production mode (not possible yet) that would have
 *                 to be removed again.
 *                 we also have relative roles like "stakeholder" that
 *                 would be better defined elsewhere, hence these queries
 *                 become complicated. "input-provider" is a role based
 *                 on github repo rights (ADMIN or WRITE)!
 *
 *        maintainer:creepster for special cases ...)?
 *
 *      - order by last change date !!! we don't yet
 *                 ... deep query or put it top level on each change
 *                 => solved!
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
Object.defineProperty(_p, '_query', {
   get: function(){
       return [this._io.query('dispatcherprocesses'), this._io.r];
    }
});


_p._queryProcessList = function(selection) {
    // jshint unused:vars
    var [q, r] = this._query;

    q.orderBy(r.desc('created'));// make created an index: orderBy({index: r.asc('created')})

    /*
       filter takes a dict, e.g. ...
       q.filter({
            mode: 'sandbox' // 'production'
          , familyName: 'Gupter'
          , initiator: 'vv-monsalve'
       })
       but to query with an OR condition, there's a functional approach:
       .filter(process=>
           process('mode').eq('sandbox').default(false).and(process('familyName').eq('Alata')).default(false)
           // includes Gupter in sandbox and in production
           .or(process('familyName').eq('Gupter').default(false))
        )

    .filter(process=>

    //not failed on a status entry
    process('failStep')('finishedStatus')('status').ne('FAILED')

    // no finishedStatus -> not finished
    process('finishedStatus').eq(null)//('isActivated').eq(false)
    )

    reasonable "changed" date, as used for the "changed" index:
    .map(process=>process.merge({changed: process('execLog').nth(-1)(0).default(process('created'))}))

    .filter(process=>
        // unfinished
        process('finishedStatus').eq(null)
        // something is in the exec log/vs nothing is in the exec log => new and un touched
            .and(process('execLog').count().ne(0))
    )


    // waitingFor:
    // get a list of all expected answers:
    function getExpectedAnswer(item){return item('expectedAnswer')};
    function getExpectedAnswers(itemList){ return itemList.map(getExpectedAnswer);}
    function stepGetExpectedAnswers(step){
      return getExpectedAnswers(step('tasks').map(task=>task(1)))
          .union([getExpectedAnswer(step)])
          .filter(item=>item.ne(null));
    }
    function stepsGetExpectedAnswers(steps) {
      return steps.concatMap(stepGetExpectedAnswers);
    }
    function processGetExpectedAnswers(process) {
      return stepsGetExpectedAnswers(
        process('steps').union([
                  process('failsStep').default(null)
                , process('finallyStep').default(null)
        ])
        .filter(item=>item.ne(null))
      );
    }

    // then:

    q.map(process=>process.merge({expectedAnswers:
            r.do(process, processGetExpectedAnswers)}))


   // processes waiting for none-ui-answers
   // may hint for stuck processes!
   .filter(process=>process('expectedAnswers')
     .filter(ea=>ea(2).eq(null))// => is a none-ui-answer
     .count().gt(0)
   )

   // processes waiting for any ui-answers
   // shows processes waiting for user interaction!
   .filter(process=>process('expectedAnswers')
     .filter(ea=>ea(2).ne(null))// => is a ui-answer
     .count().gt(0)
   )


    TODO: implement!

    */
    //switch(selection) {
    //    case('mode'):
    //        q.filter({mode: 'sandbox'});
    //        break
    //    case('familyName')
    //        q.filter({familyName: 'Gupter'});
    //        break;
    //    case('initiator')
    //        q.filter({initiator: 'vv-monsalve'});
    //        break;
    //    case('all'):
    //        // falls through
    //    default:
    //        break;
    //}


    return q.pluck(['created', 'initiator', 'familyName']);


    // nice one: .group('familyName')

    // so, what do we get here? Actually, if any of the selected
    // items change, we get an old_val/new_val object, where
    // old_val is null if it's a new item.
    // hence, this is not very helpful to update a list of items,
    // as we can't see how the collection changes due to this
    // change report. Calculating the change to the collection
    // ourselves seems like a bad idea as well.
    // looks like polling the collection seems a better choice,
    // maybe after a change has been received and in between a
    // minimal interval.
    // .changes()
    // In the case of this pluck, the old_val key in a new
    // item is not set at all (instead of null).
    //.pluck({new_val: ['created', 'initiator', 'familyName'], old_val: ['created']})
};

/**
 * This is not implemented, because there's an implementation in
 * ProcessUIService, that uses rethinkDB change feeds directly and
 * there's no need to go via the ProcessManager to do so. Further, the
 * frontend server will do some caching etc. it's probably better to
 * use the resources there, since horizontally frontend servers scale
 * better.
 *
 * That said, I leave this here as a stub, maybe we find a use/need for
 * this interface and this would be a nice starting point.
 */
// FIXME: decomission;
_p.subscribeProcessList = function(call) {
    var processListQuery = call.request
      , unsubscribe = ()=> {
            // End the subscription and delete the call object.
            // Do this only once, but, `unsubscribe` may be called more than
            // once, e.g. on `call.destroy` via FINISH, CANCELLED and ERROR.
            this._log.info('subscribeProcessList ... UNSUBSCRIBE');

            // if a subscribed to call, this should be ending it and cleaning
            // up.

            // If a change listener is not an option, polling like all
            // 5 seconds could be an option.

            // if the query is not a subscription, we should clean up
            // and hang up directly after answering.
        }
        , selection = null// FIXME: process processListQuery
      ;
    this._log.info('processListQuery subscribing to', processListQuery.getQuery());
    this._subscribeCall('process-list', call, unsubscribe);

    this._queryProcessList(selection).then(list=>{
        var processList = new ProcessList();
        for(let {initiator, familyName, created} of list) {
            let processListItem = new ProcessListItem();
            processListItem.setProcessId(
                            `${familyName} by @${initiator} created: ${created}`);
            processList.addProcesses(processListItem);
        }
        call.write(processList);
        // hang up.
        call.end();
    });
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
