"use strict";
/* jshint esnext:true, node:true*/

const { Process:Parent } = require('./framework/Process')
    , { Step } = require('./framework/Step')
    , { Task } = require('./framework/Task')
    , { PullRequest
      , ProcessCommand
      , DispatchReport
      , StorageKey
      , FontBakeryFinished
      , GenericStorageWorkerResult
      , File
      , Files
      , FamilyData } = require('protocolbuffers/messages_pb')
    , { mixin: stateManagerMixin } = require('./framework/stateManagerMixin')
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
function stepFactory(name, tasks, anySetup) {
    const Parent = Step;
    // this injects Parent and tasks
    // also, this is like the actual constructor implementation.
    function StepConstructor (process, state, ...args) {
        Parent.call(this, process, state, tasks, anySetup, ...args);
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

// keeping this for now moment, it was useful for mocking up steps
const EmptyTask = (function() {//jshint ignore:line

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


/**
 * basically renders a flat dict of key:(string)value as markdown
 */
function _renderSourceDetails(sourceDetails, indentationDepth) {
    var indentationChar = '&emsp;'
      , indentation = new Array((indentationDepth || 0) + 1).join(indentationChar)
      , entries = []
      ;
    for(let [key, value] of Object.entries(sourceDetails))
        entries.push(indentation + '**' + key + '** `' + JSON.stringify(value)+ '`');

    return entries.join('  \n');
}


const ApproveProcessTask = (function() {

var anySetup = {
    knownTypes: { FamilyData }
};

const ApproveProcessTask = taskFactory('ApproveProcessTask', anySetup);
const _p = ApproveProcessTask.prototype;

_p._getSourceDetails = function() {
    return this.resources.getUpstreamFamilySourceDetails(this.process.familyName)
    .then(sourceDetails=>{
        var payload;
        if(sourceDetails.hasJsonPayload())
            payload = JSON.parse(sourceDetails.getJsonPayload());
        else if(sourceDetails.hasPbPayload()) {
            let anyPayload = sourceDetails.getPbPayload(); // => Any
            payload = this._any.unpack(anyPayload);
        }
        else
            // though! maybe there is no payload needed, e.g. when
            // the message is just something like: "resource ready now".
            throw new Error('No payload in sourceDetails');
        return payload;
    });
};

/**
 * Expected by Parent.
 */
_p._activate = function() {
    // could be a different path for new/update processes
    // after this task, we hopefully can proceed uniformly
    this._expectApproveProcess();
    if(this.process.initType === 'update') {
        return this._getSourceDetails()
        .then(sourceDetails =>{
            // upstream = `https://github.com/${repoNameWithOwner}.git`
            this.process._state.repoNameWithOwner = _extractRepoNameWithOwner(sourceDetails.upstream);
            this.process._state.genre = sourceDetails.genre;
            this.process._state.fontfilesPrefix = sourceDetails.fontfilesPrefix;
        });
    }
};

_p._expectApproveProcess = function() {
    this._setExpectedAnswer('Approve Process'
                                      , 'callbackApproveProcess'
                                      , 'uiApproveProcess');
};

_p._expectSignOffSpreadsheet = function() {
    this._setExpectedAnswer('Sign-off Spreadsheet-update'
                                      , 'callbackSignOffSpreadsheet'
                                      , 'uiSignOffSpreadsheet');
    return this._getSourceDetails()
            .then(sourceDetails=>{
                var sourceDetailsMD = _renderSourceDetails(sourceDetails, 1);
                this._setLOG('**sourceDetails**, this is the current data from the spreadsheet:\n\n'
                        + sourceDetailsMD
                        + '\n\n*(caution: could be outdated)*');
                this._setPrivateData('sourceDetails', {
                    found: true
                  , message: null // only if not found or some other error
                  , data: sourceDetails
                });
            })
            .then(null, error=>{
                this._setPrivateData('sourceDetails', {
                    found: false
                  , message: '' + error
                  , data: null
                });
            })
            ;
};

/**
 * - Review form info is good.
 * - Form then updates spreadsheet (if necessary).
 */
_p.uiApproveProcess = function() {
    var actionOptions = []
      , userTask
      ;
    actionOptions.push(['Accept and proceed.', 'accept']);
    actionOptions.push(['Edit info.', 'edit']);
    actionOptions.push(['Dismiss and fail.', 'dismiss']);

    this.log.debug("this.process.initType === 'register'"
                    , this.process.initType === 'register'
                    , this.process.initType
                    , this.process._state.initType
                    , this.constructor.name);

    if(this.process.initType === 'register') {
        userTask = 'Please review that the submitted info is good';
    }
    else { // assert this.process.initType === 'update'
        userTask = 'Please review that the registered info is still good';
    }
    return {
        roles: ['input-provider', 'engineer']
      , ui: [
            {
                type: 'info'
            , content: `**@${this.process.requester}** requests to **${this.process.initType}** a font family.

### ${userTask}:` + (this.process._state.note
                        ? '\n\n *with note:*\n\n' + this.process._state.note
                        : '')
            }

          , {   name: 'action'
              , type:'choice'
              , label: 'Pick one:'
              , options: actionOptions
              //, default: 'accepted' // 0 => the first item is the default
            }
          , {
                     type: 'info'
                   , condition: ['action', '!', 'edit']
                   , content: `
**Family Name** \`${this.process.familyName || '—'}\`<br />
**GitHub Repository** \`${this.process.repoNameWithOwner || '—'}\`<br />
**Where are the TTF-files in your repo (folder and file-prefix)** \`${this.process._state.fontfilesPrefix || '—'}\`<br />
**Genre** \`${this.process._state.genre || '—'}\`
`
            }
          , {   name: 'reason'
              , condition: ['action', 'dismiss']
              , type: 'line' // input type:text
              , label: 'Why can\'t this process proceed?'
            }
            // spread! :-)
            , ..._getInitNewUI().map(item=>{
                // show only when "action" has the value "register"
                if(item.name === 'genre' && this.process._state.genre)
                    item.default = this.process._state.genre;
                if(item.name === 'fontfilesPrefix')
                    item.default = this.process._state.fontfilesPrefix;
                if(item.name === 'ghNameWithOwner')
                    item.default = this.process.repoNameWithOwner;
                if(item.name === 'familyName') {
                    // can't change the name if this is a update request
                    if(this.process.initType === 'update')
                        return null;
                    item.default = this.process.familyName;
                }
                if(item.name === 'isOFL')
                    // always true at this point
                    // and we can't go on otherwise (we don't even store that state).
                    // the task can be dismissed in uiApproveProcess though.
                    //item.default = true;
                    return null;
                item.condition = ['action', 'edit'];
                return item;
            }).filter(item=>!!item)
            /**
            // depending whether this is new or updated, we may need a different
            // form here!
            // could be done with conditions, with different forms in here
            // or with

          , {   name: 'genre'
              , condition: ['action', 'register']
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

    if(action === 'accept') {
        this._setLOG('**' + requester +'** accepted this process.');
        return this._expectSignOffSpreadsheet();
    }
    else if(action === 'edit') {
        // could be two different UIs for either "update" or "register" processes.
        // validate here!
        return this._editInitialState(requester, values);
    }
    else if(action === 'dismiss') {
        this._setFAILED('**' + requester + '** decided to FAIL this process.'
            + values.reason ? '\n\n' + values.reason : '');
    }
    else
        throw new Error('Pick one of the actions from the list.');
};

// _p.uiEditInitialState = function() {
//     // assert this.initType === 'register'
//     if(this.process.initType !== 'register')
//         throw new Error('NOT IMPLEMENTED: initType "'+this.process.initType+'"');
//
//     var result = {
//         roles: ['input-provider', 'engineer']
//       , ui: _getInitNewUI().map(item=>{
//             // show only when "action" has the value "register"
//             if(item.name === 'genre' && this.process._state.genre)
//                 item.default = this.process._state.genre;
//             if(item.name === 'fontfilesPrefix')
//                 item.default = this.process._state.fontfilesPrefix;
//             if(item.name === 'ghNameWithOwner')
//                 item.default = this.process.repoNameWithOwner;
//             if(item.name === 'familyName')
//                 item.default = this.process.familyName;
//             if(item.name === 'isOFL')
//                 // always true at this point
//                 // and we can't go on otherwise (we don't even store that state).
//                 // the task can be dismissed in uiApproveProcess though.
//                 //item.default = true;
//                 return null;
//             return item;
//         }).filter(item=>!!item)
//     };
//     return result;
// };

_p._editInitialState = function(requester, values) {
    // jshint unused:vars
    values.registered = false;
    values.note = this.process._state.note;
    // isOFL stays true at this point, otherwise dismiss in uiApproveProcess
    values.isOFL = true;
    var isChangedUpdate = this.process.initType === 'update';
    if(isChangedUpdate)
        values.familyName = this.process._state.familyName;
    return callbackPreInit(this.resources, requester, values, isChangedUpdate)
    .then(([message, initArgs])=>{
        if(message) {
            // Should just stay in the expectApproveProcess realm until it's good.
            this._expectApproveProcess();
            // Where is this status used ever???
            // Seems like it is logged to the client directly,if there is
            // a client, to give direct validation feedback!
            return {
                status: 'FAIL'
              , message: message
            };
        }
        //else
        if(!isChangedUpdate)
            this.process._state.familyName = initArgs.familyName;
        this.process._state.repoNameWithOwner = initArgs.repoNameWithOwner;
        this.process._state.genre = initArgs.genre;
        this.process._state.fontfilesPrefix = initArgs.fontfilesPrefix;
        // return to the activate form
        this._expectApproveProcess();
    });
};

_p._mdCompareSourceDetails = function() {
    var lines = []
      // it would be nice to compare here the state of the sourceDetails
      // vs. the state of the request!
      // but, therefore, we need a cache instance of sourceDetails
      // from  where ever this UI was requested and that is centrally
      // done from _expectSignOffSpreadsheet ...

      , {found, message, data:sourceDetails} = this._getPrivateData('sourceDetails'
                        , {found: false, message: '(not available)', data: null})
      ;

    function _makeTable(header, rows) {
        var table = [];
        table.push(header);
        table.push(Array.from({length:header.length}).map(()=>'---'));
        for(let row of rows) {
            row = row.slice();
            row[0] = `*${row[0]}*`;
            row[0] = `*${row[0]}*`;
            row.push(row[1] === row[2] ? '✔' : '✘');
            table.push(row);
        }

        return [['', ...table.map(line=>line.join(' | ')), ''].join('\n')];
    }

    if(!found) {
        lines.push('','Can\'t show data comparison, the data was not found in the spreadsheet.  ');
        if(message)
            lines.push('With the message: ' + message);
    }
    else {
        lines.push(..._makeTable(
            ['name', 'requested data', 'spreadsheet data', 'is the same']
          , [
                ['familyName', this.process._state.familyName, sourceDetails.name]
              , ['repoNameWithOwner' ,this.process._state.repoNameWithOwner, _extractRepoNameWithOwner(sourceDetails.upstream)]
              , ['fontfilesPrefix', this.process._state.fontfilesPrefix, sourceDetails.fontfilesPrefix]
              , ['genre', this.process._state.genre, sourceDetails.genre]
              //, ['designer', n/a , sourceDetails.designer]
            ]
        ));
    }
    lines  = lines.join('\n');
    return lines;
};

_p.uiSignOffSpreadsheet = function() {
    return {
        roles: ['engineer']
      , ui: [
            {
                type: 'info'
              , content: [
                    'Please update the spreadsheet row entry for this family if necessary.  '
                  , '**Note** the spreadsheet must be updated by hand, this application'
                        + ' does not currently handle that for you!  '
                  , ' *From this point onward, only the spreadsheet data will be used!*'
                  , this._mdCompareSourceDetails()
                ].join('\n')
            }
          , {   name: 'action'
              , type:'choice'
              , label: 'How to proceed:'
              , options: [
                    ['Spreadsheet entry is up to date. Load the files!', 'accept']
                  , ['Deny the request', 'deny']
                    // this could be interesting if the requester can
                    // change the form before but not the spreadsheet.
                    // Otherwise the data can be changed in the spreadsheet
                    // directly. There will be no check to validate the
                    // spreadsheet vs. the request, rather we will turn
                    // the spreadsheet into a proper database and control
                    // it from here.
                    // If it is a rights thing, the user answering the interface
                    // before should get a reason (use continuationArgs!)
                    // *NOTE:* seems to only make sense for the "register"
                    // path!
                  , ['Go back and change the request.', 'back']
                  , ['Reload the current spreadsheet data.', 'reload']
                ]
              //, default: 'accept' // 0 => the first item is the default
          }
          , {   name: 'reason'
              , condition: ['action', 'deny']
              , type: 'line' // input type:text
              , label: 'What went wrong?'
            }
          , {   name: 'message'
              , condition: ['action', 'back']
              , type: 'line' // input type:text
              , label: 'Describe what needs to change.'
            }
        ]
    };
};

_p.callbackSignOffSpreadsheet = function([requester, sessionID]
                                        , values, ...continuationArgs) {
    // jshint unused:vars
    if(values.action === 'accept') {
        this._setLOG('**' + requester + '** confirms spreadsheet entry.\n'
                  // hmm, although the data may be outdated, we still may
                  //  want to log it, as it's the basis for the decision
                  +  this._mdCompareSourceDetails());
        TODO('callbackSignOffSpreadsheet: eventually we want to put this info into a database that we manage ourselves.');
        // that needs some more CRUD interfaces though.
        this._getFilesPackage();
    }
    else if(values.action === 'back') {
        let message = values.message || '(no message)';
        this._setLOG('Please review the requested data:\n\n' + message);
        this._expectApproveProcess();
    }
    else if(values.action === 'reload') {
        // maybe we don't need to log this at all??
        // we will change the callback ticket though!
        // reloading the page itself would have the same effect for the
        // user, if the spreadsheet status is just in the ui-method.
        // So, this is maybe a bit complicated ...
        // this._setLOG('**' + requester +'** accepted this process.');
        return this._expectSignOffSpreadsheet();
    }
    else if (values.action === 'deny') {
        // hmm, although the data may be outdated, we still may
        //  want to log it, as it's the basis for the decision
        this._setREPORT( this._mdCompareSourceDetails() );
        this._setFAILED('**' + requester + '** can\'t confirm the spreadheet '
                + 'entry is good.'
                + values.reason ? '\n\n' + values.reason : ''
                );
    }
};


/**
 * Expected by Parent.
 */
_p._getFilesPackage = function() {
    // This used to timeout when the google/fonts repo was not fetched
    // in the upstream mainifestSource, e.g. because of a restart of
    // the service. That can still happen when using the `get` gRPC interface
    // with a too small deadline. Now, this uses the processCommand path.
    // the error with the gRPC timeout was:
    //    'CSVSpreadsheet: INFO upstream: Started fetching remote "google/fonts:master"'
    //  , 'Error: 4 DEADLINE_EXCEEDED: Deadline Exceeded\n');
    //
    // NOW we can respond via amqp execute from getUpstreamFamilyFiles!
    // This has also the advantage, that the user interface will report
    // what it is currently waiting for. A long unresponsive phase,
    // because a Tasks `activate` takes long time is not optimal.
    var [callbackName, ticket] = this._setExpectedAnswer(
                                    'Creating files package.'
                                  , 'callbackReceiveFiles'
                                  , null)
      , processCommand = new ProcessCommand()
      ;
    processCommand.setTargetPath(this.path.toString());
    processCommand.setTicket(ticket);
    processCommand.setCallbackName(callbackName);
    processCommand.setResponseQueueName(this.resources.executeQueueName);
    return this.resources.getUpstreamFamilyFiles(this.process.familyName
                                                        , processCommand);
};

_p.callbackReceiveFiles = function([requester, sessionID]
                                , familyDataMessage /* a FamilyData */
                                , ...continuationArgs) {
    // jshint unused:vars
    if(familyDataMessage.getStatus() === FamilyData.Result.FAIL) {
        // hmm, this must not fail directly, it could also suggest to
        // change the spreadsheet and try again!
        // FIXME: if this fails inform the user abpout steps to do and
        // provide options.
        this._setREPORT('**ERROR** ' + familyDataMessage.getError());
        this._setFAILED('**' + requester + '** can\'t create files package.');
        return;
    }

    return Promise.all([
              this.resources.persistence.put([familyDataMessage.getFiles()])
                                        .then(storageKeys=>storageKeys[0])
            , familyDataMessage
    ])
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
                    else if(key === 'sourceDetails' && typeof value === 'object')
                        return '**' + key + '** \n\n' + _renderSourceDetails(value, 1);
                    else if( typeof value !== 'object')
                        return '**' + key + '** `' + JSON.stringify(value)+ '`';
                    else
                        return '**' + key + '** ```'
                                + JSON.stringify(value, null, 2)
                                + '```';
                }).join('  \n')
        );
        this._setREPORT(familyDataSummaryMarkdown.join('\n'));
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
              , content: 'Please check the logged family package.\n\n'
                        + 'Reloading the files package may be interesting '
                        + 'if you changed the spreadsheet entry or the '
                        + 'repository data in the meantime.'
            }
          , {   name: 'action'
                , type:'choice'
                , label: 'How to proceed:'
                , options: [
                      ['Looks good, go to QA!', 'accept']
                    , ['Dismiss the files package and fail the task.', 'deny']
                    // back? hmm, maybe it's nice to have this option,
                    // although, the spreadsheet can be changed without
                    // doing it in here.
                    // , ['Go back and change the request.', 'back']
                    , ['Reload the files package.', 'retry'] // e.g. because the spreadsheet entry was changed
                  ]
                //, default: 'accept' // 0 => the first item is the default
            }
          , {   name: 'reason'
              , condition: ['action', 'deny']
              , type: 'line' // input type:text
              , label: 'What went wrong?'
            }
        ]
    };
};

_p.callbackCheckFamilyFilesPackage = function([requester, sessionID]
                                        , values, ...continuationArgs) {
    // jshint unused:vars
    if(values.action === 'accept') {
        // no values.reason here
        this._setOK('**' + requester + '** confirms the family package.');
    }
    else if(values.action === 'retry'){
        this._setLOG('**' + requester + '** retries to generate the files package.');
        // delete the storage
        var storageKey = this.process.getFilesStorageKey();
        this._setLOG('Cleaning up: deleting persistence files for key: '
                    + this.process._state.filesStorageKey);
        return this.resources.persistence.purge(storageKey)// => 'filesMessage'
            .then(()=>{this.process._state.filesStorageKey = null;})
            .then(()=>this._getFilesPackage());
    }
    else { // assert values.action === 'deny'
        this._setFAILED('**' + requester + '** can\'t confirm the '
                + 'family package.'
                + values.reason ? '\n\n' + values.reason : '');
    }
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


function persistenceKey2cacheKey(resources, persistenceKey) {
    return resources.persistence.get(persistenceKey)
        .then(filesMessage=>resources.cache.put([filesMessage]))
        .then(cacheKeys=>cacheKeys[0])
        ;
}

function _mdFormatTimestamp(message, timestampKey, label) {
    var getter = 'get' + timestampKey.slice(0, 1).toUpperCase() + timestampKey.slice(1)
      , ts = message[getter]()
      , label_ = label === undefined ? timestampKey : label
      ;
    return `*${label_}* ${ts && ts.toDate() || '—'}`;
}

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

_p._activate = function() {
    var persistenceKey = this.process.getFilesStorageKey();
    return persistenceKey2cacheKey(this.resources, persistenceKey)
    .then(cacheKey=>_taskInitWorker.call(this
                                       , 'fontbakery'
                                       , cacheKey
                                       , 'callbackFontBakeryFinished'))
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
    report += [ _mdFormatTimestamp(fontBakeryFinishedMessage, 'created')
              , _mdFormatTimestamp(fontBakeryFinishedMessage, 'started')
              , _mdFormatTimestamp(fontBakeryFinishedMessage, 'finished')
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
              , content: 'Please review the Font Bakery result:'
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


function _makeFileMessage(filename, arrBuff) {
    var file = new File();
    file.setName(filename);
    file.setData(arrBuff);
    return file;
}

function _copyFilesMessage(fromFiles, toFiles, prefix, log) {
    var files = fromFiles.getFilesList();
    for(let file of files) {
        let name = (prefix || '') + file.getName()
          , newFile = _makeFileMessage(name, file.getData())
          ;
        if(log)
            log.debug('COPYING: ', file.getName(), 'to', name);
        toFiles.addFiles(newFile);
    }
}

function _taskPreparePreviewFiles() { // => filesMessage
    //jshint validthis:true
    // FIXME: make the copy to 'files/{filename}' uneccessary
    // the storageKey of the files of this process should be just
    // fine for the worker, eventually. Right know, however, the
    // worker expects the files in a sub-directory, hence this effort.
    var storageKey = this.process.getFilesStorageKey();
    this.log.debug(this.constructor.name, '_taskPreparePreviewFiles getting files:', storageKey.getKey());
    return this.resources.persistence.get(storageKey)// => 'filesMessage'
    // copy to 'files/{filename}'
    .then(jobFilesMessage=>{
        this.log.debug(this.constructor.name, '_taskPreparePreviewFiles got files.');
        var filesMessage = new Files();
        this.log.debug(this.constructor.name, '_taskPreparePreviewFiles start copy files ...');
        _copyFilesMessage(jobFilesMessage, filesMessage, 'files/', this.log);
        this.log.debug(this.constructor.name, '_taskPreparePreviewFiles DONE! copy files ...');
        return filesMessage;
    });
}

function _taskPrepareDiffFiles() { // => filesMessage
    //jshint validthis:true
    return this.resources.getGoogleFontsAPIFamilyFiles(this.process.familyName)
    .then(familyDataMessage=>familyDataMessage.getFiles())// => 'filesMessage'
        // copy to 'before/{filename}'
    .then(beforeFilesMessage=>{
        this.log.debug(this.constructor.name, '_taskPrepareDiffFiles got "before" files.');
        var filesMessage = new Files();
        this.log.debug(this.constructor.name, '_taskPrepareDiffFiles start copy before files ...');
        _copyFilesMessage(beforeFilesMessage, filesMessage, 'before/', this.log);
        this.log.debug(this.constructor.name, '_taskPrepareDiffFiles DONE! copy before files ...');
        return filesMessage;
    })
    .then(filesMessage=>{

    var storageKey = this.process.getFilesStorageKey();
    this.log.debug(this.constructor.name, '_taskPrepareDiffFiles getting "after" files:', storageKey.getKey());
    return this.resources.persistence.get(storageKey)// => 'filesMessage'
        // copy to 'after/{filename}'
        .then(afterFilesMessage=>{
            this.log.debug(this.constructor.name, '_taskPrepareDiffFiles got "after" files.');
            this.log.debug(this.constructor.name, '_taskPrepareDiffFiles start copy after files ...');
            _copyFilesMessage(afterFilesMessage, filesMessage, 'after/', this.log);
            this.log.debug(this.constructor.name, '_taskPrepareDiffFiles DONE! copy after files ...');
            return filesMessage;
        });
    });
}

function _taskInitWorker(workerName
                       , initMessage /*e.g. a CacheKey message*/
                       , callbackName) {
    //jshint validthis: true

    this.log.debug(this.constructor.name
                , '_taskInitWorker sending to worker:', workerName
                , 'with callback:', callbackName || '(no callback!)');
    var callbackName_, ticket
      , processCommand = null
      ;
    if(callbackName) {
        // The initWorker API allows dispatching workers without callback,
        // however, it seems unlikely that we need it that way.
        processCommand = new ProcessCommand();
        [callbackName_, ticket] = this._setExpectedAnswer(
                                                           workerName
                                                         , callbackName
                                                         , null);
        processCommand.setTargetPath(this.path.toString());
        processCommand.setTicket(ticket);
        processCommand.setCallbackName(callbackName_);
        processCommand.setResponseQueueName(this.resources.executeQueueName);
    }
    return this.resources.initWorker(workerName, initMessage, processCommand);
}

function _taskActivateDiffWorker(workerName, callbackName) {
    // jshint validthis:true
    // may fail if not found in google api

    if(!this.process._state.isUpdate) {
        this._setOK('Skipping ' + workerName + ': there\'s no existing data to diff.');
        return;
    }

    return _taskPrepareDiffFiles.call(this) // => filesMessage
    .then(filesMessage=>this.resources.cache.put([filesMessage])
                           .then(cacheKeys=>cacheKeys[0]))
    .then(cacheKey=>_taskInitWorker.call(this
                                      , workerName
                                      , cacheKey
                                      , callbackName))
    //.then((message)=>{
    //    this._setLOG(workerName + ' worker initialized …');
    //})
    ;
}


const DiffenatorTask = (function() {
var anySetup = {
    knownTypes: { GenericStorageWorkerResult }
};
const DiffenatorTask = taskFactory('DiffenatorTask', anySetup);
const _p = DiffenatorTask.prototype;

_p._activate = function() {
    return _taskActivateDiffWorker.call(this, 'diffenator', 'callbackDiffenatorFinished');
};

_p.callbackDiffenatorFinished = function([requester, sessionID]
                                        , genericStorageWorkerResult
                                        , ...continuationArgs) {
    // jshint unused:vars

    // message GenericStorageWorkerResult {
    //     message Result {
    //         string name = 1;
    //         StorageKey storage_key = 2;
    //     };
    //     string job_id = 1;
    //     // currently unused but generally interesting to track the
    //     // time from queuing to job start, or overall waiting time
    //     // finished - start is the time the worker took
    //     // started - finished is the time the job was in the queue
    //     google.protobuf.Timestamp created = 2;
    //     google.protobuf.Timestamp started = 3;
    //     google.protobuf.Timestamp finished = 4;
    //     // If set the job failed somehow, print pre-formated
    //     string exception = 5;
    //     repeated string preparation_logs = 6;
    //     repeated Result results = 7;
    // }
    var exception = genericStorageWorkerResult.getException()
     , report = '## Diffenator Result'
     ;

    if(exception) {
        report += [
            '\n'
            , '### EXCEPTION'
            , '```'
            , exception
            , '```\n'
        ].join('\n');
    }

    var preparationLogs = genericStorageWorkerResult.getPreparationLogsList();
    if(preparationLogs.length) {
        report += '\n### Preparation Logs\n';
        for(let preparationLog of preparationLogs)
            report += ` * \`${preparationLog}\`\n`;
    }

    // For now, just log the zip download url:
    // message GenericStorageWorkerResult.Result {
    //     string name = 1;
    //     StorageKey storage_key = 2;
    // }
    var results = genericStorageWorkerResult.getResultsList();
    if(results.length) {
        report += '\n### Results\n';
        for(let result of results) {
            let name = result.getName()
              , storageKey = result.getStorageKey()
              ;
            // FIXME: a hard coded url is bad :-/
            report += ` * browse report: [**${name}**]`
                    + `(/browse/persistence/${storageKey.getKey()}/report.html)`
                    + ` or download: [zip file]`
                    + `(/download/persistence/${storageKey.getKey()}.zip)\n`;
        }
    }
    report += '\n';
    report += [
             // created is not used currently
             // _mdFormatTimestamp(genericStorageWorkerResult, 'created')
                _mdFormatTimestamp(genericStorageWorkerResult, 'started')
              , _mdFormatTimestamp(genericStorageWorkerResult, 'finished')
              ].join('<br />\n');

    this._setLOG(report);

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
              , content: 'Please review the Diffenator result:'
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


// FIXME: this is basically copypasta from DiffenatorTask!
const DiffbrowsersTask = (function() {
var anySetup = {
    knownTypes: { GenericStorageWorkerResult }
};
const DiffbrowsersTask = taskFactory('DiffbrowsersTask', anySetup);
const _p = DiffbrowsersTask.prototype;

_p._activate = function() {
    return _taskActivateDiffWorker.call(this, 'diffbrowsers', 'callbackDiffbrowsersFinished');
};

_p.callbackDiffbrowsersFinished = function([requester, sessionID]
                                        , genericStorageWorkerResult
                                        , ...continuationArgs) {
    // jshint unused:vars

    // message GenericStorageWorkerResult {
    //     message Result {
    //         string name = 1;
    //         StorageKey storage_key = 2;
    //     };
    //     string job_id = 1;
    //     // currently unused but generally interesting to track the
    //     // time from queuing to job start, or overall waiting time
    //     // finished - start is the time the worker took
    //     // started - finished is the time the job was in the queue
    //     google.protobuf.Timestamp created = 2;
    //     google.protobuf.Timestamp started = 3;
    //     google.protobuf.Timestamp finished = 4;
    //     // If set the job failed somehow, print pre-formated
    //     string exception = 5;
    //     repeated string preparation_logs = 6;
    //     repeated Result results = 7;
    // }
    var exception = genericStorageWorkerResult.getException()
     , report = '## Diffbrowsers Result'
     ;

    if(exception) {
        report += [
            '\n'
            , '### EXCEPTION'
            , '```'
            , exception
            , '```\n'
        ].join('\n');
    }

    var preparationLogs = genericStorageWorkerResult.getPreparationLogsList();
    if(preparationLogs.length) {
        report += '\n### Preparation Logs\n';
        for(let preparationLog of preparationLogs)
            report += ` * \`${preparationLog}\`\n`;
    }

    // For now, just log the zip download url:
    // message GenericStorageWorkerResult.Result {
    //     string name = 1;
    //     StorageKey storage_key = 2;
    // }
    var results = genericStorageWorkerResult.getResultsList();
    if(results.length) {
        report += '\n### Results\n';
        for(let result of results) {
            let name = result.getName()
              , storageKey = result.getStorageKey()
              ;
            // FIXME: a hard coded url is bad :-/
            report += ` * browse report: [**${name}**]`
                      // uses index.html or autoindex
                    + `(/browse/persistence/${storageKey.getKey()}/)`
                    + ` or download: [zip file]`
                    + `(/download/persistence/${storageKey.getKey()}.zip)\n`;

        }
    }
    report += '\n';
    report += [
             // created is not used currently
             // _mdFormatTimestamp(genericStorageWorkerResult, 'created')
                _mdFormatTimestamp(genericStorageWorkerResult, 'started')
              , _mdFormatTimestamp(genericStorageWorkerResult, 'finished')
              ].join('<br />\n');

    this._setLOG(report);

    this._setExpectedAnswer('Confirm Diffbrowsers'
                                 , 'callbackConfirmDiffbrowsers'
                                 , 'uiConfirmDiffbrowsers');
};

_p.uiConfirmDiffbrowsers = function() {
    return {
        roles: ['engineer']
      , ui: [
            {
                type: 'info'
              , content: 'Please review the Diffbrowsers result:'
            }
          , {   name: 'accept'
              , type:'binary'
              , label: 'Diffbrowsers looks good!'
            }
          , {   name: 'notes'
              , type: 'text' // input type:text
              , label: 'Notes'
            }
        ]
    };
};

_p.callbackConfirmDiffbrowsers = function([requester, sessionID]
                                        , values, ...continuationArgs) {
    // jshint unused:vars
    if(values.notes)
        this._setLOG('## Notes\n\n' + 'by **'+requester+'**\n\n' + values.notes);
    if(values.accept === true) {
        this._setOK('**' + requester + '** Diffbrowsers looks good.');
    }
    else
        this._setFAILED('**' + requester + '** Diffbrowsers is failing.');
};

return DiffbrowsersTask;
})();

// FIXME: this is basically copypasta from, or at least *very similar* to
// DiffenatorTask and DiffbrowsersTask!
const PreviewsTask = (function() {
var anySetup = {
    knownTypes: { GenericStorageWorkerResult }
};
const PreviewsTask = taskFactory('PreviewsTask', anySetup);
const _p = PreviewsTask.prototype;

_p._activate = function() {
    var workerName = 'previews'
      , callbackName = 'callbackPreviewsFinished'
      ;

    if(this.process._state.isUpdate) {
        this._setOK('Skipping ' + workerName + ': using diff workers instead.');
        return;
    }

    return _taskPreparePreviewFiles.call(this) // => filesMessage
    .then(filesMessage=>this.resources.cache.put([filesMessage])
                           .then(cacheKeys=>cacheKeys[0]))
    .then(cacheKey=>_taskInitWorker.call(this
                                      , workerName
                                      , cacheKey
                                      , callbackName))
    //.then((message)=>{
    //    this._setLOG(workerName + ' worker initialized …');
    //})
    ;
};

_p.callbackPreviewsFinished = function([requester, sessionID]
                                        , genericStorageWorkerResult
                                        , ...continuationArgs) {
    // jshint unused:vars

    // message GenericStorageWorkerResult {
    //     message Result {
    //         string name = 1;
    //         StorageKey storage_key = 2;
    //     };
    //     string job_id = 1;
    //     // currently unused but generally interesting to track the
    //     // time from queuing to job start, or overall waiting time
    //     // finished - start is the time the worker took
    //     // started - finished is the time the job was in the queue
    //     google.protobuf.Timestamp created = 2;
    //     google.protobuf.Timestamp started = 3;
    //     google.protobuf.Timestamp finished = 4;
    //     // If set the job failed somehow, print pre-formated
    //     string exception = 5;
    //     repeated string preparation_logs = 6;
    //     repeated Result results = 7;
    // }
    var exception = genericStorageWorkerResult.getException()
     , report = '## Previews Result'
     ;

    if(exception) {
        report += [
            '\n'
            , '### EXCEPTION'
            , '```'
            , exception
            , '```\n'
        ].join('\n');
    }

    var preparationLogs = genericStorageWorkerResult.getPreparationLogsList();
    if(preparationLogs.length) {
        report += '\n### Preparation Logs\n';
        for(let preparationLog of preparationLogs)
            report += ` * \`${preparationLog}\`\n`;
    }

    // For now, just log the zip download url:
    // message GenericStorageWorkerResult.Result {
    //     string name = 1;
    //     StorageKey storage_key = 2;
    // }
    var results = genericStorageWorkerResult.getResultsList();
    if(results.length) {
        report += '\n### Results\n';
        for(let result of results) {
            let name = result.getName()
              , storageKey = result.getStorageKey()
              ;
            // FIXME: a hard coded url is bad :-/
            report += ` * browse report: [**${name}**]`
                    // uses index.html or autoindex
                    + `(/browse/persistence/${storageKey.getKey()}/)`
                    + ` or download: [zip file]`
                    + `(/download/persistence/${storageKey.getKey()}.zip)\n`;
        }
    }
    report += '\n';
    report += [
             // created is not used currently
             // _mdFormatTimestamp(genericStorageWorkerResult, 'created')
                _mdFormatTimestamp(genericStorageWorkerResult, 'started')
              , _mdFormatTimestamp(genericStorageWorkerResult, 'finished')
              ].join('<br />\n');

    this._setLOG(report);

    this._setExpectedAnswer('Confirm Previews'
                                 , 'callbackConfirmPreviews'
                                 , 'uiConfirmPreviews');
};

_p.uiConfirmPreviews = function() {
    return {
        roles: ['engineer']
      , ui: [
            {
                type: 'info'
              , content: 'Please review the Previews result:'
            }
          , {   name: 'accept'
              , type:'binary'
              , label: 'Previews looks good!'
            }
          , {   name: 'notes'
              , type: 'text' // input type:text
              , label: 'Notes'
            }
        ]
    };
};

_p.callbackConfirmPreviews = function([requester, sessionID]
                                        , values, ...continuationArgs) {
    // jshint unused:vars
    if(values.notes)
        this._setLOG('## Notes\n\n' + 'by **'+requester+'**\n\n' + values.notes);
    if(values.accept === true) {
        this._setOK('**' + requester + '** Previews looks good.');
    }
    else
        this._setFAILED('**' + requester + '** Previews is failing.');
};

return PreviewsTask;
})();

const QAToolsStep = stepFactory('QAToolsStep', {
    Fontbakery: FontbakeryTask
  , Diffenator: DiffenatorTask
  , Diffbrowsers: DiffbrowsersTask
  , Previews: PreviewsTask
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
              [ApproveProcessStep, {label: 'Review the Request'}]
              // * Generate package (using the spreadsheet info. TODO: DESCRIPTION file?, complete METADATA.pb)
            , [GetFilesPackageStep, {label: 'Generate the Files Package'}]
            , [QAToolsStep, {label: 'Quality Assurance'}]
            , [SignOffAndDispatchStep, {label: 'Create the Pull Request'}]
          //, DispatchStep
    ]
  , FailStepCtor = [FailStep, {label: 'Report the Issue'}]
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

// see: https://github.com/googlefonts/fontbakery/issues/637#issuecomment-175243241
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
              , placeholder: 'GitHub URL or {owner}/{repo-name}'
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
            // condition:update is ~ update an existing family, hence just a select input
            {   // don't want to create something overly complicated here,
                // otherwise we'd need a dependency tree i.e. to figure if
                // a condition element is visible or not. But, what we
                // can do is always make a condition false when it's dependency
                // is not available or defined.
                name: 'family'
              , condition: ['registered', true] // show only when "registered" has the value `true`
              , type:'choice' // => could be a select or a radio
              , label: 'Pick the family to request an update:'
              , options: familyList
              //, default: 'Family Name' // 0 => the first item is the default
            }
          , {   name: 'registered'
              , type:'binary'
              , label: 'The family is not listed in the drop down.'
              , invert: true // This inverts the interface, so we can change
                             // the question, asking for the opposite, but
                             // keep the variable name and default value.
              , default: true
            }
        ]
    };
    TODO('add multi-field to change Authors info');// info, this is a
            // common request especially for updates, when new authors are
            // added, but also for new entries, when initial authors are added.
            // This info is not yet in the CSV though!
    var newUi = _getInitNewUI().map(item=>{
        // show only when "registered" has the value "register"
        item.condition = ['registered', false];
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


function _extractRepoNameWithOwner(repoNameWithOwner) {
    // git@github.com:googlefonts/gftools.git
    // https://github.com/googlefonts/gftools.git
    var prefixes = ['https://github.com/', 'git@github.com:'];
    for(let test of prefixes) {
        let i = repoNameWithOwner.indexOf(test);
        if(i === -1)
            continue;
        // got a hit, extract then break ...
        repoNameWithOwner = repoNameWithOwner.slice(i + test.length)
                // cleaning up
                .split('/').slice(0, 2).filter(str=>!!str).join('/');
        if(repoNameWithOwner.slice(-4) === '.git')
            repoNameWithOwner = repoNameWithOwner.slice(0,-4);
        break;
    }
    return repoNameWithOwner;
}

function callbackPreInit(resources, requester, values, isChangedUpdate=false) {

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
        repoNameWithOwner = _extractRepoNameWithOwner(values.ghNameWithOwner.trim());

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

    if(values.registered === false) {
        initType = 'register';
        // either, we could change the init type transparently OR we could
        // just deny to go on, because update is the right choice here ...
        FIXME('if this is requesting to register, but the font is already registered, we need to communicate this ...');
        checkNew();
        promise = Promise.resolve();
    }
    else if(values.registered === true) {
        initType = 'update';
        if(isChangedUpdate)
            checkNew();
        promise = checkUpdate();
    }
    else {
        messages.push('"registered" value is unexpected: ' + values.registered);
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

_p.getFilesStorageKey = function() {
    var filesStorageKey = this._state.filesStorageKey
      , storageKeyMessage
      ;
    if(filesStorageKey === null)
        throw new Error('State has not defined a "filesStorageKey" yet.');
    storageKeyMessage = new StorageKey();
    storageKeyMessage.setKey(filesStorageKey);
    return storageKeyMessage;
};

exports.FamilyPRDispatcherProcess = FamilyPRDispatcherProcess;
