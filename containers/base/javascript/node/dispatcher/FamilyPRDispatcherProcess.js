"use strict";
/* jshint esnext:true, node:true*/

const { Process:Parent } = require('./framework/Process')
  , { Step } = require('./framework/Step')
  , { Task } = require('./framework/Task')
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
    var familyRequest new FamilyRequest();
    familyRequest.setSourceid('CSVSpreadsheet')
    familyRequest.setFamilyName(this.process.familyName)
    this.grpcSourceClient.get(familyRequest)
        .then(familyDataMessage => {
            // this is nice, we'll have all the info of the files
            // of the progress available in the document
            this._setState(PENDING, familyDataSummaryMarkdown);
            return this._setSharedState('familyData', familyDataMessage)
                .then(()=>this._setState(OK, 'Family data is persisted.'))
        })
        .then(null, error=>this._setState(FAIL, renderError(error)))
        ;
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

InitProcessStep.tasks = [
    GetFamilyDataTask // => where to put the files etc?
];
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
};

_p._runFamilyJob = function(FamilyJob) {

    this._dispatchFamilyJob().then(reportID=>{
        this._setPrivateState('reportId', reportId);
        this._setState(PENDING, renderMD("# MD Started Font Bakery" + linkToFontbakeryReport));
        return reportId;
    });
};

_p.callbackFontBakeryFinished = function(fontbakeryResultMessage) {
    // hmm, can get the result also from the DB?
    // the reportID must be the same as the one we received in _runFamilyJob
    // otherwise, this task may have been re-activated and we're looking at
    // the wrong report and subsequently are setting the wrong state for
    // that wrong report.
    var expectedReportID = this._getPrivateState('reportId', null)
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
    this._setPrivateState('fontbakeryResultMessage', fontbakeryResultMessage);
    this._setState(PENDING, renderMD(fontbakeryResultMessage));
    FIXME; // The task is now waiting for user interaction
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
    if(!this._hasPrivateState('fontbakeryResultMessage')) {
        // The UI should not allow this callback to be made, but in
        // fringe cases like updates or such we may receive it.
        // There' will also be a way to exceptionally close a whole
        // step, e.g. if Font Bakery is not responding or something
        // else goes totally wrong.
        this._logStatus('The callback for finalizing the task regularly'
            + ' requires that there\'s a fontbakeryResultMessage, that means'
            + ' that there\'s a Font Bakery Report upon which a final assesment'
            + ' can be made by a human');
        );
    }
    // we should make an extra userInteraction message type for each of
    // these. This gives some certainty about the message content
    var statusName = finalizeMessage.getStatus()
      , status = statusItems[statusName]
      , reasoning = finalizeMessage.setReasoning(reasoning);
      ;
}

TODO; // user interactions describe how to display and handle
// required user interactions. These functions are used by the
// uiServer in contrast to the ProcessManager service.
// A uiServer will not be allowed to change the Process state directly
// instead, it can send messages to the ProcessManager.
_p._userInteractionFinalize = function() {
    if(!this._hasPrivateState('fontbakeryResultMessage'))
        return false;

    var finalizeMessage = new UserInteractionFontBakeryFinalize();
    finalizeMessage.setStatus(state);
    finalizeMessage.setReasoning(reasoning);
    return this._send('callbackFinalize', finalizeMessage);TODO;
}

_p._activate = function() {
    return readSomewhere('familyData').then(FamilyDataMessage=>{
        this._createFamilyJob(FamilyDataMessage)
        .then(FamilyJob=>this._runFamilyJob)
    });
}

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

FontBakeryStep.tasks = [
    // needs font files package
    FontbakeryTask // queue fontbakery
                      //   => wait for the result (CleanupJobs will have to call back)
                      //   => present the result and a form to make it pass or fail
                      //   => wait for user interaction to judge result
];

return FontBakeryStep;
})();


function RegressionsStep() {}


RegressionsStep.tasks = [
    // needs font files package
    // produces images
    // the UI will need the images
    DiffbrowsersTask // queue diffbrowsers tool (can this run on our workers?)
                     // OR maybe a simple diffbrowsers service that's not massively parallel
                     // when we need more we can still scale this
                     // will call back when done
                     // wait for user interaction to judge result
];

/**
 * Make a the PR or manually fail with a reasoning.
 */
function FinalizeStep() {}

FinalizeStep.tasks = [
    DispatchPRTask  // we want this to be done by authorized engineers only
                    // will create a nice PR with good message
]

/**
 * This is a special step. It runs immediately after the first failed
 * step and closes the process
 *
 * Create an issue somewhere.
 */
function FailStep(){}

FailStep.tasks = [
    FailTask
]

function FamilyPRDispatcherProcess(state) {
    Parent.call(this, state);
}

const _p = FamilyPRDispatcherProcess.prototype = Object.create(Parent.prototype);
_p.constructor = FamilyPRDispatcherProcess;

FamilyPRDispatcherProcess.steps = [
    InitProcessStep
]
