#! /usr/bin/env node
"use strict";
/* jshint esnext:true, node:true */

const grpc = require('grpc')
  , https = require('https')
  , { URL } = require('url')
  , querystring = require('querystring')
  , { AsyncQueue } = require('./util/AsyncQueue')
  , NodeGit = require('nodegit')
  , { GitHubOperationsService } = require('protocolbuffers/messages_grpc_pb')
  , { StorageKey, SessionId, GitHubReport, Files} = require('protocolbuffers/messages_pb')
  , { Empty } = require('google-protobuf/google/protobuf/empty_pb.js')
  , { ProtobufAnyHandler } = require('./util/ProtobufAnyHandler')
  , { StorageClient }  = require('./util/StorageClient')
  , { GitHubAuthClient } = require('./util/GitHubAuthClient')
  , { IOOperations } = require('./util/IOOperations')
  ;

const GITHUB_API_HOST = 'api.github.com'
    , GITHUB_API_GRAPHQL_PATH = '/graphql'
    , GITHUB_HTTPS_GIT_URL = 'https://github.com/{remoteName}.git'
    , GITHUB_BRANCH_URL = 'https://github.com/{remoteName}/tree/{branchName}'
    ;


function GitHubRef(repoOwner, repoName, name
              // if this has no upstream, it is it's own upstream
            , upstream=null// string: optional; name of another repo
            , oAuthToken=null // string: optional; for pushing
              // Only used when upstream is set.
              // Without rebasing, the prTarget may be outdated and the
              // PR on GitHub shows too many commits ...
              // this is configurable, because the repo policy may
              // conflict with that behavior.
              // There won't be force pushes with this ever. This means
              // we'll fail here if the rebase is not compatible and
              // do not change the remote history too drastic, force
              // push means rewriting the history.
            , updateWithUpstreamBeforePR=false // boolean: optional
            ) {
    this.repoOwner = repoOwner;
    this.repoName = repoName;
    this.branchName = name;
    this.upstream = upstream;
    this.oAuthToken = oAuthToken;
    this.updateWithUpstreamBeforePR = updateWithUpstreamBeforePR || false;
    // e.g. "google/fonts"
    this.remoteName = [this.repoOwner, this.repoName].join('/');
    this.remoteUrl = GITHUB_HTTPS_GIT_URL
                            .replace('{remoteName}', this.remoteName);
    this.branchUrl = GITHUB_BRANCH_URL
                            .replace('{remoteName}', this.remoteName)
                            .replace('{branchName}', this.branchName)
                            ;
    this.prHead = this.repoOwner + ':' + this.branchName;
    Object.freeze(this);
}

/**
 *
 */
function GitHubOperationsServer(logging, port, setup, repoPath
                                        , remoteRefs, ghPRSetup) {
    this._log = logging;
    this._repoPath = repoPath;
    this._queue = new AsyncQueue();
    this._any = new ProtobufAnyHandler(this._log, {GitHubReport:GitHubReport});

    this._remoteRefs = new Map(Object.entries(remoteRefs));
    this._ghPRSetup = new Map(Object.entries(ghPRSetup));

    this._io = new IOOperations(setup.logging, null /* setup.db */, setup.amqp);

    this._auth = new GitHubAuthClient(
                                this._log
                              , setup.gitHubAuth.host
                              , setup.gitHubAuth.port);
    this._storage = new StorageClient(
                                this._log
                              , setup.persistence.host
                              , setup.persistence.port
                              , { Files });

    this._server = new grpc.Server({
        'grpc.max_send_message_length': 80 * 1024 * 1024
      , 'grpc.max_receive_message_length': 80 * 1024 * 1024
    });

    this._server.addService(GitHubOperationsService, this);
    this._server.bind('0.0.0.0:' + port, grpc.ServerCredentials.createInsecure());
}

var _p = GitHubOperationsServer.prototype;

function _copyKeys(target, source, skip) {
    for(let [k,v] of Object.entries(source)) {
        if(skip && skip.has(k))
            continue;
        target[k] = v;
    }
}

_p._getRemoteRef = function(remoteName) {
    var remoteRef = this._remoteRefs.get(remoteName);
    if(!remoteRef)
        throw new Error(`"${remoteName}" is no GitHub remote reference.`);
    return remoteRef;
};

_p._getPRSetup = function(prTargetName) {
    var prSetup = this._ghPRSetup.get(prTargetName);
    if(!prSetup)
        throw new Error(`"${prTargetName}" is no PR-Target.`);
    return prSetup;
};

_p._getPRRemoteRef = function(prTargetName) {
    var prSetup = this._getPRSetup(prTargetName);
    return [prSetup.target, this._getRemoteRef(prSetup.target)];
};

/**
 * If pushTarget is not defined this returns the pr target
 * remote reference to push to.
 */
_p._getPushRemoteRef = function(prTargetName) {
    var prSetup = this._getPRSetup(prTargetName)
      , remoteName = prSetup.pushTarget || prSetup.target
      ;
    return [remoteName, this._getRemoteRef(remoteName)];
};

/**
 * If repo.upstream is not defined in the prTarget this returns the same
 * repo as `this._getPRRemoteRef(prTargetName)` would.
 */
_p._getUpstreamRemoteRef = function(prTargetName) {
    var prSetup = this._getPRSetup(prTargetName)
      , remoteName = prSetup.target
      , remoteRef = this._getRemoteRef(prSetup.target)
      ;
    // if this has no upstream, it is it's own upstream.
    if(remoteRef.upstream)
        return [remoteRef.upstream, this._getRemoteRef(remoteRef.upstream)];
    else
        return [remoteName, remoteRef];
};

_p._sendRequest = function(url, options, bodyData) {
    var reqUrl = new URL(url)
      , options_ = {
            method: bodyData ? 'POST' : 'GET'// override with `options` arg
          // , port: 443 // 443 is the default for https
          , headers: {
                'Accept': 'application/json'
              , 'User-Agent': 'Font Bakery: GitHub Pull Request Client'
              // For graphQL, do stuff like this:
              // , 'Content-Type': 'application/json'
              // , 'Content-Length': body.length
              // , 'Authorization': 'bearer ' + this._gitHubAPIToken
            }
        }
      , body = null
      ;

    if(options) {
        _copyKeys(options_, options, new Set(['headers']));
        if('headers' in options)
            _copyKeys(options_.headers, options.headers);
    }

    if(bodyData) {
        if(options_.headers['Content-Type'] === 'application/json')
            body = JSON.stringify(bodyData);
        else // I guess 'text/plain' is the default
            body = querystring.stringify(bodyData);

        options_.headers['Content-Length'] = Buffer.byteLength(body);
    }


    function onResult(resolve, reject, res) {
        //jshint validthis:true
        var data = [ ]
          , successfulCodes = new Set([
                // adding to these as needed
                200 // OK
              , 201 // CREATED (creating PRs)
          ])
          ;
        res.setEncoding('utf8');
        res.on('data', chunk=>data.push(chunk));
        res.on('end', ()=>{
            try {
                let json = JSON.parse(data.join(''));
                if(!successfulCodes.has(res.statusCode)) {
                    var errorMessages = '';
                    if(json && json.errors && json.errors.length) {
                        // This can actually be really helpful information:
                        // {
                        //     message: 'Validation Failed',
                        //     errors:[
                        //         { resource: 'PullRequest',
                        //             code: 'custom',
                        //             message: 'A pull request already exists for graphicore:fontbakery-test_01.'
                        //         }
                        //     ],
                        //     documentation_url: 'https://developer.github.com/v3/pulls/#create-a-pull-request'
                        // }
                        errorMessages = ' Errors: \n' + json.errors
                            .map(err=>' * ['+err.code+'] '
                                      + err.resource
                                      +': ' + (err.message || err.field)
                            ).join('\n');
                    }

                    let error = new Error('('+res.statusCode+') ' + json.message
                                    + ' [' + options_.method + ' url: '+ url +']'
                                    + errorMessages);
                    this._log.debug(
                                 'HTTP', options_.method+ ':', res.statusCode
                                , 'url:', url
                                  // rate limit response headers may
                                  // become a thing:
                                  //   'x-ratelimit-limit': '5000',
                                  //   'x-ratelimit-remaining': '4997',
                                  //   'x-ratelimit-reset': '1548269436',
                                , 'headers:', res.headers
                                , 'json:', json);
                    error.code = res.statusCode;
                    error.isHTTPError = true;
                    throw error;
                }
                resolve(json);
            }
            catch(err) {
                reject(err);
            }
        });
        res.on('error', reject);
    }

    return new Promise((resolve, reject) => {
        var req = https.request(reqUrl, options_, result=>onResult.call(this
                                            , resolve, reject, result));
        req.on('error', reject);
        if (body)
            req.write(body);
        req.end();
    });
};

_p._sendGitHubGraphQLRequest = function(accessToken, query) {
    var url = [
            'https://'
          , GITHUB_API_HOST
          , GITHUB_API_GRAPHQL_PATH
        ].join('');
    return this._sendRequest(url, {
        headers:{
            'Content-Type': 'application/json'
          , 'Authorization': 'bearer ' + accessToken
        }
    }, query);
};

/**
 * $ git init
 */
_p._initRepository = function() {
    this._log.info('$ git init --bare '+ this._repoPath);
    return gitInit(this._repoPath, true)
    .then(
        repo => {
            this._log.info('Reporsitory is initialized.');
            this._repo = repo;
            return repo;
        }
      , err => {
            this._log.error('Can\'t init git reporsitory: ', err);
            throw err;
        }
    );
};


/**
 * $ git remote add upstream https://github.com/google/fonts.git
 * # verify remote
 * $ git remote -v
 */
_p._initUpstreams = function() {
    var promises = []
      , seen = new Set()
      ;
    for(let prTargetName of this._ghPRSetup.keys()) {
        let [remoteName, remoteRef] = this._getUpstreamRemoteRef(prTargetName);
        if(seen.has(remoteName))
            continue;
        seen.add(remoteName);
        promises.push(
            this._queue.schedule(gitRemoteGetAdd, this._repo
                              , remoteName, remoteRef.remoteUrl));
    }
    return Promise.all(promises);
};

_p._fetchRef = function(noQueue, remoteName, remoteUrl, referenceName) {
    var args = [this._log, this._repo , remoteName, remoteUrl, referenceName];
    if(noQueue)
        return fetchRef(...args);
    else
        return this._queue.schedule(fetchRef, ...args);
};

/**
 * $ git fetch upstream master
 *
 * this will run frequently before creating a new branch
 */
_p._fetchUpstreamMaster = function(remoteName, remoteRef, noQueue) {
    return this._fetchRef(noQueue
                        , remoteName
                        , remoteRef.remoteUrl
                        , remoteRef.branchName); // -> ref
};

_p._fetchUpstreamMasters = function() {
    var promises = []
      , seen = new Set()
      ;
    for(let prTargetName of this._ghPRSetup.keys()) {
        let [remoteName, remoteRef] = this._getUpstreamRemoteRef(prTargetName);
        if(seen.has(remoteName))
            continue;
        seen.add(remoteName);
                      // this is queued
        promises.push(this._fetchUpstreamMaster(remoteName, remoteRef));
    }
    return Promise.all(promises);
};

_p._branch = function(branchName, reference, force) {
    // https://www.nodegit.org/api/branch/#create
    // name: (String) Branch name, e.g. “master”
    // commit: (Commit, String, Oid) The commit the branch will point to
    // force: (bool) Overwrite branch if it exists
    this._log.debug('_branch:', branchName);
    return getCommitFromReference(reference)
        .then(commit=>this._repo.createBranch(branchName, commit, force));
        // -> branch reference!
};

/**
 *
 */
_p._replaceDirCommit = function(authorSignature, localBranchName, headCommitReference
                                    , dir, pbFilesMessage, commitMessage) {
    // jshint unused:vars
    // clear dir
    // put files into dir
    // commit -m commitMessage
    // return commitRef;

    // Some examples of needed APIs
    // demonstrating how to use "nodegit" to modify and read from a local bare git repo
    // https://gist.github.com/getify/f5b111381413f9d9f4b2571c7d5822ce
    //
    // nodegit/test/tests/treebuilder.js
    // https://github.com/nodegit/nodegit/blob/8306c939888954cc447adeb3a834952125085c35/test/tests/treebuilder.js
    //
    // commit example
    // https://gist.github.com/yofreke/9379d1156fe6f5f0be73
    this._log.debug('_replaceDirCommit:', dir);
    return getCommitResources(headCommitReference)
    .then(({reference, commit: headCommit, commitTree})=>{
        var repo = reference.owner();
        // put all files into the git object database
        return Promise.all(pbFilesMessage.getFilesList()
        // only files that are in the target dir
        .filter(pbFile=>pbFile.getName().indexOf(`${dir}/`) === 0)
        .map(pbFile=>{
                           // filename remove prefix `${dir}/`
            var filename = pbFile.getName().slice(`${dir}/`.length)
              , buffer = Buffer.from(pbFile.getData_asU8())
              ;
            return NodeGit.Blob.createFromBuffer(repo, buffer, buffer.length)
                .then(oid=>[filename, oid, NodeGit.TreeEntry.FILEMODE.BLOB]);
            }
        )) // ->files
        .then(entries=>insertOrReplaceDir(repo, commitTree, dir, entries))// -> oid
        .then(newTreeOID=>{
            return commitChanges(this._log
                               , repo
                               , authorSignature
                               , localBranchName
                               , newTreeOID
                               , headCommit// HEAD
                               , commitMessage);
        });

    });// -> returns new commit
    // dumpCommitContents(newCommit);
};


_p._makeRemoteBranchName = function(targetDirectory) {
    // -> Font_Bakery_Dispatcher-ofl_myfont
    // we could use the process id to make per process unique branches
    // let's wait and see if that's needed.
    return ['Font_Bakery_Dispatcher'
            , targetDirectory.split('/').join('_')
        ].join('-');

};

/**
 * make a PR:
 *   - fetch current upstream master
 *   - git branch {branchName}
 *   - get {package} for {cacheKey}
 *   - replace {gfontsDirectory} with the contents of {package}
 *   - git commit -m {commitMessage}
 *   - git push {remote ???}
 *   - gitHub PR remote/branchname -> upstream {commitMessage}
 */
_p.dispatchPullRequest = function(call, callback) {
    // jshint unused:vars

    this._log.debug('[gRPC:dispatchPullRequest]');
    callback(null, new Empty());
    // This branch will be overridden by each call to dispatch
    // hence, dispatch must not run async in multiple instances
    // using AsyncQueue. Since writing to git can't happen in parallel
    // as well, enforcing a concecutive order is necessary anyways.
    var localBranchName = 'dispatch_branch'
      // call.request is a protocolBuffer PullRequest
      , pullRequest = call.request
        // a protobuf SessionId message to get the github credentials
        // from grpc GitHubAuthServer
      , sessionId = pullRequest.getSessionId() // string
      , storageKey = pullRequest.getStorageKey() // string
      , targetDirectory = pullRequest.getTargetDirectory()
      , targetBranchName = this._makeRemoteBranchName(targetDirectory)
      , prMessageTitle =  pullRequest.getPRMessageTitle()
      , prMessageBody =  pullRequest.getPRMessageBody()
      , commitMessage = pullRequest.getCommitMessage()
      , processCommand = pullRequest.getProcessCommand()
      , prTargetName = pullRequest.getPRTarget()
      , [remoteName, pushRemoteRef] = this._getPushRemoteRef(prTargetName)
        // where the new branch is pushed to, to make the PR from
        // hmm, we could use the github api to find the clone of
        // the google/fonts repo of the user, but that way all PR-branches
        // end up at different repositories, will be confusing...
        // If we use a single repo, either each user needs write permissions,
        // which is probably best, or we use a single token for all these
        // operations, which is easiest and fastest for now.
      , remoteRef = new GitHubRef(pushRemoteRef.repoOwner
                                , pushRemoteRef.repoName
                                , targetBranchName
                                , null
                                  // must be allowed to push to remoteRef
                                , pushRemoteRef.oAuthToken)
      , report = new GitHubReport()
      ;
    // We know this already, even if we may fail to create it.
    report.setBranchUrl(remoteRef.branchUrl);

    var sessionIdMessage = new SessionId()
      , storageKeyMessage = new StorageKey()
      ;
    sessionIdMessage.setSessionId(sessionId);
    storageKeyMessage.setKey(storageKey);
    Promise.all([
        // collect more dependencies
        //  -> a OAuthTokenMessage -> oAuthToken.getAccessToken()
        this._auth.getOAuthToken(sessionIdMessage) // -> prOAuthToken
      , this._storage.get(storageKeyMessage)
    ]).then(([oAuthToken, pbFilesMessage])=>{
        // the user will make the PR
        var prOAuthToken = oAuthToken.getAccessToken()
          , userName = oAuthToken.getUserName()
          ;
        return this._getAuthorSignature(userName, prOAuthToken)
        .then(authorSignature=>{
            // schedule the actual work!
            this._log.info('this._queue.schedule _dispatch for', authorSignature.toString(true));
            return this._queue.schedule(
                this._dispatch.bind(this), authorSignature
              , localBranchName, targetDirectory, pbFilesMessage, commitMessage
              , [remoteName, remoteRef], prMessageTitle, prMessageBody
              , prTargetName, prOAuthToken
            );
        });
    })
    .then(result=>{
        // PR URL
        // console.log('PR result:', result) <- has lots! of info
        report.setStatus(GitHubReport.Result.OK);
        report.setUrl(result.html_url);
        report.setIssueNumber(result.number);
        return report;
    }, error=>{
        this._log.error('In dispatch to:', targetDirectory
                      , 'branch:', targetBranchName
                      , error);
        report.setStatus(GitHubReport.Result.FAIL);
        report.setError('' + error);
        return report;
    })
    .then(report=>this._sendDispatchResult(processCommand, report));
};


_p._sendDispatchResult = function(preparedProcessCommand
                                        , report /* a GitHubReport */) {
    var processCommand = preparedProcessCommand.cloneMessage()
      , anyPayload = this._any.pack(report)
      , buffer
      , responseQueue = preparedProcessCommand.getResponseQueueName()
      ;
    // expecting these to be already set
    // processCommand.setTicket(ticket);
    // processCommand.setTargetPath(targetPath);
    // processCommand.setCallbackName(callbackName);
    processCommand.setRequester('GitHub PR Server');
    processCommand.setPbPayload(anyPayload);
    buffer = Buffer.from(processCommand.serializeBinary());
    return this._io.sendQueueMessage(responseQueue, buffer);
};

/**
 * wrap this into a this._queue.schedule!
 */
_p._dispatch = function(authorSignature, localBranchName, targetDirectory
                      , pbFilesMessage, commitMessage, remote
                      , prMessageTitle, prMessageBody
                      , prTargetName, prOAuthToken) {
    this._log.debug('_dispatch:', prTargetName, targetDirectory);
    var [remoteName, remoteRef] = remote
      , [prRemoteName, prRemoteRef] = this._getPRRemoteRef(prTargetName)
      , [upRemoteName, upRremoteRef] = this._getUpstreamRemoteRef(prTargetName)
      ;
    // noQueue is true because _dispatch is/must be queued!
    return this._fetchUpstreamMaster(upRemoteName, upRremoteRef, true)// -> ref
    .then(reference=>this._branch(localBranchName, reference, true))
    .then(headCommitReference=>this._replaceDirCommit(authorSignature
                            , localBranchName, headCommitReference
                            , targetDirectory, pbFilesMessage, commitMessage))
    .then(()=>this._push(remoteName, localBranchName, remoteRef, true))
    .then(()=>this._updateUpstream(prRemoteName, prRemoteRef))
    // NOTE: at this point the PUSH was already successful, so the branch
    // of the PR exists or if it existed it has changed.
    .then(()=>this._gitHubGetOpenPullRequest(prOAuthToken
                            , prRemoteRef.repoOwner
                            , prRemoteRef.repoName
                            , remoteRef.prHead // head e.g. user:branchName
                            , prRemoteRef.branchName // base e.g. master
                            ))
    .then((getPRResult)=>{
        // We only create a new PR if it doesn't exists:
        // https://github.com/googlefonts/fontbakery-dashboard/issues/143
        // This has exactly one or no result, because of the combination
        // of the `head`, `base` and `status="open"` parameters in the
        // requst.
        //
        // if no result, the answer is an empty list and we create a new
        // PR.
        //
        // if one result: the issue number is result[0].number
        //      issue_url: "https://api.github.com/repos/graphicore/googleFonts/issues/43"
        //      html_url: "https://github.com/graphicore/googleFonts/pull/43"
        if(!getPRResult.length) {
            return this._gitHubPR(prOAuthToken
                           , prMessageTitle
                           , prMessageBody
                             // `${remoteRef.repoOwner}:${remoteRef.branchName}`
                           , remoteRef.prHead
                           , prRemoteRef
                           );
        }
        return this._gitHubIssueComment(prOAuthToken
                            , prRemoteRef.repoOwner
                            , prRemoteRef.repoName
                            , getPRResult[0].number // the issue number
                            , {body: `Updated:\n\n---\n${prMessageBody}`})
                            .then(result=>{
                                // Add the issue number, the calling code expects it.
                                result.number = getPRResult[0].number;
                                return result;
                            });
    });
};

_p._getIssueRequestBodyData = function(issueMessage) {
    var bodyData = {
            title: issueMessage.getTitle()
          , body: issueMessage.getBody()
        }
      , assignees = issueMessage.getAssigneesList()
      , milestone = issueMessage.getMilestone()
      , labels = issueMessage.getLabelsList()
      ;
    if(assignees.length)
        bodyData.assignees = assignees;
    if(milestone)
        bodyData.milestone = milestone;
    if(labels.length)
        bodyData.labels = labels;
    return bodyData;
};

/**
 * https://developer.github.com/v3/pulls/#list-pull-requests
 * GET /repos/:owner/:repo/pulls
 */
_p._gitHubGetOpenPullRequest = function(OAuthAccessToken, repoOwner, repoName, head, base) {
    this._log.debug('_gitHubIssue at:', repoOwner + '/' + repoName);
    var url = [
                'https://'
              , GITHUB_API_HOST
              , '/repos'
              , '/' + repoOwner
              , '/' + repoName
              , '/pulls'
              , '?state=open'
              , `&head=${encodeURIComponent(head)}`
              , `&base=${encodeURIComponent(base)}`
              ].join('')
      ;
    return this._sendRequest(
        url
      , {
            method: 'GET'
          , headers: {
                // In this case authorization may not be required for
                // public repositories.
                Authorization: 'bearer ' + OAuthAccessToken
            }
        }
    );
};

/**
 * POST /repos/:owner/:repo/issues/:issue_number/comments
 */
_p._gitHubIssueComment = function(OAuthAccessToken, repoOwner, repoName
                                            , issueNumber, bodyData) {

    var url = [
                'https://'
              , GITHUB_API_HOST
              , '/repos'
              , '/' + repoOwner
              , '/' + repoName
              , '/issues'
              , '/' + issueNumber
              , '/comments'
              ].join('')
      ;
    return this._sendRequest(
        url
      , {
            method: 'POST' // implied by adding body data ...
          , headers: {
                'Content-Type': 'application/json'
                // wondering when to use "bearer" vs. "token"
                // but it seems like "bearer" is the standard and
                // "token" is either github specific or an error in the docs
                // both "bearer" and "token" seem to work!
              , Authorization: 'bearer ' + OAuthAccessToken
            }
        }
      , bodyData
    );
};

/**
 * https://developer.github.com/v3/issues/#create-an-issue
 * POST /repos/:owner/:repo/issues
 */
_p._gitHubIssue = function(OAuthAccessToken, repoOwner, repoName, bodyData) {
    this._log.debug('_gitHubIssue at:', repoOwner + '/' + repoName);
    var url = [
                'https://'
              , GITHUB_API_HOST
              , '/repos'
              , '/' + repoOwner
              , '/' + repoName
              , '/issues'
              ].join('')
      ;
    return this._sendRequest(
        url
      , {
            method: 'POST' // implied by adding body data ...
          , headers: {
                'Content-Type': 'application/json'
                // wondering when to use "bearer" vs. "token"
                // but it seems like "bearer" is the standard and
                // "token" is either github specific or an error in the docs
                // both "bearer" and "token" seem to work!
              , Authorization: 'bearer ' + OAuthAccessToken
            }
        }
      , bodyData
    );
};

_p.fileIssue = function(call, callback) {
    // jshint unused:vars
    this._log.debug('[gRPC:fileIssue]');
    var issueMessage = call.request
      , sessionId = issueMessage.getSessionId() // string
      , repoOwner = issueMessage.getRepoOwner()
      , repoName = issueMessage.getRepoName()
      , bodyData =  this._getIssueRequestBodyData(issueMessage)
      , sessionIdMessage = new SessionId()
      , report = new GitHubReport()
      ;
    sessionIdMessage.setSessionId(sessionId);
    this._auth.getOAuthToken(sessionIdMessage)
    .then(oAuthToken=>{
        // the user will make the issue
        var userOAuthToken = oAuthToken.getAccessToken();
        // , userName = oAuthToken.getUserName()
        return this._gitHubIssue(userOAuthToken, repoOwner, repoName, bodyData);
    })
    .then(result=>{
        // result is documented in https://developer.github.com/v3/issues/#create-an-issue
        report.setStatus(GitHubReport.Result.OK);
        report.setUrl(result.html_url);
        report.setIssueNumber(result.number);
        return report;
    }, error=> {
        this._log.error('In fileIssue to:'
                      , repoName + '/' + repoOwner
                      , error);
        report.setStatus(GitHubReport.Result.FAIL);
        report.setError('' + error);
        return report;
    })
    .then(report=>callback(null, report));
};



_p.serve = function() {
    // Start serving when the database is ready
    // No db yet!

    return this._initRepository()
        .then(()=>this._initUpstreams())
        .then(()=>this._fetchUpstreamMasters())
        .then(()=>{
            this._log.info('Conecting external services...');
            return Promise.all([this._auth.waitForReady().then(()=>this._log.info('auth is ready now'))
                      , this._storage.waitForReady().then(()=>this._log.info('storage is ready now'))
                      , this._io.init().then(()=>this._log.info('io(amqp) is ready now'))
                      ]);
        })
        .then(()=>this._log.info('External services ready!'))
        .then(()=>this._server.start())
        ;
};



/**
 * https://developer.github.com/v3/users/emails/
 * needs the `user:email` scope
 * GET /user/emails
 * returns:
 *     [
 *     {
 *         "email": "octocat@github.com",
 *         "verified": true,
 *         "primary": true,
 *         "visibility": "public"
 *     }
 *     ]
 *
 * pick the primary===true email
 */
const USER_EMAIL_QUERY =`
query($login: String!) {
  user(login: $login) {
    email
  }
}
`;
_p._getAuthorSignature = function(userName, accessToken) {
    this._log.debug('_getAuthorSignature for: ', userName);
    var query = {
            query: USER_EMAIL_QUERY
          , variables: {
                login: userName
            }
        };
    return this._sendGitHubGraphQLRequest(accessToken, query)
    .then(result=> {
        // hmm maybe inspect result here!
            // The user's publicly visible profile email.
            // this may not be set!
        var userEmail = result.data.user.email
          , name = `${userName} via Font Bakery Dashboard`
            // returns: new signature, in case of error NULL
          , signature = NodeGit.Signature.now(name, userEmail)
          ;

        if(!userEmail) {
            // GitHub uses this to link the commit to to the account/login
            // So we need to user to set a public email address for us,
            // otherwise we can't create a nice commit.
            throw new Error(`Can't create a commit signature for name: `
                          + `**@${userName}**, because there's no public `
                          + `email address set in the GitHub profile. `
                          + `If you are **@${userName}**, please go to `
                          + `https://github.com/settings/profile and update `
                          + `the "Public email" entry. This email is used `
                          + `by GitHub to link the commit to your profile.`);
        }
        signature = NodeGit.Signature.now(name, userEmail);
        if(signature === null) {
            // It's too bad that this is not giving us a proper error
            // mesage with a hint of what went wrong!
            throw new Error(`Cant create signature for name: ${name} mail: ${userEmail}`);
        }
        return signature;
    });
};

// from https://gist.github.com/getify/f5b111381413f9d9f4b2571c7d5822ce
function commitChanges(log, repo, authorSignature, branchName, treeOID
                     , parentCommit, message) {
    log.debug('commitChanges:', branchName, authorSignature.toString(true));
    // currently looking to solve an error where the message is:
    // "Signature author is required."
    let committerSignature = authorSignature;
    return repo.createCommit(
        'refs/heads/' + branchName,
        authorSignature,
        committerSignature,
        message,
        treeOID,
        [parentCommit]
    )
    .then(commitID=>{
        return repo.getCommit(commitID);
    });
}

function deepInsert(repo, tree, path, items/* [[oid, mode], ...] */) {
    var [dirName, ...pathparts] = typeof path === 'string'
                        ? path.split('/')
                        : path
      , promise
      ;
    if(dirName) {
        var treeEntry = null;
        try {
            treeEntry = tree.entryByName(dirName);
        }
        // tree._entryByName(dirName) should return null if not found but seems broken
        catch(error){/*not found: pass*/}
        promise = Promise.resolve(treeEntry && treeEntry.isDirectory()
                        ? treeEntry.getTree()
                        : null) // if it's a file it will be replaced!
        .then(subTree=>deepInsert(repo, subTree, pathparts, items))
        .then(oid=>/*items = */[[dirName, oid, NodeGit.TreeEntry.FILEMODE.TREE]])
        ;
    }
    else
        promise = Promise.resolve(items);

    return Promise.all([
        NodeGit.Treebuilder.create(repo, tree/*null for a new dir*/)
      , promise
    ]).then(([treebuilder, items])=>{
        for(let item of items)
            treebuilder.insert(...item);
        return treebuilder.write();// -> promise [newTreeOid]
    });
}

function insertOrReplaceDir(repo, tree, path, items) {
    var pathParts = path.split('/')
      , target = pathParts.pop()
      ;

    return NodeGit.Treebuilder.create(repo, null)
    .then(treebuilder=>{
        for(let item of items)
            // item = [filename, oid, NodeGit.TreeEntry.FILEMODE.{BLOB|TREE}]
            treebuilder.insert(...item);
        return treebuilder.write();
    })
    .then(oid=>deepInsert(repo
                        , tree
                        , pathParts
                        , [[target, oid, NodeGit.TreeEntry.FILEMODE.TREE]]
                        )
    );
}

/**
 * wrap this into a this._queue.schedule!
 * NOTE: when called in _dispatch it is by wrapped!
 *
 * hmm, basically if I have the origins "upstream" and "origin" and "origin"
 * is a fork of "upstream". In branch master -> origin/master
 *      git fetch upstream
 *      git rebase upstream/master
 *      git push
 * brings my origin/master to the same state as upstream/master
 * so in this case, I should just push the local upstream branch to
 * the prTarget...
 */
_p._updateUpstream = function(remoteName, remoteRef) {
        // e.g. remoteName = "graphicore"  remoteRef.branchName = "master"
    var upstreamRemoteName = remoteRef.upstream
      , upstreamRemoteRef
      , fullLocalRef
      , force = false
      ;

    if(!upstreamRemoteName || !remoteRef.updateWithUpstreamBeforePR)
        return;
    upstreamRemoteRef = this._getRemoteRef(upstreamRemoteName);
    // e.g. refs/remotes/upstream/master
    fullLocalRef = `refs/remotes/${upstreamRemoteName}/${upstreamRemoteRef.branchName}`;
    return this._push(remoteName, fullLocalRef, remoteRef, force);
};

// push localBranchName -> to graphicore/googleFonts:fontbakery-test_01
_p._push = function(remoteName, localBranchName, remoteRef, force) {
    this._log.debug('_push:', remoteName, remoteRef.remoteName, remoteRef.branchName);
    return gitRemoteGetAdd(this._repo, remoteName, remoteRef.remoteUrl, true)
    .then(remote => {
            //
            // here `remoteName` was "staging"
            // and  `localBranchName` was "Font_Bakery_Dispatcher_2019_10_11_ofl_abeezee"
            //
            //      root@fontbakery-github-operations-68f5f75d8c-phmgq:/var/javascript/fontsgit# tree refs/
            //      refs/
            //      |-- heads
            //      |   `-- dispatch_branch
            //      |-- remotes
            //      |   |-- staging
            //      |   |   `-- Font_Bakery_Dispatcher_2019_10_11_ofl_abeezee
            //      |   `-- upstream
            //      |       `-- master
            //      `-- tags
            //
            // to push from a remote that was fetched e.g.:
            //     fullLocalRef = refs/remotes/upstream/master
            //     fullRemoteRef = refs/heads/master
            // localBranchName can also be a fullLocalRef
        var fullLocalRef = localBranchName.indexOf('refs/') === 0
                        ? localBranchName
                        : 'refs/heads/' + localBranchName
          , fullRemoteRef = 'refs/heads/' + remoteRef.branchName
          // refspec for force pushing must include a + at the start.
          , refSpec = (force ? '+' : '') + fullLocalRef + ':' + fullRemoteRef
          , options = {
                callbacks: {
                    // Seems for mac there's is a problem where
                    // libgit2 is unable to look up GitHub certificates
                    // correctly, this is a bypass but not needed on Linux.
                    // certificateCheck: ()=>1,
                    credentials: ()=>NodeGit.Cred.userpassPlaintextNew(
                                remoteRef.oAuthToken, "x-oauth-basic")
                }
            }
          ;
        this._log.debug('remote.push', refSpec);
        return remote.push([refSpec], options)
        .then(result=>{
            this._log.debug('_push DONE');
            return result;// -> undefined
        });
    });
};

/**
 * The GraphQL API for pull requests is still in preview.
 * For the mutator see createPullRequest:
 * https://developer.github.com/v4/mutation/createpullrequest/
 *
 * https://developer.github.com/v3/pulls/#create-a-pull-request
 * POST /repos/:owner/:repo/pulls
 * title: (string) Required. The title of the pull request.
 * head: (string) Required. The name of the branch where your changes are
 *                implemented. For cross-repository pull requests in the
 *                same network, namespace head with a user like this:
 *                username:branch.
 * base: (string) Required. The name of the branch you want the changes
 *                pulled into. This should be an existing branch on the
 *                current repository. You cannot submit a pull request to
 *                one repository that requests a merge to a base of another
 *                repository.
 * body: (string) The contents of the pull request.
 * maintainer_can_modify: (boolean) Indicates whether maintainers can modify
 *                the pull request.
 *
 * You can also create a Pull Request from an existing Issue by passing an
 *                Issue number instead of title and body.
 * (Could be a feature?  But seems a bit complicated for now.)
 *
 * issue: (integer)Required. The issue number in this repository to
 *                turn into a Pull Request.
 *
 * Response:
 *
 * Status: 201 Created
 * Location: https://api.github.com/repos/octocat/Hello-World/pulls/1347
 *
 * {
 *   "url": "https://api.github.com/repos/octocat/Hello-World/pulls/1347",
 *   "id": 1,
 *   "node_id": "MDExOlB1bGxSZXF1ZXN0MQ==",
 *   ...
 *   "number": 1347,
 *   ...
 *
 * CAUTION: Rate limits could become an issue for PRs:
 * https://developer.github.com/v3/#abuse-rate-limits
 *
 * handle this response:
 * HTTP/1.1 403 Forbidden
 * Content-Type: application/json; charset=utf-8
 * Connection: close
 * {
 *   "message": "You have triggered an abuse detection mechanism and have
 *               been temporarily blocked from content creation. Please
 *               retry your request again later.",
 *   "documentation_url": "https://developer.github.com/v3/#abuse-rate-limits"
 * }
 *
 * If you hit a rate limit, it's expected that you back off from making
 * requests and try again later when you're permitted to do so. Failure
 * to do so may result in the banning of your app.
 * You can always check your rate limit status at any time. Checking your
 * rate limit incurs no cost against your rate limit.
 *
 * https://developer.github.com/v3/rate_limit/
 *
 * We're getting a HTTP 422 Validation Failed when the PR already
 * exisits (base <- hewd combination), the JSON response is then:
 *  {
 *      message: 'Validation Failed',
 *      errors:[
 *          { resource: 'PullRequest',
 *            code: 'custom',
 *            message: 'A pull request already exists for graphicore:fontbakery-test_01.'
 *          }
 *      ],
 *      documentation_url: 'https://developer.github.com/v3/pulls/#create-a-pull-request'
 *  }
 *
 * https://developer.github.com/v3/#oauth2-token-sent-in-a-header
 * curl -H "Authorization: token OAUTH-TOKEN" https://api.github.com
 *
 * as @graphicore work with this: GITHUB_API_TOKEN
 * as the authenticated user:
 * sessionData.accessToken.access_token === 'ABCDEFGH1234567890'
 */
_p._gitHubPR = function(OAuthAccessToken
                      , title
                      , body  /* markdown */
                      , head  /* i.e. graphicore:fontbakery-test_01 */
                      , prBase /* new GitHubRef('google', 'fonts', 'master') */
                      ) {

    this._log.debug('_gitHubPR:', head, '=>', prBase.remoteName, prBase.branchName);
    var url = [
                'https://'
              , GITHUB_API_HOST
              , '/repos'
              , '/' + prBase.repoOwner
              , '/' + prBase.repoName
              , '/pulls'
              ].join('')
      ;
    return this._sendRequest(
        url
      , {
            method: 'POST' // implied by adding body data ...
          , headers: {
                'Content-Type': 'application/json'
                // wondering when to use "bearer" vs. "token"
                // but it seems like "bearer" is the standard and
                // "token" is either github specific or an error in the docs
                // both "bearer" and "token" seem to work!
              , Authorization: 'bearer ' + OAuthAccessToken
            }
        }
      , {   title: title
          , body: body
          , head: head
          , base: prBase.branchName
        }
    );
};

function gitInit(repoPath, isBare) {
    // doesn't fail if the repository exists already
    // returns the repository
    var isBareInt = isBare ? 1 : 0; // 1 == true but must be a number
    return NodeGit.Repository.init(repoPath, isBareInt);
}

/**
 * Note: this doesn't do network requests yet. Thus, at this point we won't
 * get an error if remoteUrl is problematic.
 */
function gitRemoteGetAdd (repo, remoteName, remoteUrl, allowUpdateUrl) {
    return NodeGit.Remote.create(repo, remoteName, remoteUrl)
    .then(null, err => {
        if(err.errno !== NodeGit.Error.CODE.EEXISTS)
            throw err;
        // => err.errno === NodeGit.Error.CODE.EEXISTS
        // NOTE: the remote returned by Repository.getRemote has
        // a reference to the repository:
        // remote.repo, while the remote created using NodeGit.Remote.create
        // doesn't have that reference.
        // in both cases remote.owner() returns a repository, but these
        // are not the same instance as repo
        return repo.getRemote(remoteName).then(remote => {
            if(remote.url() === remoteUrl)
                return remote;

            // the url is different

            if(!allowUpdateUrl)
                throw new Error('Remote "'+remoteName+'" exists '
                        + 'pointing to "'+remote.url()+'" but url "'
                        + remoteUrl+'" is expected and updating is '
                        + 'not allowed.');

            // update the remote
            // remote.setUrl is sync; Returns Number 0 or an error value
            let result = remote.setUrl(repo, remoteName, remoteUrl);
            if(result !== 0)
                throw new Error('`remote.setUrl` failed with error '
                    + 'value "'+result+'" trying to set  remoteName: "'
                    + remoteName + '"; remoteUrl: "' + remoteUrl + '".');
            return remote;
        });
    });
}

function getRef(repo, remoteName, referenceName) {
    // use _fetchRef to also update the ref
    var fullReferenceName = [remoteName, referenceName].join('/'); // m4rc1e/fonts/pacifico ???
    return repo.getReference(fullReferenceName);
}

function fetchRef(log, repo, remoteName, remoteUrl, referenceName, allowUpdateUrl) {
    return gitRemoteGetAdd(repo, remoteName, remoteUrl, allowUpdateUrl)
    .then(remote => {
        if(log)
            log.info('Started fetching remote "'
                            + remoteName + ':' + referenceName + '"');
        // this may take a while!
        // E.g. initially fetching google/fonts:master
        // also, it kind of fails silently if there's no referenceName
        // at remote. Thus, later is checked if we can get the actual
        // reference from the repo.
        return remote.fetch(referenceName).then(()=>remote);
    })
    .then((remote) => getRef(remote.owner() /* = repository */
                                    , remoteName, referenceName))
    .then(ref => {
        // this does not mean the remote reference exists now
        if(log)
            log.info('Finished fetching remote "'
                            + remoteName + ':' + referenceName + '"', ref.target());
        return ref;
    }, err => {
        if(err.errno === NodeGit.Error.CODE.ENOTFOUND)
        // message: no reference found for shorthand '{fullReferenceName}'
        // errno: -3
        // at the moment E.g.: ERROR upstream: FAILED: Fetching remote "upstream/Rakkas:master"
        // … for shorthand 'upstream/Rakkas/master'
        // And indeed, there's only a `gh-pages` branch (which is the default as well)
            if(log)
                log.error('FAILED: Fetching remote (branch) '
                            + '"' + remoteName + ':' + referenceName + '" '
                            + 'at url: ' + remoteUrl);
        throw err;
    });
}


function getCommitFromReference(reference) {
    // on error: If reference target is something else
    // message: the requested type does not match the type in ODB
    //          errno: -3 }
    return NodeGit.Commit.lookup(reference.owner(), reference.target());
}

function getCommitResources(reference) {
    var result = {
            reference: reference
          , commit: null
          , commitTree: null
        }
      ;

    return getCommitFromReference(reference)
        .then(commit => {
            result.commit = commit;
            return commit.getTree();
        })
        .then(commitTree => {
            result.commitTree = commitTree;
        })
        .then(() => result)
        ;
}

module.exports.GitHubOperationsServer = GitHubOperationsServer;

if (typeof require != 'undefined' && require.main==module) {
    var { getSetup } = require('./util/getSetup')
      , repoPath = '/var/git-repositories/github.com_google_fonts.git'
      , setup = getSetup(), gitHubOperationsServer, port=50051
        // all PRs are based on the respective upstream repository branch
      , remoteRefs = {
            googlefonts: new GitHubRef(
                                'google', 'fonts', 'master'
                                // this has no upstream, it is its own upstream
                              , null
                              , setup.gitHubAPIToken
                              , false // updateWithUpstreamBeforePR
                              )
          , graphicore: new GitHubRef(
                                'graphicore', 'googleFonts', 'master'
                              , 'googlefonts' // upstream: the key in this "remoteRefs" object
                              , setup.gitHubAPIToken
                              , true // updateWithUpstreamBeforePR
                              )
        }
      , ghPRSetup = {
            production: {
                target: 'googlefonts'
                // we could also have a different repo for the push target
                // but we don't do this right now.
                // PRs to production push to  upstream.repoOwner/upstream.repoName
                //
                //
                // we will create our own branch and force push to it!
                //
                // we could use the users OAuthToken, but that may not
                // have the rights to do Pushes.
                // However, together with the users repo as pushTarget
                // using the access token of the user would be cool!
                // this would be a "dynamic" pushTarget that comes with
                // the users request.
                // We could look if the user has a fork of upstream and
                // If not, ask him to to make one (and maybe do it for him)
                // eventually nobody would have to push to google/fonts
                // -> does travis really only run when pushed to google fonts?
                // it should run on PullRequests/
                //
                // uses repoOwner, repoName , oAuthToken
                // creates a branch named by this._makeRemoteBranchName
                // FIXME: _makeRemoteBranchName uses targetDirectory, but
                // that may not be distinctive enough, because in sandbox
                // for example, we have the same target directories for
                // different sources, in case of a feature branch workflow!
                // It's coming from the process implementation, so we could
                // as well just set an explicit branch name in there.
              // , pushTarget: 'graphicore'
            }
          , sandbox: {
                target: 'graphicore'
            }
        }
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

    gitHubOperationsServer = new GitHubOperationsServer(setup.logging, port
                            , setup, repoPath, remoteRefs, ghPRSetup);
    gitHubOperationsServer.serve()
        .then(
              ()=>setup.logging.info('Server ready!')
            , error=>{
                setup.logging.error('Can\'t initialize server.', error);
                process.exit(1);
            }
        );
}
