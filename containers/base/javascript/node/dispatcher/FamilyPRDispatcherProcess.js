"use strict";
/* jshint esnext:true, node:true*/

const { Process:Parent } = require('./framework/Process')
    , { Step } = require('./framework/Step')
    , { Task } = require('./framework/Task')
    , { FamilyRequest
      , PullRequest
      , ProcessCommand
      , DispatchReport
      , StorageKey
      , FontBakeryFinished } = require('protocolbuffers/messages_pb')
    , {mixin: stateManagerMixin} = require('./framework/stateManagerMixin')
    ;

/**
 * constructor must do Parent.call(this, arg1, arg2,) itself if applicable.
 */
function makeClass(name, parentPrototype, constructor) {
    // jshint evil: true
    // this way we return a proper constructor where
    // CTOR.name === name
    var CTOR = new Function('ctor', 'return '
      + 'function ' + name + '(...args) {'
      +     'ctor.apply(this, args);'
      + '};'
    )(constructor);
    if(parentPrototype)
        CTOR.prototype = Object.create(parentPrototype);
    CTOR.prototype.constructor = CTOR;
    return CTOR;
}

/**
 * Helper to remove simple Step boilerplate like this:
 *     const MyStep = (function() {
 *     const Parent = Step;
 *     function MyStep(process, state) {
 *         Parent.call(this, process, state, {
 *              JobA: JobATask
 *            , JobB: JobBTask
 *            // , JobC: ...
 *         });
 *     }
 *     const _p = MyStep.prototype = Object.create(Parent.prototype);
 *     _p.constructor = MyStep;
 *     return MyStep;
 *     })();
 *
 * Instead we can do just:
 *
 * const MyStep = stepFactory('MyStep', {
 *              JobA: JobATask
 *            , JobB: JobBTask
 *            // , JobC: ...
 * });
 *
 */
function stepFactory(name, tasks) {
    const Parent = Step;
    // this injects Parent and tasks
    // also, this is like the actual constructor implementation.
    function StepConstructor (process, state) {
        Parent.call(this, process, state, tasks);
    }
    return makeClass(name, Parent.prototype, StepConstructor);
}

function taskFactory(name, anySetup) {
    const Parent = Task;
    // this injects Parent
    // also, this is like the actual constructor implementation.
    function TaskConstructor (step, state) {
        Parent.call(this, step, state, anySetup);
    }
    return makeClass(name, Parent.prototype, TaskConstructor);
}


// This is an empty function to temporarily disable jshint
// "defined but never used" warnings and to mark unfinished
// business
const TODO = (...args)=>console.log('TODO:', ...args)
   , FIXME = (...args)=>console.log('FIXME:', ...args)
   ;

function renderMD(){
    return '**NOT IMPLEMENTED:** renderMD';
}

const EmptyTask = (function() {

// just a placeholder to get infrastructure running before actually
// implementing this module.
const Parent = Task;
function EmptyTask(step, state) {
    Parent.call(this, step, state);
}

const _p = EmptyTask.prototype = Object.create(Parent.prototype);
_p.constructor = EmptyTask;

_p._activate = function() {
    this._setOK('EmptyTask is OK on activate.');
};

return EmptyTask;
})();



const GetFamilyDataTask = (function(){

const Parent = Task;
function GetFamilyDataTask(step, state) {
    Parent.call(this, step, state);
}

const _p = GetFamilyDataTask.prototype = Object.create(Parent.prototype);
_p.constructor = GetFamilyDataTask;

/**
 * _activate runs when the step is activated the first time
 * and it possibly re-runs when explicitly requested; e.g. a Task
 * can be re-tried via the UI, in some cases, when dependent from
 * external sources this may change the result of the task.
 */
_p._activate = function() {
    this._setLOG('Requesting familyData for ', this.process.familyName
                                                , 'from source upstream.');
    var familyRequest = new FamilyRequest();
    familyRequest.setSourceId('CSVSpreadsheet');
    familyRequest.setFamilyName(this.process.familyName);
    FIXME('This can timeout if the google/fonts repo is not fetched yet!'
          ,'CSVSpreadsheet: INFO upstream: Started fetching remote "google/fonts:master"'
          , 'Error: 4 DEADLINE_EXCEEDED: Deadline Exceeded\n');
    return this.grpcSourceClient.get(familyRequest)
        .then(familyDataMessage => {
            // this is nice, we'll have all the info of the files
            // of the progress available in the document
            let familyDataSummaryMarkdown = renderMD(familyDataMessage);
            this._setLOG(familyDataSummaryMarkdown);
            return this._setSharedData('familyData', familyDataMessage)
                .then(()=>this._setOK('Family data is persisted.'));
        });
        // error case will be handled and FAIL will be set
};

return GetFamilyDataTask;
})();

const InitProcessStep = (function() {
const Parent = Step;
function InitProcessStep(process, state) {
    Parent.call(this, process, state, {
        GetFamilyData: GetFamilyDataTask // => where to put the files etc?
    });
}

const _p = InitProcessStep.prototype = Object.create(Parent.prototype);
_p.constructor = InitProcessStep;
return InitProcessStep;
})();


const DiffbrowsersTask = EmptyTask;

const RegressionsStep = (function(){
const Parent = Step;
function RegressionsStep(process, state) {
    Parent.call(this, process, state, {
        // needs font files package
        // produces images
        // the UI will need the images
        Diffbrowsers: DiffbrowsersTask // queue diffbrowsers tool (can this run on our workers?)
                        // OR maybe a simple diffbrowsers service that's not massively parallel
                        // when we need more we can still scale this
                        // will call back when done
                        // wait for user interaction to judge result
        });
}
const _p = RegressionsStep.prototype = Object.create(Parent.prototype);
_p.constructor = RegressionsStep;
})();


const DispatchPRTask = EmptyTask;

const DispatchStep = (function(){
const Parent = Step;
/**
 * Make a the PR or manually fail with a reasoning.
 */
function DispatchStep(process, state) {
    Parent.call(this, process, state, {
        DispatchPR: DispatchPRTask // we want this to be done by authorized engineers only
                    // will create a nice PR with good message
    });
}
const _p = DispatchStep.prototype = Object.create(Parent.prototype);
_p.constructor = DispatchStep;
return DispatchStep;
})();


const ApproveProcessTask = (function() {

const ApproveProcessTask = taskFactory('ApproveProcessTask');
const _p = ApproveProcessTask.prototype;

/**
 * Expected by Parent.
 */
_p._activate = function() {
    // could be a different path for new/update processes
    // after this task, we hopefully can proceed uniformly
    this._expectApproveProcess();
};

_p._expectApproveProcess = function() {
    this._setExpectedAnswer('Approve Process'
                                      , 'callbackApproveProcess'
                                      , 'uiApproveProcess');
};

_p._expectEditInitialState = function() {
    this._setExpectedAnswer('Edit Initial State'
                                      , 'callbackEditInitialState'
                                      , 'uiEditInitialState');
};

/**
 * - Review form info is good.
 * - Form then updates spreadsheet (if necessary).
 */
_p.uiApproveProcess = function() {
    var actionOptions = [];
    actionOptions.push(['Accept and proceed.', 'accept']);
    this.log.debug("this.initType === 'new'", this.process.initType === 'new', this.process.initType, this.process._state.initType, this.constructor.name);
    if(this.process.initType === 'new')
        // currently there's nothing to edit when initType is an update
        actionOptions.push(['Edit data.', 'edit']);
    // else assert this.initType === 'update'
    actionOptions.push(['Dismiss and fail.', 'dismiss']);

    return {
        roles: ['engineer']
      , ui: [
            {
                type: 'info'
              , content: 'Please review that the submitted info is good.'
            }
          , {   name: 'action'
              , type:'choice'
              , label: 'Pick one:'
              , options: actionOptions
              //, default: 'accepted' // 0 => the first item is the default
            }
          , {   name: 'reason'
              , condition: ['action', 'dismiss']
              , type: 'line' // input type:text
              , label: 'Why do you dismiss this process request?'
            }
            /**
            // depending whether this is new or updated, we may need a different
            // form here!
            // could be done with conditions, with different forms in here
            // or with

          , {   name: 'genre'
              , condition: ['action', 'new']
              , type:'choice' // => could be a select or a radio
              , label: 'Genre:'
              , options: fontFamilyGenres
            }
            */
        ]
    };
};

_p.callbackApproveProcess = function([requester, sessionID]
                                        , values, ...continuationArgs) {
    // jshint unused:vars
    var {action} = values;

    if(action === 'accept' ) {
        this._setLOG('**' + requester +'** accepted this process.');
        this._setExpectedAnswer('Sign-off Spreadsheet-update'
                                      , 'callbackSignOffSpreadsheet'
                                      , 'uiSignOffSpreadsheet');
    }
    else if(this.process.initType === 'new' && action === 'edit' ) {
        // could be two different UIs for either "update" or "new" processes.
        this._expectEditInitialState();
    }
    else if(action === 'dismiss' )
        this._setFAILED('**' + requester + '** decided to FAIL this process '
                     + 'request with reason:\n' + values.reason);
    else
        throw new Error('Pick one of the actions from the list.');
};

_p.uiEditInitialState = function() {
    // assert this.initType === 'new'
    if(this.process.initType !== 'new')
        throw new Error('NOT IMPLEMENTED: initType "'+this.process.initType+'"');

    var result = {
        roles: ['input-provider', 'engineer']
      , ui: _getInitNewUI().map(item=>{
            // show only when "action" has the value "new"
            if(item.name === 'genre' && this.process._state.genre)
                item.default = this.process._state.genre;
            if(item.name === 'fontfilesPrefix')
                item.default = this.process._state.fontfilesPrefix;
            if(item.name === 'ghNameWithOwner')
                item.default = this.process.repoNameWithOwner;
            if(item.name === 'familyName')
                item.default = this.process.familyName;
            if(item.name === 'familyName')
                item.default = this.process.familyName;
            if(item.name === 'isOFL')
                // always true at this point
                // and we can't go on otherwise (we don't even store that state).
                // the task can be dismissed in uiApproveProcess though.
                //item.default = true;
                return null;
            return item;
        }).filter(item=>!!item)
    };
    return result;
};

_p.callbackEditInitialState = function([requester, sessionID]
                                        , values, ...continuationArgs) {
    // jshint unused:vars
    values.action = 'new';
    values.note = this.process._state.note;
    // isOFL stays true at this point, otherwise dismiss in uiApproveProcess
    values.isOFL = true;
    return callbackPreInit(this.resources, requester, values)
    .then(([message, initArgs])=>{
        if(message) {
            // Should just stay in the editInitialState realm until it's good.
            this._expectEditInitialState();
            return {
                status: 'FAIL'
              , message: message
            };
        }
        //else
        this.process._state.familyName = initArgs.familyName;
        this.process._state.repoNameWithOwner = initArgs.repoNameWithOwner;
        this.process._state.genre = initArgs.genre;
        this.process._state.fontfilesPrefix = initArgs.fontfilesPrefix;
        // return to the activate form
        this._expectApproveProcess();
    });
};

_p.uiSignOffSpreadsheet = function() {
    return {
        roles: ['engineer']
      , ui: [
            {
                type: 'info'
              , content: 'Please update the spreadsheet row entry for this family if necessary.'
            }
          , {   name: 'accept'
              , type:'binary'
              , label: 'Spreadsheet entry is up to date.'
            }
          , {   name: 'reason'
              , condition: ['accept', false]
              , type: 'line' // input type:text
              , label: 'What went wrong?'
            }
        ]
    };
};

_p.callbackSignOffSpreadsheet = function([requester, sessionID]
                                        , values, ...continuationArgs) {
    // jshint unused:vars
    if(values.accept === true) {
        this._setOK('**' + requester + '** confirms spreadsheet entry.');
        TODO('callbackSignOffSpreadsheet: eventually we want to put this info into a database that we manage ourselves.');
        // that needs some more CRUD interfaces though.
    }
    else if (values.accept === false)
        this._setFAILED('**' + requester + '** can\'t confirm the spreadheet '
                + 'entry is good:\n' + values.reason);
};


return ApproveProcessTask;
})();

const ApproveProcessStep = stepFactory('ApproveProcessStep', {
    //(engineer): Review form info is good.
    //        -> should have a way to modify the state from init
    //(engineer): updates spreadsheet -> just a sign off
    //        -> may be done by the form eventually
    ApproveProcess: ApproveProcessTask
});



// * Generate package (using the spreadsheet info. TODO: DESCRIPTION file?, complete METADATA.pb)
const GetFilesPackageTask = (function() {
const GetFilesPackageTask = taskFactory('GetFilesPackageTask');
const _p = GetFilesPackageTask.prototype;

/**
 * Expected by Parent.
 */
_p._activate = function() {
    FIXME('This can timeout if the google/fonts repo is not fetched yet!'
          ,'CSVSpreadsheet: INFO upstream: Started fetching remote "google/fonts:master"'
          , 'Error: 4 DEADLINE_EXCEEDED: Deadline Exceeded\n');
          // NOW we can respond via amqp execute from getUpstreamFamilyFiles!
    return this.resources.getUpstreamFamilyFiles(this.process.familyName)
    .then(familyDataMessage=>Promise.all([
              this.resources.persistence.put([familyDataMessage.getFiles()])
                                        .then(storageKeys=>storageKeys[0])
            , familyDataMessage
    ]))
    .then(([storageKey, familyDataMessage])=> {
        /*
        message FamilyData {
            string collectionid = 1; // the name that identifies the collection
            string family_name = 2; // the name that identifies the family
            Files files = 3;
            google.protobuf.Timestamp date = 4; // when the data was created
            string metadata = 5;//json?
        }
        // really depends on the source, but the CSVSpreadsheet produces:
        metadata = {
            commit: commit.sha()
          , commitDate: commit.date()
          , sourceDetails: familyData.toDictionary()
          , familyTree: tree.id()
          , familyPath: tree.path()
          , repository: familyData.upstream
          , branch: familyData.referenceName // Error: NotImplemented if not git
          , googleMasterDir: googleMasterDir
          , isUpdate: isUpdate
          , licenseDir: licenseDir
        };
        // and ManifestServer:
        familyData.setMetadata(JSON.stringify(metadata));
        */

        var filteredMetadataKeys = new Set(['familyTree'])
          , familyDataSummaryMarkdown = ['## Files Package for *'
                                      + this.process.familyName+'*']
          , metadata = JSON.parse(familyDataMessage.getMetadata())
          , filesStorageKey = storageKey.getKey()
            // uiServer provides a get endpoint for this
            // using apiServices/storageDownload
            // FIXME: a hard coded url is bad :-/
            // The link *should* be created by uiServer, because it has
            // to serve it BUT that is impractical
            //    -> and I don't want to make a uiServer service for this
            //    -> thus, either complicated configuration or a hardcoded
            //       link. Since no solution is realy good, hardcoded will
            //       have to do for now, it's quick and dirty,
            //       the quickest way in fact ...
          , zipDownloadLink = '/download/persistence/'+filesStorageKey+'.zip'
          , familyDirName = this.process.familyName.toLowerCase().replace(/ /g, '')
          ;


        // this are the most important lines here.
        this.process._state.filesStorageKey = filesStorageKey;
        this.process._state.targetDirectory = metadata.isUpdate
                            ? metadata.googleMasterDir
                            : metadata.licenseDir + '/' + familyDirName
                            ;
        this.process._state.isUpdate = metadata.isUpdate;

        familyDataSummaryMarkdown.push(
            '### Files'
          , familyDataMessage.getFiles().getFilesList()
                .map(file=>' * `' + [file.getName() + '`'
                                     , '*' + file.getData().byteLength
                                     , 'Bytes*'
                                   ].join(' ')
                    ).join('\n')
          , '\n'
          , '[zip file download]('+zipDownloadLink+')'
          , '\n'
          , '### Metadata'
          , Object.entries(metadata)
                .filter(([key, ])=>!filteredMetadataKeys.has(key))
                .map(([key, value])=>{
                    if(typeof value === 'string')
                        return '**' + key + '** ' + value;
                    else if( typeof value !== 'object')
                        return '**' + key + '** `' + JSON.stringify(value)+ '`';
                    else
                        return '**' + key + '** ```'
                                + JSON.stringify(value, null, 2)
                                + '```';
                }).join('  \n')
        );
        this._setLOG(familyDataSummaryMarkdown.join('\n'));
        this._setExpectedAnswer('Check Family Files Package'
                                  , 'callbackCheckFamilyFilesPackage'
                                  , 'uiCheckFamilyFilesPackage');
    });
};

_p.uiCheckFamilyFilesPackage = function() {
    return {
        roles: ['engineer']
      , ui: [
            {
                type: 'info'
              , content: 'Please check the logged family package.'
            }
          , {   name: 'accept'
              , type:'binary'
              , label: 'Looks good, go to QA!'
            }
          , {   name: 'reason'
              , condition: ['accept', false]
              , type: 'line' // input type:text
              , label: 'What went wrong?'
            }
        ]
    };
};

_p.callbackCheckFamilyFilesPackage = function([requester, sessionID]
                                        , values, ...continuationArgs) {
    // jshint unused:vars
    if(values.accept === true) {
        this._setOK('**' + requester + '** confirms the family package.');
    }
    else
        this._setFAILED('**' + requester + '** can\'t confirm the '
                + 'family package:\n' + values.reason);
};

return GetFilesPackageTask;
})();

const GetFilesPackageStep = stepFactory('GetFilesPackageStep', {
    GetFilesPackage: GetFilesPackageTask
});


/**
 *
 * Run QA tools on package
 * MF: Determine if family has passed/inspect visual diffs (depending on
 * whether the family is new or an upgrade, this inspection is a bit different.)
 */
const FontbakeryTask = (function() {
var anySetup = {
    knownTypes: { FontBakeryFinished }
};
const FontbakeryTask = taskFactory('FontbakeryTask', anySetup);
const _p = FontbakeryTask.prototype;

_p._persistenceKey2cacheKey = function (persistenceKey) {
    // TODO
    var storageKey = new StorageKey();
    storageKey.setKey(persistenceKey);
    return this.resources.persistence.get(storageKey)
        .then(filesMessage=>this.resources.cache.put([filesMessage]))
        .then(cacheKeys=>cacheKeys[0])
        ;
};

_p._activate = function() {
    var persistenceKey = this.process._state.filesStorageKey;
    return this._persistenceKey2cacheKey(persistenceKey)
    .then(cacheKey=>{
        var [callbackName, ticket] = this._setExpectedAnswer(
                                        'Font Bakery'
                                      , 'callbackFontBakeryFinished'
                                      , null)
          , processCommand = new ProcessCommand()
          ;
        processCommand.setTargetPath(this.path.toString());
        processCommand.setTicket(ticket);
        processCommand.setCallbackName(callbackName);
        processCommand.setResponseQueueName(this.resources.executeQueueName);
        return this.resources.initWorker('fontbakery', cacheKey, processCommand);
    })
    .then(familyJob=>{
        var docid = familyJob.getDocid();
        this._setLOG('Font Bakery Document: [' + docid + '](/report/' + docid + ').');
    });
};

_p.callbackFontBakeryFinished = function([requester, sessionID]
                                        , fontBakeryFinishedMessage
                                        , ...continuationArgs) {
    // jshint unused:vars
    // print results to users ...
    var report
        //, docid = fontBakeryFinishedMessage.getDocid()
        // If the job has any exception, it means
        // the job failed to finish orderly
      , finishedOrderly = fontBakeryFinishedMessage.getFinishedOrderly()
      , created = fontBakeryFinishedMessage.getCreated()
      , started = fontBakeryFinishedMessage.getStarted()
      , finished = fontBakeryFinishedMessage.getFinished()
      , resultsJson = fontBakeryFinishedMessage.getResultsJson()
      ;
    report = '## Font Bakery Result';

    if(!finishedOrderly) {
        report += [ ''
                  , '### **CAUTION: Font Bakery failed to complete!**'
                  , 'See the report for details.'
                  ].join('\n');
    }

    if(resultsJson) {
        let results = JSON.parse(resultsJson)
         , percent = {}
         , total = Object.values(results).reduce((r, val)=>r+val, 0)
         ;
        Object.entries(results).forEach(([k,v])=>
                        percent[k] = Math.round(((v/total)*10000))/100);

        report += [
          ''
        , '| 💔 ERROR | 🔥 FAIL | ⚠ WARN | 💤 SKIP | 🛈 INFO | 🍞 PASS |'
        , '|:-----:|:----:|:----:|:----:|:----:|:----:|'
        , `| ${results.ERROR||0} | ${results.FAIL||0} | ${results.WARN||0} | ${results.SKIP||0} | ${results.INFO||0} | ${results.PASS||0} |`
        , `| ${percent.ERROR||0} % | ${percent.FAIL||0} % | ${percent.WARN||0} % | ${percent.SKIP||0} % | ${percent.INFO||0} % | ${percent.PASS||0} % |`
        ].join('\n');
    }

    report += '\n\n';
    report += [ `*created* ${created.toDate() || '—'}`
              , `*started* ${started.toDate() || '—'}`
              , `*finished* ${finished.toDate() || '—'}`
              ].join('<br />\n');

    this._setLOG(report);
    this._setExpectedAnswer('Confirm Fontbakery'
                                 , 'callbackConfirmFontbakery'
                                 , 'uiConfirmFontbakery');
};

_p.uiConfirmFontbakery = function() {
    return {
        roles: ['engineer']
      , ui: [
            {
                type: 'info'
              , content: 'Please run Font Bakery and report the result:'
            }
          , {   name: 'accept'
              , type:'binary'
              , label: 'Fontbakery looks good!'
            }
          , {   name: 'notes'
              , type: 'text' // input type:text
              , label: 'Notes'
            }
        ]
    };
};

_p.callbackConfirmFontbakery = function([requester, sessionID]
                                        , values, ...continuationArgs) {
    // jshint unused:vars
    if(values.notes)
        this._setLOG('## Notes\n\n' + 'by **'+requester+'**\n\n' + values.notes);
    if(values.accept === true) {
        this._setOK('**' + requester + '** Font Bakery looks good.');
    }
    else
        this._setFAILED('**' + requester + '** Font Bakery is failing.');
};

return FontbakeryTask;
})();

const DiffenatorTaskDummy = (function(){
const DiffenatorTask = taskFactory('DiffenatorTask');
const _p = DiffenatorTask.prototype;

_p._activate = function() {
    this._setExpectedAnswer('Confirm Diffenator'
                                  , 'callbackConfirmDiffenator'
                                  , 'uiConfirmDiffenator');
};

_p.uiConfirmDiffenator = function() {
    return {
        roles: ['engineer']
      , ui: [
            {
                type: 'info'
              , content: 'Please run Diffenator and report the result:'
            }
          , {   name: 'accept'
              , type:'binary'
              , label: 'Diffenator looks good!'
            }
          , {   name: 'notes'
              , type: 'text' // input type:text
              , label: 'Notes'
            }
        ]
    };
};

_p.callbackConfirmDiffenator = function([requester, sessionID]
                                        , values, ...continuationArgs) {
    // jshint unused:vars
    if(values.notes)
        this._setLOG('## Notes\n\n' + 'by **'+requester+'**\n\n' + values.notes);
    if(values.accept === true) {
        this._setOK('**' + requester + '** Diffenator looks good.');
    }
    else
        this._setFAILED('**' + requester + '** Diffenator is failing.');
};

return DiffenatorTask;
})();

const GFregressionsTaskDummy = (function(){
const GFregressionsTask = taskFactory('GFregressionsTask');
const _p = GFregressionsTask.prototype;

_p._activate = function() {
    this._setExpectedAnswer('Confirm GFregressions'
                                  , 'callbackConfirmGFregressions'
                                  , 'uiConfirmGFregressions');
};

_p.uiConfirmGFregressions = function() {
    return {
        roles: ['engineer']
      , ui: [
            {
                type: 'info'
              , content: 'Please run GFregressions and report the result:'
            }
          , {   name: 'accept'
              , type:'binary'
              , label: 'GFregressions looks good!'
            }
          , {   name: 'notes'
              , type: 'text' // input type:text
              , label: 'Notes'
            }
        ]
    };
};

_p.callbackConfirmGFregressions = function([requester, sessionID]
                                        , values, ...continuationArgs) {
    // jshint unused:vars
    if(values.notes)
        this._setLOG('## Notes\n\n' + 'by **'+requester+'**\n\n' + values.notes);
    if(values.accept === true) {
        this._setOK('**' + requester + '** GFregressions looks good.');
    }
    else
        this._setFAILED('**' + requester + '** GFregressions is failing.');
};

return GFregressionsTask;
})();



const QAToolsStep = stepFactory('QAToolsStep', {
    Fontbakery: FontbakeryTask
  , Diffenator:DiffenatorTaskDummy
  , GFregressions: GFregressionsTaskDummy
});


const SignOffAndDispatchTask = (function() {

var anySetup = {
    knownTypes: { DispatchReport }
};
const SignOffAndDispatchTask = taskFactory('SignOffAndDispatchTask', anySetup);
const _p = SignOffAndDispatchTask.prototype;


_p._activate = function() {
    this._setExpectedAnswer('Confirm Dispatch'
                                  , 'callbackConfirmDispatch'
                                  , 'uiConfirmDispatch');
};

_p.uiConfirmDispatch = function() {
    return {
        roles: ['engineer']
      , ui: [
            {   name: 'action'
              , type:'choice'
              , label: 'Pick one:'
              , options: [
                    ['Create Pull Request now.', 'accept']
                  , ['Dismiss and fail.', 'dismiss']

              ]
              //, default: 'accepted' // 0 => the first item is the default
            }
          , {   name: 'reason'
              , condition: ['action', 'dismiss']
              , type: 'line' // input type:text
              , label: 'Why do you dismiss this process request?'
            }
        ]
    };
};

// make the PR:
//   * fetch current upstream master
//   * checkout --branch {branchName}
//   * get {package} for {cacheKey}
//   * replace {gfontsDirectory} with the contents of {package}
//   * git commit -m {commitMessage}
//   * git push {remote ???}
//   * gitHub PR remote/branchname -> upstream {commitMessage}
_p.callbackConfirmDispatch = function([requester, sessionID]
                                        , values , ...continuationArgs) {
    // jshint unused:vars
    // This must be a user interaction callback because that
    // way we get a current sessionID, needed by GitHubPRServer
    // to get the GitHub-oAuthToken of the user.
    var {action} = values
      , pullRequest, processCommand
      , callbackName, ticket
      ;
    if(action === 'dismiss' ) {
        this._setFAILED('**' + requester + '** decided to FAIL this process '
                     + 'request with reason:\n' + values.reason);
        return;
    }
    else if(action !== 'accept' )
        throw new Error('Pick one of the actions from the list.');

    this._setLOG('**' + requester +'** dispatches this process.');

    pullRequest = new PullRequest();
    pullRequest.setSessionId(sessionID);
    pullRequest.setStorageKey(this.process._state.filesStorageKey);
    pullRequest.setTargetDirectory(this.process._state.targetDirectory);

    // something standard
    pullRequest.setPRMessageTitle('[Font Bakery Dashboard] '
                        + (this.process._state.isUpdate ? 'update' : 'create')
                        + ' family: ' + this.process.familyName);
    // full of information stored in state!
    // must contain the link to the process page!
    // some QA details, as much as possible probably, but the full
    // reports will be at the process page as well.
    var prMessageBody = 'TODO! *PR message body*';
    pullRequest.setPRMessageBody(prMessageBody);

    pullRequest.setCommitMessage('[Font Bakery Dashboard] '
                        + (this.process._state.isUpdate ? 'update' : 'create')
                        + ': ' + this.process._state.targetDirectory);

    [callbackName, ticket] = this._setExpectedAnswer(
                                    'Pull Request Result'
                                  , 'callbackDispatched'
                                  , null);
    processCommand = new ProcessCommand();
    processCommand.setTargetPath(this.path.toString());
    processCommand.setTicket(ticket);
    processCommand.setCallbackName(callbackName);
    processCommand.setResponseQueueName(this.resources.executeQueueName);
    pullRequest.setProcessCommand(processCommand);

    this.resources.dispatchPR(pullRequest)// -> Promise.resolve(new Empty())
        .then(null, error=>{
            this.log.error('Can\'t dispatch Pull Request', error);
            // There's no return from this, maybe the user can retry the task.
            this._setFAILED('Can\'t dispatch Pull Request: ' + error);
        });
};

_p.callbackDispatched = function([requester, sessionID]
                                , dispatchReport /* a DispatchReport */
                                , ...continuationArgs) {
    // jshint unused:vars
    var status = dispatchReport.getStatus()
      , statusOK = status === DispatchReport.Result.OK
      , branchUrl = dispatchReport.getBranchUrl()
      , prUrl = statusOK  ? dispatchReport.getPRUrl() : null
      , error = !statusOK ? dispatchReport.getError() : null
      ;

    if(statusOK) {
        this._setOK(' * [GitHub PR](' + prUrl + ')\n'
                  + ' * [GitHub branch page](' + branchUrl + ')');

    }
    else
        // assert dispatchReport.getStatus() === DispatchReport.Result.FAIL
        this._setFAILED('**' + requester + '** can\'t dispatch Pull Request.'
                    + '\n\n **ERROR** ' + error
                    + '\n\n[designated GitHub branch page]('+branchUrl+')'
                    );
};

return SignOffAndDispatchTask;
})();


const SignOffAndDispatchStep = stepFactory('SignOffAndDispatchStep', {
    SignOffAndDispatch: SignOffAndDispatchTask
});


//MF: if bad inform author of necessary changes.

/**
 * This is a special step. It runs immediately after the first failed
 * step and closes the process
 *
 * Create an issue somewhere on GitHub.
 */

const FailTask = (function() {
const FailTask = taskFactory('FailTask');
const _p = FailTask.prototype;

_p._activate = function() {
    this._setExpectedAnswer('Fail Task'
                                  , 'callbackFailTask'
                                  , 'uiFailTask');
};

_p.uiFailTask = function() {
    return {
        roles: ['engineer']
      , ui: [
            {
                type: 'info'
              , content: 'Please explain the issue to the author.'
            }
          , {   name: 'notes'
              , type: 'text' // input type:text
              , label: 'Notes'
            }
        ]
    };
};

_p.callbackFailTask = function([requester, sessionID]
                                        , values, ...continuationArgs) {
    // jshint unused:vars
    if(values.notes)
        this._setLOG('## Notes\n\n' + 'by **'+requester+'**\n\n' + values.notes);

    this._setLOG('...gathering information');
    this._setLOG('...making the Issue');
    this._setOK('issue at [upstream/font-name #123Dummy](https://github.com/google/fonts/issues)');

};

return FailTask;
})();


const FailStep = stepFactory('FailStep', {
    Fail: FailTask
});



const stepCtors = [
              // * Review form info is good.
              // * Form then updates spreadsheet (if necessary).
              ApproveProcessStep
              // * Generate package (using the spreadsheet info. TODO: DESCRIPTION file?, complete METADATA.pb)
            , GetFilesPackageStep
            , QAToolsStep
            , SignOffAndDispatchStep
          //, DispatchStep
    ]
  , FailStepCtor = FailStep
  , FinallyStepCtor = null
  ;

Object.freeze(stepCtors);

function FamilyPRDispatcherProcess(resources, state, initArgs) {
    Parent.call(this
              , resources
              , state
              , stepCtors
              , FailStepCtor
              , FinallyStepCtor
    );
    if(state)
        return;
    // else if(initArgs) … !
    this.log.debug('new FamilyPRDispatcherProcess initArgs:', initArgs, 'state:', state);

    var {  initType, familyName, requester, repoNameWithOwner, genre
         , fontfilesPrefix, note
        } = initArgs;

    this._state.initType = initType;
    this._state.familyName = familyName;
    this._state.requester = requester;
    this._state.repoNameWithOwner = repoNameWithOwner || null;
    this._state.genre = genre;
    this._state.fontfilesPrefix = fontfilesPrefix;
    this._state.note = note;
}

const _p = FamilyPRDispatcherProcess.prototype = Object.create(Parent.prototype);
_p.constructor = FamilyPRDispatcherProcess;




/*
So.

I'm kind of afraid of everyone being able to init processes which immediately
get persisted to database (and take up space etc.).

Instead it would be nice to have a initialization phase which is only ephemeral.
It's also an option to just erase processes if they don't reach a
certain age/maturity! Maybe at some point an engineer must accept the request
or dismiss it? (dismiss-delete and dismiss-persist are options...).
The `dismiss-delete` case is for vandalism, wrong understanding of how it
works and jsut mistakes. ???

At the moment, I'm not thinking that vandalism will be a problem, the other
two cases are likely though.

delete could be an option for engineers always. or maybe for a new `maintenance`
role.

-> how could we stop someone from filling up the database with trash?
-> we have a github handle
-> the user must have write/admin privileges on the repo he's suggesting for updating
-> the font family must not have an open process already

the github repo is a strech, but i believe, it's not that easy to have
"unlimited" or at least many thousands of github repos.

-> a not-"engineer" user may have a quota of how many non-approved/non-accepted
  processes he can initiate (=requester), especially if they are NEW families.
  for existing families, if we don't accept multiple open processes for a family
  at a time, there's not so much trash when a user requests updates to all families
  he's access to, that are also in our system. Plus, we probably know the person
  or have some kind of relationship, so there's some trust involved.
-> so we need to set a state.accepted flag...only an engineer can do so...
   in order to lower the number of *NEW and UNACCEPTED* families one user can
   submit.

initial data:

existing (regstered) family: family name
    -> the rest comes from the CSV
    -> this does *not* mean the font is already on googlefonts, but it means
       the family name is basically enough to start a dispatcher process.
new family:
    -> family name
    -> repo
    -> all the data that needs to go to the CSV basically!!!!

...?
It would be so good to have an initial blocker-validation, that even
prevents processes from being created in the first place!
What can be done???

OK, but right now, we rather need just something to *show* the concept,
fake some stuff etc.






init:
    (new)
    User clicks “add new family radio button””
        - User submits family info via expanded form or still via email (github auth + repo write required)
        [BEFORE WE REALLY INITIALIZE THIS PROCESS --and persisit-- WE CHECK
                - the user quota for new and unaccepted processes!
                - this can eventually be done even before the user is presented
                  with a form, but must be repeated before dispatching the
                  init...
                - the init UI *must* be accessible BEFORE process initialization
                - the init callback SHOULD also be availabke BEFORE! then we can
                  actually make it evaluate and validate the initial data and
                  decide upon it's result whether to start the process!
        ]
            - Must be github repo
            - Sources must exist
            - License is OFL
            - basically, we want all the info required for the spreadsheet.
    (upgrade)
    User clicks on “update family radio button”
        -User provides “upstream url” (or just selects family name?)
         (This should just be the list of all family names available via the spreadsheet)
            - User adds optional authors
    Thank user

without the access control etc. from above, that's the init
*/


/**
 * These two functions are special, because they are executed *before*
 * the process is initialized and persisted (getting a processID and
 * occupying space in the database. So these are gate keepers.
 *
 * I think some gate keeping will be done even outside of here, like the
 * user quota check for not accepted requests for adding new fonts.
 * (Which is important to reduce the risk/feasibility of attacks/vandalism
 * targeted at filling up our database.) What if an internet mob tries to
 * punish us for not on-boarding a font they want to have online. Think of
 * a 4chan.or/r kind of attack.
 */

const fontFamilyGenres = [
        'Display'
      , 'Serif'
      , 'Sans Serif'
      , 'Handwriting'
      , 'Monospace'
    ];

function _getInitNewUI() {
    // condition:new is ~ a new suggested family
            // User submits family info via expanded form
            //              (github auth + repo write required)
            // Must be github repo
            // Sources must exist -> hard to check before trying to read the sources
            // License is OFL
            // things that got to the Spreadsheet:
            //     family: full name with spaces and initial capitals,
            //             e.g: "Fira Sans Condensed"
            //     upstream: "https://github.com/googlefonts/FiraGFVersion.git"
            //             Must be github repo. the repo must be public
            //             github auth + repo write required
            //             {owner}/{repo-name} is sufficient: googlefonts/FiraGFVersion
            //             but for the spreadsheet we *may* put in the
            //             full url version
            //     genre:  one of 'Display', 'Handwriting', 'Monospace', 'Sans Serif', 'Serif'
            //     fontfiles prefix: "fonts/FiraSansCondensed-"
    return [
           {    name: 'familyName'
              , type: 'line' // input type:text
              , label: 'Family Name:'
              , placeholder: 'Generic Sans Condensed'
            }
          , {   name: 'ghNameWithOwner'
              , type: 'line' // input type:text
              , label: 'GitHub Repository'
              , placeholder: '{owner}/{repo-name}'
            }
          , {   name: 'fontfilesPrefix'
              , type: 'line' // input type:text
              , label: 'Where are the TTF-files in your repo (folder and file-prefix):'
              , placeholder: 'fonts/GenericSansCondensed-'
            }
          , {   name: 'genre'
              , type:'choice' // => could be a select or a radio
              , label: 'Genre:'
                // TODO: get a list of available families from the CSV Source
              , options: fontFamilyGenres
            }
            // let the user look this up before we accept the form
            // this should remove some noise.
          , {   name: 'isOFL'
              , type: 'binary' // input type checkbox
              , label: 'Is the font family licensed under the OFL: SIL Open Font License?'
              , default: false // false is the default
            }
    ];
}

// function _getInitUpdateUI(){}

function uiPreInit(resources) {
    return resources.getUpstreamFamilyList().then(familyList=>{

    // it's probably neeed, that we take a state argument and return
    // different uis for this, so we can create a kind of a dialogue
    // with the client...
    // on the other hand, that's totally possible once we created the
    // process ... in here we should just collect enough data to
    // authorize initializing the process.
    var result = {
        // TODO: at this point we want at least 'input-provider' but we
        // don't have a repoNameWithOwner to check against ;-)
        roles: null
      , ui: [
            {   name: 'action'
              , type:'choice' // => could be a select or a radio
              , label: 'What do you want to do?'
              , options: [
                    ['Update an existing Google Fonts font family.', 'update']
                  , ['Add a new family to Google Fonts.', 'new']]
              , default: 'update' // 0 => the first item is the default
            }
            // condition:update is ~ update an existing family, hence just a select input
          , {   // don't want to create something overly complicated here,
                // otherwise we'd need a dependency tree i.e. to figure if
                // a condition element is visible or not. But, what we
                // can do is always make a condition false when it's dependency
                // is not available or defined.
                name: 'family'
              , condition: ['action', 'update'] // show only when "action" has the value "update"
              , type:'choice' // => could be a select or a radio
              , label: 'Pick one:'
              , options: familyList
              //, default: 'Family Name' // 0 => the first item is the default
            }
        ]
    };
    TODO('add multi-field to change Authors info');// info, this is a
            // common request especially for updates, when new authors are
            // added, but also for new entries, when initial authors are added.
            // This info is not yet in the CSV though!
    var newUi = _getInitNewUI().map(item=>{
        // show only when "action" has the value "new"
        item.condition = ['action', 'new'];
        return item;
    });
    result.ui.push(...newUi);

    result.ui.push({
                name: 'note'
              , type: 'text' // textarea
              , label: 'Additional Notes:'
            });
    return result;
    });
}

function callbackPreInit(resources, requester, values) {

    var initType, familyName, repoNameWithOwner
      , genre, fontfilesPrefix, note
      , message, messages = []
      , initArgs = null
      , promise
      ;

    genre = fontfilesPrefix = '';
    note = values.note || '';

    var checkNew=()=>{
        // just some sanitation, remove multiple subsequent spaces
        familyName = values.familyName.trim().split(' ').filter(chunk=>!!chunk).join(' ');
        var regexFamilyName = /^[a-z0-9 ]+$/i;
        // this check is also rather weak, but, eventually we'll use font bakery!
        if(!regexFamilyName.test(familyName))
            messages.push('The family name must consist only of characters '
                        + 'from A to Z and a to z, numbers from 0 to 9 and '
                        + 'spaces between the words. The first character '
                        + 'of each word should be a capital.');
        // No further format checks here. GitHub will complain if this is
        // invalid. Though, if it's an empty string after the trim, I
        // expect this to be handled before the init.
        FIXME('We should check properly if this is a existing, public(!) repo.');
        repoNameWithOwner = values.ghNameWithOwner.trim();

        // values.fontfilesPrefix => just use this, it's impossible to
        // evaluate without actually trying to get the files
        fontfilesPrefix = values.fontfilesPrefix;

        if(fontFamilyGenres.indexOf(values.genre) === -1)
            messages.push('Genre must be one of '
                                    + fontFamilyGenres.join(', ') + '.');
        else
            genre = values.genre;
        // Make the user think about this.
        if(!values.isOFL)
            messages.push('Sorry! We accept only font families licensed '
                        + 'under the OFL.');
    };

    var checkUpdate =()=>{
        TODO('callbackPreInit: checkUpdate seems incomplete');
        return resources.getUpstreamFamilyList().then(familyList=>{
            if(familyList.indexOf(values.family) === -1)
                messages.push('You must pick a family from the list to update.');
            familyName = values.family;

            // that info is in the CSV already, we need it to put it into
            // the CSV eventually.
            // Also, to check roles! but we don't really need it as a
            // state of the process.
            // changing it can happen directly in the CSV, as long as we
            // don't manage that as a database in the dashboard...
            // so, only to check roles... think about it.
            FIXME('Need to get repoNameWithOwner');//, but here?
        });
    };

    if(values.action === 'new') {
        initType = 'new';
        checkNew();
        promise = Promise.resolve();
    }
    else if(values.action === 'update') {
        initType = 'update';
        promise = checkUpdate();
    }
    else {
        messages.push('"action" value is unexpected: ' + values.action);
        promise = Promise.resolve();
    }

    return promise.then(()=>{
        if(!repoNameWithOwner) {
            FIXME('check user roles/authoriztion Got no repoNameWithOwner');
        //    messages.push('Got no repoNameWithOwner.');
        }
        if(messages.length)
            // markdown list ...?
            message = ' * '+ messages.join('\n * ');
        else
            //
            initArgs = {initType, familyName, requester, repoNameWithOwner
                      , genre
                      , fontfilesPrefix
                      , note
            };
        return [message, initArgs];
    });
}
// Doing it this way so we get a jshint warning when
// using `this` in these functions.
FamilyPRDispatcherProcess.uiPreInit = uiPreInit;
FamilyPRDispatcherProcess.callbackPreInit = callbackPreInit;

const _genericStateItem = {
    init: ()=>null
  , load: val=>val
  , serialize: val=>val
};
Object.freeze(_genericStateItem);

stateManagerMixin(_p, {
    /**
     * The name of the font family for the process document in the database.
     *
     * We'll likely add other metadata here, think e.g. process initiator.
     * BUT, how do we teach ProcessManager to handle (set/evaluate etc) these?
     * It would be proper cool the have them as arguments to activate!
     *
     * Although, the familyName in this case also is important to check if
     * the process is allowed to get created at all OR if there's another
     * active process, blocking new creation (maybe not implemented
     * immediately, as we'll have authorization for this).
     *
     * We'll want to check n case of process initiator if they are
     * authorized to perform that action. (a useful first step could be
     * to ask an engineer (task ui) to authorize if the initiator is not
     * properly authorized.
     *
     * familyName will be a secondary index in the database and e.g.
     * the processManager.subscribeProcessList method will need to know
     * how to query for it.
     * This is an interesting problem! Separating the specific Process
     * implementation from the ProcessManager, still allowing ProcessManager
     * to use specific queries for the Process...
     * Could implement a specific ProcessManager, it's probably the most
     * straight forward.
     */
    familyName: _genericStateItem
    /**
     * For authorization purposes, maybe just the requester ID/handle,
     * (a string) so that we can get the roles of the requester
     * from the DB.
     */
  , requester: _genericStateItem
    /**
     * We need this to determine the roles of a authenticated (GitHub)
     * user. Users having WRITE or ADMIN permissions for the repo have
     * the role "input-provider".
     */
  , repoNameWithOwner: _genericStateItem
  , initType: _genericStateItem
  , genre: _genericStateItem
  , fontfilesPrefix: _genericStateItem
  , note: _genericStateItem
  , filesStorageKey: _genericStateItem
  , targetDirectory: _genericStateItem
  // if the familydir (targetDirectory) was found in google/fonts:master
  , isUpdate: _genericStateItem
});

Object.defineProperties(_p, {
    familyName: {
        get: function() {
            return this._state.familyName;
        }
    }
   , requester: {
        get: function() {
            return this._state.requester;
        }
    }
  , repoNameWithOwner: {
       get: function() {
            return this._state.repoNameWithOwner;
        }
    }
  , initType: {
       get: function() {
            return this._state.initType;
        }
    }
});

exports.FamilyPRDispatcherProcess = FamilyPRDispatcherProcess;
