#! /usr/bin/env node
"use strict";
// this is expected to run in nodejs
/* global require, module */
/* jshint esnext:true */

const express = require('express')
  , http = require('http')
  ;

function appFactory() {
    var app = express();
    app.get('/', (req, res, next)=>res.send('subApp root' + ' originalUrl:' + req.originalUrl + ' ' + 'baseUrl:' + req.baseUrl + ' ' +  'path:' + req.path + ' ' + 'url:' + req.url));
    app.get('/page', (req, res, next)=>res.send('subApp /page' + ' originalUrl:' + req.originalUrl + ' ' + 'baseUrl:' + req.baseUrl + ' ' +  'path:' + req.path + ' ' + 'url:' + req.url));
    return app;
}

const UiApi = (function(){

function UiApi(){}
const _p = UiApi.prototype;

// This kind of interaction either is coupled to a socket based communication
// OR, it requires some abstraction to piece it all together...
// Though, maybe it can be done...
// What is the the live expectation of the promise (returned by task._userInteraction{...}???
// if we have race conditions, we want to handle them gracefully.
// In general. I think the promise construct in here describes nicely
// the kind of ineraction that is expected. BUT it may be a bit complicated
// to orchestrate.
--
--
// TODO: NEXT: start sketching the UIServer in here, that loads processes
// and asks them among other things for their expected user interactions
// etc. How to do a correct feedback loop that goes through the model (react||process manager)
// ...
_p.request = function(...uiItems){
    var userResponsePromise = Promise((resolve, reject)=>{
        // generate the interfaces


        // wait for answers.

    });
    return userResponsePromise;
}

return UiApi;
})();


// used like this
// -> a promise; expecting uiApi.response(userResponse)
// to be called to fullfill the promise?
uiApi.request(
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
        })
    // this is bolloks, as it doesn't tell the whole story...
    // uiApi.request = funtion(...uiItems){
    //    var promise = new Promise((resolve, reject)=>{
    //        // here we need arrange that we can call
    //        // resolve(userResponse) maybe.
    //    });
    //    return promise;
    // }
    // // but what is this function supposed to do with
    // user Response
    ).then(userResponse=>{

/**
 * Using a class here, so state variables are managed not on module level
 * Initialization starts the server.
 *
 * `Server` is for stand alone use (development, testing). It also documents
 *  how to use `appFactory`.
 * `appFactory` is for use as a sub-application in another express.js app.
 */
function Server(logging, portNum, ProcessConstructor) {
    this._log = logging;
    this.ProcessConstructor = ProcessConstructor;
    this._app = appFactory();
    this._server = http.createServer(this._app);
    this._server.listen(portNum);
}

var _p = Server.prototype;

_p._getProcess = function(processId) {
    // what if we have process already loaded?
    // do we keep it at all?
    // we have to update its state when it changes!
    FIXME;// Won't be loaded from the DB but from ProcessManager
    var state = dbFetch(processId)
        // .then(process
      , process = new this.ProcessConstructor(state)
      ;
    FIXME;//return process.activate().then(()=>prcoess) ???
    return process;
};




// how to show a process?
// -> user goes to dispatcher/process/{processID}
// -> if pid exists, the ui is loaded.
// -> the ui requests the process data via SocketIO
//          -> this ensures we can get live updates
//  -> the ui receives process data and renders it
//  -> if there's a ui requested the server sends it
//  -> if the user sends a ui-form the server receives it
//  the server can send:
//      * changes to process/step/task statuses
//          -> task wise, this are mainly only additions to the task history
//      * user interface requests/removals to process/step/task
//              -> also responses whether a request was accepted or refused
//                 or, if applicable if the request failed.
//              -> maybe within a client/session specific log window
//                 it's not so interesting to have this data as a status
//                 in the task I guess.
//
// So, updates could also always update and redo the entire task
// or, at least additions to the task history bring their absolute index
// with them, so order of arrival is not that important.
//
// Process structure will never change, so it should be rather easy to
// implement all this.
// In fact, if the process structure is changed on the server, all
// running processes should be ended immediately and maybe link to a new
// process that is started instead.
//
// If we don't go with sockets, what are the alternatives?
// -> best: reload the process page when a ui is sent, but, then
//   other interactions are not live as well, like a pending fb-report
//   changing to a finsihed one. The page would need to be reloaded.
// That's maybe OK, user would kind of manually poll ... by reloading
// Or by posting a form to the page.
// But we don't need to, because we already have the infrastructure for
// a socket based UI.
// Bad thing so far: it was always very complex to implement these interfaces.
// especially the report and source interfaces were mad. The dashboard table
// was a bit better though!
//
// It may be nice to have a full html report for easy access e.g. to download
// and archive it, but we don't do this now at all. Maybe we can think
// of this stuff in a newer 2.0 version of the interfaces.


/**
 * Hmm,  looks like this has a GET/POST API in mind, receiving "request"
 * as an argument...
 */
_p.uiShowProcess = function(request) {
    var processId = request.processId // FIXME: just a sketch
      , process = this._getProcess(processId)
      ;


    if(process.userInteractionIsRequested) {
        if(request.userResponse) {
            // Todo: this must be a fit for the original defineUserInteracion
            // so some kind of id internal to the process state should make
            // sure this is a fit
            // ProcessManager must receive the interction, we must
            // eventually send it there.
            process.receiveUserInteracion(request.userResponse);


            // Maybe we can then just re-run this function?
            return; ... ?
        }


        uiApi = UiApi();
        uiAPI.request(...process.requestUserInteracion());
    }


    respond(processData)

}

_p._subscribe = function(socket, data) {
    var processId = data.id

    // first send the process structure, as it will never change for this
    // process id and we can use that for more rapid development of the interface
    // i.e. no need to take care of newly inserted steps or tasks or such.

    // then send the data for process, steps, tasks

    // if needed send user interfaces

    // send any updates that came in in the meanwhile

    // can we have a change stream from the processManager that is
    // semantically more meaningful than one directly from the database?
    // where is the translation of db changes -> meaningful changes done?
    // seems like the processmanager could benefit from it, then just send
    // the changes it translates along to its subscribers...


}



// !Plan here!
// Spent extra time to plan it as minimalistic and efficient as possible!

// The plan is to implement this as a state machine
// Steps: A step is made of one or more tasks.
//        All tasks must have a status of OK for the process can go to the next step.
//        If that is not the case the process fails and can't proceed to the next step.
//              -> there will be an explicit in between task to "finalize" a step
//              -> a finalized step either passes or not
//              -> when the step is finalized it *can't* be opened again, it's
//                 frozen. Before finalizing, especially tasks that are decided
//                 by humans can be re-run. Possibly all tasks, it makes sense
//                 in all cases where the computation is not idempotent, which
//                 is all cases right now.
//              -> after finalizing, if the step is not OK, the process is FAILED
//
// The proceed method is thus intrinsic for the process control. It's not
// quite clear if it should run automatically OR must be controlled by a human.
// In general, I tend to make an all-passing step proceed automatically, while
// a failing step will have to be finished (finishes the task as failing) by a human.
// That way, a human may prevent the failing state and it is given that a process
// closing is governed by a human, so it doesn't close unnoticed.
// That includes further steps, such as:
//          * filing an issue at upstream, google/fonts or even googlefonts/fontbakery-dashboard.
//            Ideally each failed process creates an issue somewhere! (reality will
//            not agree, but it's good to have ideals. If there's no other place to
//            file the bug, maybe `googlefonts/fontbakery-dashboard` is the place :-D
// A simple hack to make the auto-proceed go away would be a minimalistic task
// That requires human interaction. Just an ack: OK|FAIL would do. Maybe with
// a reasoning filed for a textual explanation.
//
// Each interaction with a task will have the authors github account attached
// to it.  Ideally, since we can change the results of tasks, there will
// be a history for each process. So, maybe in the DB, we'll have a list
// of status changes. On initialization of a task, status is always PENDING.
// So, tat should be the first status entry. Unless, init FAILED.
// `init` may also just OK directly, if the task is sync an can be decided
// directly.
// To redo a task we init it again, that's it. History is kept.
// Need a history inspection thingy. Each history item can just be rendered
// like the normal status. Should be not much more demanding than rendering
// just one thing.
//
// There's a lot of detailed work to implement the tasks, but everything
// else should be automated and standard. So that a task can be implemented
// focusing on its, well, task.
//
// Messaging:
// ==========
//
// A finished task writes a new status into its DB entry.
// There are different kinds of tasks and somehow they must all report to
// the DB. Ideally a process is monitoring (subscribing) to the database
// and on changes decides what to do, i.e. advance the process, inform the
// dev about a changed status (especially if it's a FAIL) and also inform
// the dev about required manual action. Other possible notifications are
// when a next step was entered (all passing statuses)
// The Frontend only displays the process-document, but also needs to provide
// interfaces for some tasks!
//   * Interface interactions needs to be send to the tasks for evaluation.
//   * I see myself dying over the interface implementation! DISLIKE! this
//     must be done very much more efficiently than I used to make it before.
//     - Plan possible interactions/reactions.
//     - Be quick and possibly dirty
//
//
// DO I need an extra long running process to monitor and control the
// dispatcher OR can the webserver do this? I tend to think an extra
// process is simpler, and all the web servers will talk to that.
// Sounds like a good separation of concerns to me, with the added problem
// that there's a lot of messaging to be done.
//   * What messages need to be sent?
//   * can the frontend display the process-doc without talking to that
//     service? (Ideally yes, just read/monitor the DB directly)
//   * The changes will come through via the db-subscription. Success/Fail
//     notifications may be interesting though.
//
//
// Processes/Code to be written:
//
// - UI-Server
// - UI-Client
// - process manager
// - task/step framework
// - basic task imlementations (Manual Ack Task, …)
// - special task implementations
// CONINUE HERE!
//
// The first special task is getting the package
// which is nice, we also need to persist these, getting is basically done
// This is an async task, but the get (the package) method returns at least
// directly. The fontbakery and diffbrowsers don't necessarily work that way
// we may need another active element, to send to and receive notifications
// about finished tasks.
// -- in case of Fontbakery:
//              - either monitor the DB
//              - or teach the cleanupjobs pod how/where to call back
//                when a report is done.
//
// What about versioning processes? Its clear that it will change and
// there are many instances that may fail when the details are changed.
//  - updated interfaces may fail rendering old tasks/steps/processes
//  - steps/tasks may disappear or appear.
//  - a process once started may be incompatible even before it finishes
//    with a changed process. So, we may init a process, then change the
//    general process structure and it would be hard to decide what to do
//    with the unfinished process. Can't continue(?) because we changed the
//    structure for a reason, that is, because it was insufficient before.
//    So, we should maybe discover that and fail all of these processes
//    automatically and maybe restart directly?
//  - Maybe, we use an explicit version and when changed, we know that the
//    unfinished processes are void/uncompleteable.
// * do we need to check periodically (cron-like) all open tasks for something?
// * on startup of process manager, it should check the versions of all
//   open tasks. Because, it's most likely that the version change happened
//   then, a version change will  always require a restart of the manager.
//   The only function of that version is to invalidate unfinished processes
//   and restart freshly.
//   => We should have a general process history, that can be used to
//      link the old and new processes together.
//      Forward from old to new?

// Tasks are firstly implemented in the process manager (via modules).
// Some tasks also require ui-interaction! It would be nice to have both
// in the same module, so we have it close together. The server module
// and the manager will load these explicitly.
// IMPORTANT: When a task changes manager AND ui-server must be updated
// otherwise there are incompatible implementations possible!
// Can the version thing help here too?
// Or we do fancy hot-swapping... hahaha, seems like a risky stupid thing
// to do with javascript, LOL!!!11!elf

// Namespace: what if a task needs to persist data? Either for itself
// or for another task in a later(also paralell task maybe) step?
// This may be very similar to hw we are going to resolve a "pending"
// status.
// So, the getPackage task may write to the `package` name and the Font Bakery
// task will read the `package` name. When organized into steps, we can
// get along without DI. Font Bakery would just Fail when `package` is
// not available and the developer is required to provide it, by putting
// getPackage into a prior step.
// So, do we use a file system fir this or the cache or a cache like
// service (a persistant cache?) or the DB directly?
// -> tendence: use a cache, but maybe extra to the one instance running
//    already.
//    * It's not persistant, but we can update the process manager and still
//      keep the data.
//    * making it persistent won't be hard, but we can get started without
//      that effort.

// TODO: plan more! This seems still too early to implement it the most
// efficient way possible!
// This stuff can also be a good start for documentation!
//
// process manager planning
// naming things! dispatcher process? Do I need to keep the dispatcher name?
// Could be the Familiy Pull Request Tool
//
// see:
// https://github.com/ciaranj/connect-auth
// https://github.com/doxout/node-oauth-flow
// https://github.com/simov/grant

// Side tasks: update FB workers to use Python 3.6
//             fix the db hickup: https://github.com/googlefonts/fontbakery-dashboard/issues/78

module.exports.appFactory = appFactory;
module.exports.Server = Server;

if (typeof require != 'undefined' && require.main==module) {
    var { getSetup } = require('./util/getSetup')
      , setup = getSetup()
      ;
    setup.logging.info('Init server ...');
    setup.logging.log('Loglevel', setup.logging.loglevel);
    // storing in global scope, to make it available for inspection
    // in the debugger.
    global.server = new Server(setup.logging, 3000);
}
