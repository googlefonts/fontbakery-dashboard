"use strict";
/* jshint esnext:true, node:true*/

const { Process:Parent } = require('./framework/Process')
    , { Step } = require('./framework/Step')
    , { Task, string2statusItem, finishingStatuses } = require('./framework/Task')
    ;

const GetFamilyDataTask = (function(){

const Parent = Task;
function GetFamilyDataTask() {
    Parent.call(this);
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
    familyRequest.setSourceid('CSVSpreadsheet')
    familyRequest.setFamilyName(this.process.familyName)
    return this.grpcSourceClient.get(familyRequest)
        .then(familyDataMessage => {
            // this is nice, we'll have all the info of the files
            // of the progress available in the document
            this._setLOG(familyDataSummaryMarkdown);
            return this._setSharedData('familyData', familyDataMessage)
                .then(()=>this._setOK('Family data is persisted.'))
        });
        // error case will be handled and FAIL will be set
};

return GetFamilyDataTask;
})();


const InitProcessStep = (function() {
const Parent = Step;
function InitProcessStep() {
    Step.call(this);
}

const _p = InitProcessStep.prototype = Object.create(Parent.prototype);
_p.constructor = InitProcessStep;

InitProcessStep.tasks = {
    GetFamilyData: GetFamilyDataTask // => where to put the files etc?
};
return InitProcessStep;
})();


const FontbakeryTask = (function(){
const Parent = Task;
function FontbakeryTask() {
    Parent.call(this);
}

const _p = FontbakeryTask.prototype = Object.create(Parent.prototype);
_p.constructor = FontbakeryTask;


_p._createFamilyJob = function(FamilyDataMessage) { // -> FamilyJobMessage
    throw new Error('Not Implemented _createFamilyJob');
    // include to call "callbackFontBakeryFinished" with a fontbakeryResultMessage
};

_p._dispatchFamilyJob = function(ticket, familyJob) {


};

_p._runFamilyJob = function(familyJob) {
    var callbackTicket = this._setExpectedAnswer('Font Bakery', 'callbackFontBakeryFinished');
    return this._dispatchFamilyJob(callbackTicket, familyJob)
    .then(reportID=>{
        this._setPrivateData('reportId', reportId);
        // This improves the information of the PENDING status by showing
        // the Font Bakery report details.
        this._setPENDING(renderMD('Waiting for Font Bakery [report '
                        + reportID + '](' + linkToFontbakeryReport + ')' ));
        return reportId;
    });
};

_p.callbackFontBakeryFinished = function(fontbakeryResultMessage) {
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
    return this._requestUserInteraction('userInteractionFinalize', 'callbackFinalize');


    TODO;  // The task is now waiting for user interaction
           // this needs to be communicated to the applicable users
           // as such:
           //       * we MAY send out emails (later)
           //       * we SHOULD provide an overview to the users for all
           //         processes that are awaiting direct human interaction.
           //         If the current watching user is authorized to perform
           //         the action, we should also mark these processes
           //         specially and also put them into a personal list:
           //               processes awaiting your attention
};

_p.callbackFinalize = function(finalizeMessage) {
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
      , status = string2statusItem(statusName)
      , reasoning = finalizeMessage.getReasoning(reasoning)
      ;
    if(!finishingStatuses.has(status))
        throw new Error('Status must be one of '
                + (finishingStatuses.join(', '))
                + ', but received: "' + statusName+ '" : ' + status);
    this._setStatus(status, reasoning);
};

TODO; // user interactions describe how to display and handle
// required user interactions. These functions are used by the
// uiServer in contrast to the ProcessManager service.
// A uiServer will not be allowed to change the Process state directly
// instead, it can send messages to the ProcessManager.

// Instead of registering these explicitly, we will look for methods
// starting with "_userInteraction" that don't return false when called.
_p._userInteractionFinalizeDefine = function() {
    // this should be managed differently!
    // if(!this._hasPrivateData('fontbakeryResultMessage'))
    //    return false;

    // in this case, show
    //      * a select field with the choices [FAIL, OK]
    //      * a text field with the label "Reasoning" (that can't be empty!?)
    return [
        new uiAPI.Select({
            id: 'status'
          , label: 'Set a final status.'
          , type: 'select'
          , select: [FAIL.toString(), OK.toString()]
        })
      , new uiAPI.Text({
            id: 'reasoning'
          , label: 'Describe your reasoning for the chosen status.'
          , type: 'text'
        }
    ];
}
_userInteractionFinalizeReceive = function(userResponse) {
    // hmmm, this should maybe be just a stand alone function
    // coupling it with a promise seems adventurous...
    // at least if we're going to call it multiple times ...
    // if not multiple times, we may have to delete the promise
    // alongside with the instance of the process.
    // so in a model where the request for a UI is decoupled from
    // the response from the UI, e.g. another frontend server can
    // respond.

    // This is the result
    var finalizeMessage = new UserInteractionFontBakeryFinalize();
    finalizeMessage.setStatus(userResponse.state);
    finalizeMessage.setReasoning(userResponse.reasoning);
    return finalizeMessage;

    TODO; // _sendToProcessManager(callbackTicket, finalizeMessage);
};

_p._activate = function() {
    return this._getSharedData('familyData').then(FamilyDataMessage=>{
        this._createFamilyJob(FamilyDataMessage)
        .then(familyJob=>this._runFamilyJob(familyJob))
    });
};


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

return FontbakeryTask;
})();


const FontBakeryStep = (function(){
const Parent = Step;
/**
 * DiffbrowsersTask could be parallel to FontbakeryTask, it's only serial
 * because I want to conserve resources. There's no need to run DiffbrowsersTask
 * when FontbakeryTask failed.
 */
function FontBakeryStep() {
    Parent.call(this);
}

const _p = FontBakeryStep.prototype = Object.create(Parent.prototype);
_p.constructor = FontBakeryStep;

FontBakeryStep.tasks = {
    // needs font files package
    Fontbakery: FontbakeryTask // queue fontbakery
                      //   => wait for the result (CleanupJobs will have to call back)
                      //   => present the result and a form to make it pass or fail
                      //   => wait for user interaction to judge result
};

return FontBakeryStep;
})();


function RegressionsStep() {}


RegressionsStep.tasks = {
    // needs font files package
    // produces images
    // the UI will need the images
    Diffbrowsers: DiffbrowsersTask // queue diffbrowsers tool (can this run on our workers?)
                     // OR maybe a simple diffbrowsers service that's not massively parallel
                     // when we need more we can still scale this
                     // will call back when done
                     // wait for user interaction to judge result
};

/**
 * Make a the PR or manually fail with a reasoning.
 */
function DispatchStep() {}

DispatchStep.tasks = {
    DispatchPR: DispatchPRTask // we want this to be done by authorized engineers only
                    // will create a nice PR with good message
};

/**
 * This is a special step. It runs immediately after the first failed
 * step and closes the process
 *
 * Create an issue somewhere on GitHub.
 */
function FailStep(){}

FailStep.tasks = {
    Fail: FailTask
};

function FamilyPRDispatcherProcess(state) {
    Parent.call(this, state);
}

const _p = FamilyPRDispatcherProcess.prototype = Object.create(Parent.prototype);
_p.constructor = FamilyPRDispatcherProcess;

FamilyPRDispatcherProcess.steps = [
    InitProcessStep
  , FontBakeryStep
  , RegressionsStep
  , DispatchStep
];

FamilyPRDispatcherProcess.FailStep = FailStep;
// optional
// FamilyPRDispatcherProcess.FinallyStep = FinallyStep;

