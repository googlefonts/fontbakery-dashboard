"use strict";
/* jshint esnext:true, node:true*/

const { Process:Parent } = require('./framework/Process')
    , { Step } = require('./framework/Step')
    , { Task, finishingStatuses } = require('./framework/Task')
    , { string2statusCode, FAIL, OK } = require('./framework/Status')
    , { FamilyRequest } = require('protocolbuffers/messages_pb')
    , {mixin: stateManagerMixin} = require('./framework/stateManagerMixin')
    ;

// This is an empty function to temporarily disable jshint
// "defined but never used" warnings and to mark unfinished
// business
function TODO(){}

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
    var familyRequest = new FamilyRequest();
    familyRequest.setSourceId('CSVSpreadsheet');
    familyRequest.setFamilyName(this.process.familyName);
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


const FontbakeryTask = (function(){
const Parent = Task;
function FontbakeryTask(step, state) {
    Parent.call(this, step, state);
}

const _p = FontbakeryTask.prototype = Object.create(Parent.prototype);
_p.constructor = FontbakeryTask;


_p._createFamilyJob = function(familyDataMessage) { // -> FamilyJobMessage
   TODO(familyDataMessage);
   this.log.error('Not Implemented _createFamilyJob');
    // include to call "callbackFontBakeryFinished" with a fontbakeryResultMessage
};

_p._dispatchFamilyJob = function(ticket, familyJob) {
    TODO(ticket, familyJob);

};

_p._runFamilyJob = function(familyJob) {
    var callbackTicket = this._setExpectedAnswer('Font Bakery', 'callbackFontBakeryFinished');
    return this._dispatchFamilyJob(callbackTicket, familyJob)
    .then(reportId=>{
        this._setPrivateData('reportId', reportId);
        // This improves the information of the PENDING status by showing
        // the Font Bakery report details.
        // FIXME: This is wrong in many ways (but easy). There must be a
        // better way to define this link maybe we should set special data
        // to this log entry, that contains the reportId and the uiServer
        // or client can properly include the report then.
        let linkToFontbakeryReport = '/report/' + reportId;
        this._setPENDING('Waiting for Font Bakery [report '
                        + reportId + '](' + linkToFontbakeryReport + ')' );
        return reportId;
    });
};

_p.callbackFontBakeryFinished = function(requester, fontbakeryResultMessage) {
    // hmm, can get the result also from the DB?
    // the reportID must be the same as the one we received in _runFamilyJob
    // otherwise, this task may have been re-activated and we're looking at
    // the wrong report and subsequently are setting the wrong state for
    // that wrong report.
    var expectedReportID = this._getPrivateData('reportId', null)
      , resultReportID = fontbakeryResultMessage.getReportId()
      ;
    if(resultReportID !== expectedReportID) {
        this._logStatus('The callback for a finished Font Bakery report '
            + 'was called for a wrong report id ("'+resultReportID+'")'
            + 'the expected reportID is: "'+expectedReportID+'".'
        );
        // don't do anything.
        return;
    }
    this._setPrivateData('fontbakeryResultMessage', fontbakeryResultMessage);
    this._logStatus(renderMD(fontbakeryResultMessage));

    TODO();  // The task is now waiting for user interaction
           // this needs to be communicated to the applicable users
           // as such:
           //       * we MAY send out emails (later)
           //       * we SHOULD provide an overview to the users for all
           //         processes that are awaiting direct human interaction.
           //         If the current watching user is authorized to perform
           //         the action, we should also mark these processes
           //         specially and also put them into a personal list:
           //               processes awaiting your attention

    this._setExpectedAnswer('Finalize UI', 'callbackFinalize', 'uiFinalize');
};

_p.callbackFinalize = function(requester, finalizeMessage) {
    if(!this._hasPrivateData('fontbakeryResultMessage')) {
        // The UI should not allow this callback to be made, but in
        // race condition cases like updates or such we may receive it.
        // There' will also be a way to exceptionally close a whole
        // step, e.g. if Font Bakery is not responding or something
        // else goes totally wrong.
        this._logStatus('To finalize the task orderly it is required '
            + 'that there\'s a finished Font Bakery report with which '
            + 'an informed assesment can be made by a human.');
        return;
    }
    // we should make an extra userInteraction message type for each of
    // these. This gives some certainty about the message content
    var statusName = finalizeMessage.getStatus()
      , status = string2statusCode(statusName)
      , reasoning = finalizeMessage.getReasoning(reasoning)
      ;
    if(!finishingStatuses.has(status))
        throw new Error('Status must be one of '
                + (finishingStatuses.join(', '))
                + ', but received: "' + statusName+ '" : ' + status);
    this._setStatus(status, reasoning);
};

TODO(); // user interactions describe how to display and handle
// required user interactions. These functions are used by the
// uiServer in contrast to the ProcessManager service.
// A uiServer will not be allowed to change the Process state directly
// instead, it can send messages to the ProcessManager.

// Instead of registering these explicitly, we will look for methods
// starting with "_userInteraction" that don't return false when called.
_p.uiFinalize = function() {
    // this should be managed differently!
    // if(!this._hasPrivateData('fontbakeryResultMessage'))
    //    return false;

    // in this case, show
    //      * a select field with the choices [FAIL, OK]
    //      * a text field with the label "Reasoning" (that can't be empty!?)
    return {
        roles: ['engineer']
      , ui: [
            {
                type: 'choice'
              , label: 'Set a final status.'
              , options: [[FAIL.toString(), FAIL.toString()], [OK.toString(), OK.toString()]]
            }
          , {
                type: 'line'
              , label: 'Describe your reasoning for the chosen status.'
            }
        ]
    };
};

_p._activate = function() {
    return this._getSharedData('familyData').then(FamilyDataMessage=>{
        this._createFamilyJob(FamilyDataMessage)
        .then(familyJob=>this._runFamilyJob(familyJob));
    });
};

/**
// One question is if we're better of structuring a task explicitly
// so that we always know what the next step is (after finishing the
// previous one.
// That way we remove probably some sources of error, like figuring if
// a callback/userInteraction is allowed to run.
//
//
_activate // _getSharedData ... _createFamilyJob ... _runFamilyJob ... _dispatchFamilyJob
// -> waiting for callbackFontBakeryFinished
callbackFontBakeryFinished // _setPrivateData('fontbakeryResultMessage', fontbakeryResultMessage);
// -> request (dispatch) user-interaction _userInteractionFinalize
// -> waiting for callbackFinalize
callbackFinalize // this._setStatus(finishingStatus, reasoning);

*/

return FontbakeryTask;
})();


const FontBakeryStep = (function(){
const Parent = Step;
/**
 * DiffbrowsersTask could be parallel to FontbakeryTask, it's only serial
 * because I want to conserve resources. There's no need to run DiffbrowsersTask
 * when FontbakeryTask failed.
 */
function FontBakeryStep(process, state) {
    Parent.call(this, process, state, {
        // needs font files package
        Fontbakery: FontbakeryTask // queue fontbakery
                      //   => wait for the result (CleanupJobs will have to call back)
                      //   => present the result and a form to make it pass or fail
                      //   => wait for user interaction to judge result
    });
}

const _p = FontBakeryStep.prototype = Object.create(Parent.prototype);
_p.constructor = FontBakeryStep;

return FontBakeryStep;
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


const ApproveProcessTask = (function(){
const Parent = Task;
function ApproveProcessTask(step, state) {
    Parent.call(this, step, state);
}

const _p = ApproveProcessTask.prototype = Object.create(Parent.prototype);
_p.constructor = ApproveProcessTask;

_p._activate = function() {
    // could be a different path for new/update processes
    // after this task, we hopefully can proceed uniformly
    this._setExpectedAnswer('Approve Process'
                                      , 'callbackApproveProcess'
                                      , 'uiApproveProcess');
};

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
                // TODO: get a list of available families from the CSV Source
              , options: fontFamilyGenres
            }
            */
        ]
    };
};

_p.callbackApproveProcess = function(requester, values) {
    var {action} = values;

    if(action === 'accept' ) {
        this._setLOG('**' + requester +'** accepted this process.');
        this._setExpectedAnswer('Sign-off Spreadsheet-update'
                                      , 'callbackSignOffSpreadsheet'
                                      , 'uiSignOffSpreadsheet');
    }
    else if(this.process.initType === 'new' && action === 'edit' ) {
        // could be two different UIs for either "update" or "new" processes.
        this._setExpectedAnswer('Edit Initial State'
                                      , 'callbackEditInitialState'
                                      , 'uiEditInitialState');
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
            return item;
        })
    };
    return result;
};

_p.callbackEditInitialState = function(requester, values) {
    values.action = 'new';
    values.note = this.process._state.note;
    return callbackPreInit(this._resources, requester, values)
    .then(([message, initArgs])=>{
        if(message) {
            // FIXME: should *just* log to the user
            // and best don't even change the form status, so that the
            // user can make changes;
            // TODO: this is a good case to improve the "back channel".
            throw new Error(message);
        }
        this.process._state.familyName = initArgs.familyName;
        this.process._state.repoNameWithOwner = initArgs.repoNameWithOwner;
        this.process._state.genre = initArgs.genre;
        this.process._state.fontfilesPrefix = initArgs.fontfilesPrefix;

    })
    // return to the activate form
    .then(()=>this._activate());
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

_p.callbackSignOffSpreadsheet = function(requester, values) {
    if(values.accept === true)
        this._setOK('**' + requester + '** confirms spreadsheet entry.');
    else if (values.accept === false)
        this._setFAILED('**' + requester + '** can\t confirm the spreadheet '
                + 'entry is good:\n' + values.reason);
};


return ApproveProcessTask;
})();



const ApproveProcessStep = (function() {
const Parent = Step;
/**
 * Make a the PR or manually fail with a reasoning.
 */
function ApproveProcessStep(process, state) {
    Parent.call(this, process, state, {
        //(engineer): Review form info is good.
        //        -> should have a way to modify the state from init
        //(engineer): updates spreadsheet -> just a sign off
        //        -> may be done by the form eventually
        ApproveProcess: ApproveProcessTask
    });
}
const _p = ApproveProcessStep.prototype = Object.create(Parent.prototype);
_p.constructor = ApproveProcessStep;
return ApproveProcessStep;
})();


/**
 * This is a special step. It runs immediately after the first failed
 * step and closes the process
 *
 * Create an issue somewhere on GitHub.
 */

const FailTask = EmptyTask;

const FailStep = (function(){
const Parent = Step;
/**
 * Make a the PR or manually fail with a reasoning.
 */
function FailStep(process, state) {
    Parent.call(this, process, state, {
        Fail: FailTask
    });
}
const _p = FailStep.prototype = Object.create(Parent.prototype);
_p.constructor = FailStep;
return FailStep;
})();



const stepCtors = [
              ApproveProcessStep
          //  InitProcessStep
          //, FontBakeryStep
          //, RegressionsStep
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
    this._state.repoNameWithOwner = repoNameWithOwner;
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
            // TODO: add multi-field to change Authors info, this is a
            // common request especially for updates, when new authors are
            // added, but also for new entries, when initial authors are added.
        ]
    };
    var newUi = _getInitNewUI().map(item=>{
        // show only when "action" has the value "new"
        item.condition = ['action', 'new'];
        return item;
    });
    result.ui.push(...newUi);

    result.ui.push({
                name: 'notes'
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
        // FIXME: We should check properly if this is a public(!) repo.
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
        return resources.getUpstreamFamilyList().then(familyList=>{
            if(familyList.indexOf(values.family) === -1)
                messages.push('You must pick a family from the list to update.');
            familyName = values.family;
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
        if(!repoNameWithOwner)
            messages.push('Got no repoNameWithOwner.');
            // FIXME check user roles/authoriztion!
        if(messages.length)
            // markdown list ...?
            message = ' * '+ messages.join('\n * ');
        else
            // TODO
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
    familyName: {
        init: ()=>null
      , load: val=>val
      , serialize: val=>val
    }
    /**
     * For authorization purposes, maybe just the requester ID/handle,
     * (a string) so that we can get the roles of the requester
     * from the DB.
     */
  , requester: {
        init: ()=>null
      , load: val=>val
      , serialize: val=>val
    }
    /**
     * We need this to determine the roles of a authenticated (GitHub)
     * user. Users having WRITE or ADMIN permissions for the repo have
     * the role "input-provider".
     */
  , repoNameWithOwner: {
        init: ()=>null
      , load: val=>val
      , serialize: val=>val
    }
  , initType: {
        init: ()=>null
      , load: val=>val
      , serialize: val=>val
    }
  , genre: {
        init: ()=>null
      , load: val=>val
      , serialize: val=>val
    }
  , fontfilesPrefix: {
        init: ()=>null
      , load: val=>val
      , serialize: val=>val
    }
  , note: {
        init: ()=>null
      , load: val=>val
      , serialize: val=>val
    }
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
