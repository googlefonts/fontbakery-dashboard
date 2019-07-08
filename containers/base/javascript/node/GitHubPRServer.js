#! /usr/bin/env node
"use strict";
/* jshint esnext:true, node:true */

const grpc = require('grpc')
  , https = require('https')
  , { URL } = require('url')
  , querystring = require('querystring')
  , { AsyncQueue } = require('./util/AsyncQueue')
  , NodeGit = require('nodegit')
  , { PullRequestDispatcherService } = require('protocolbuffers/messages_grpc_pb')
  , { StorageKey, SessionId, DispatchReport, Files} = require('protocolbuffers/messages_pb')
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

function GitHubRef(repoOwner, repoName, name) {
    this.repoOwner = repoOwner;
    this.repoName = repoName;
    this.branchName = name;
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
function GitHubPRServer(logging, port, setup, repoPath
                    , upstreamBranch, ghPushSetup, prTarget) {
    this._log = logging;
    this._repoPath = repoPath;
    this._queue = new AsyncQueue();
    this._any = new ProtobufAnyHandler(this._log, {DispatchReport:DispatchReport});

    this._ghPushSetup = ghPushSetup;

    this._upstreamBranch = upstreamBranch;
    // prTarget is where we want to pull our changes into.
    // If prTarget is not configured, we use this._upstream
    // this is a convention over configuration case.
    this._prTarget = prTarget || this._upstreamBranch;

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

    this._server.addService(PullRequestDispatcherService, this);
    this._server.bind('0.0.0.0:' + port, grpc.ServerCredentials.createInsecure());
}

var _p = GitHubPRServer.prototype;

function _copyKeys(target, source, skip) {
    for(let [k,v] of Object.entries(source)) {
        if(skip && skip.has(k))
            continue;
        target[k] = v;
    }
}

_p._sendRequest = function(url, options, bodyData) {
    var reqUrl = new URL(url)
      , options_ = {
            hostname: reqUrl.hostname
          , path: reqUrl.pathname
          , method: bodyData ? 'POST' : 'GET'// override with `options` arg
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
        var req = https.request(options_, result=>onResult.call(this
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
_p._initUpstream = function() {
    return gitRemoteGetAdd(this._repo, 'upstream', this._upstreamBranch.remoteUrl);
};

_p._fetchRef = function(noQueue, remoteName, remoteUrl, referenceName) {
    var func = () => fetchRef(this._log, this._repo
                                , remoteName, remoteUrl, referenceName);
    if(noQueue)
        return func();
    else
        return this._queue.schedule(func);
};


/**
 * $ git fetch upstream master
 *
 * this will run frequently before creating a new branch
 */
_p._fetchUpstreamMaster = function(noQueue) {
    return this._fetchRef(noQueue
                        , 'upstream', this._upstreamBranch.remoteUrl
                        , this._upstreamBranch.branchName); // -> ref
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
        return Promise.all(pbFilesMessage.getFilesList().map(pbFile=>{
            var filename = pbFile.getName()
              , buffer = Buffer.from(pbFile.getData_asU8())
              ;
            return NodeGit.Blob.createFromBuffer(repo, buffer, buffer.length)
                .then(oid=>[filename, oid, NodeGit.TreeEntry.FILEMODE.BLOB]);
            }
        )) // ->files
        .then(entries=>insertOrReplaceDir(repo, commitTree, dir, entries))// -> oid
        .then(newTreeOID=>{
            return commitChanges(repo
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
    var date = new Date()
      , zeroPadTwo = number=> ('00' + number).slice(-2)
      ;
    // -> Font_Bakery_Dispatcher_2019_01_25_ofl_myfont
    // we could use the process id to make per process unique branches
    // let's wait and see if that's needed.
    return ['Font', 'Bakery', 'Dispatcher'
            , date.getUTCFullYear()
            , zeroPadTwo(date.getUTCMonth() + 1) /* month is zero based */
            , zeroPadTwo(date.getUTCDate())
            , ...targetDirectory.split('/')
        ].join('_');

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
_p.dispatch = function(call, callback) {
    // jshint unused:vars

    this._log.debug('[gRPC:dispatch]');
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
        // where the new branch is pushed to, to make the PR from
        // hmm, we could use the github api to find the clone of
        // the google/fonts repo of the user, but that way all PR-branches
        // end up at different repositories, will be confusing...
        // If we use a single repo, either each user needs write permissions,
        // which is probably best, or we use a single token for all these
        // operations, which is easiest and fastest.
      , remoteRef = new GitHubRef(this._ghPushSetup.repoOwner
                                , this._ghPushSetup.repoName
                                , targetBranchName)
        // must be allowed to push to remoteRef
      , pushOAuthToken = this._ghPushSetup.accessToken
      , prHead = remoteRef.prHead
      , prTarget = this._prTarget
      , report = new DispatchReport()
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
        this._auth.getOAuthToken(sessionIdMessage)
      , this._storage.get(storageKeyMessage)
    ]).then(([oAuthToken, pbFilesMessage])=>{
        // the user will make the PR
        var prOAuthToken = oAuthToken.getAccessToken()
          , userName = oAuthToken.getUserName()
          ;
        return this._getAuthorSignature(userName, prOAuthToken)
        .then(authorSignature=>{
            // schedule the actual work!
            this._log.info('this._queue.schedule _dispatch');
            return this._queue.schedule(
                this._dispatch.bind(this), authorSignature
              , localBranchName, targetDirectory, pbFilesMessage, commitMessage
              , remoteRef, pushOAuthToken, prMessageTitle, prMessageBody
              , prHead, prTarget, prOAuthToken
            );
        });
    })
    .then(result=>{
        // PR URL
        // console.log('PR result:', result) <- has lots! of info
        report.setStatus(DispatchReport.Result.OK);
        report.setPRUrl(result.html_url);
        return report;
    }, error=>{
        this._log.error('In dispatch to:', targetDirectory
                      , 'branch:', targetBranchName
                      , error);
        report.setStatus(DispatchReport.Result.FAIL);
        report.setError('' + error);
        return report;
    })
    .then(report=>this._sendDispatchResult(processCommand, report));
};


_p._sendDispatchResult = function(preparedProcessCommand
                                        , report /* a DispatchReport */) {
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
                      , pbFilesMessage, commitMessage, remoteRef
                      , pushOAuthToken, prMessageTitle, prMessageBody
                      , prHead, prTarget, prOAuthToken) {
    this._log.debug('_dispatch:', targetDirectory);
    return this._fetchUpstreamMaster(true)// -> ref
    .then(reference=>this._branch(localBranchName, reference, true))
    .then(headCommitReference=>this._replaceDirCommit(authorSignature
                            ,localBranchName, headCommitReference
                            , targetDirectory, pbFilesMessage, commitMessage))

    .then(()=>this._push(localBranchName, remoteRef, pushOAuthToken, true))
    .then(()=>this._gitHubPR(prMessageTitle, prMessageBody, prHead
                                            , prTarget, prOAuthToken));
};

_p.serve = function() {
    // Start serving when the database is ready
    // No db yet!

    return this._initRepository()
        .then(()=>this._initUpstream())
        .then(()=>this._fetchUpstreamMaster())
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
    var query = {
            query: USER_EMAIL_QUERY
          , variables: {
                login: userName
            }
        };
    return this._sendGitHubGraphQLRequest(accessToken, query)
    .then(result=> {
        var userPrimaryEmail = result.data.user.email;
        return NodeGit.Signature.now(userName + ' via Font Bakery Dashboard'
                                     , userPrimaryEmail);
    });
};

// from https://gist.github.com/getify/f5b111381413f9d9f4b2571c7d5822ce
function commitChanges(repo, authorSignature, branchName, treeOID
                     , parentCommit, message) {
    return repo.createCommit(
        'refs/heads/' + branchName,
        authorSignature,
        authorSignature,
        message,
        treeOID,
        [parentCommit]
    )
    .then(commit=>{
        return repo.getCommit(commit);
    });
}

function deepInsert(repo, tree, path, items/* [[oid, mode], ...] */) {
    var [dirName, ...pathparts] = typeof path === 'string'
                        ? path.split('/')
                        : path.slice() // defensive copy
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

// push localBranchName -> to graphicore/googleFonts:fontbakery-test_01
_p._push = function(localBranchName, remoteRef, oAuthToken, force) {
    this._log.debug('_push:', remoteRef.remoteName, remoteRef.branchName);
    return gitRemoteGetAdd(this._repo, 'staging', remoteRef.remoteUrl, true)
    .then(remote => {
        var fullLocalRef = 'refs/heads/' + localBranchName
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
                                oAuthToken, "x-oauth-basic")
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
_p._gitHubPR = function(title
                      , body  /* markdown */
                      , head  /* i.e. graphicore:fontbakery-test_01 */
                      , prBase /* new GitHubRef('google', 'fonts', 'master') */
                      , OAuthAccessToken
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
          , body:  body
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

module.exports.GitHubPRServer = GitHubPRServer;

if (typeof require != 'undefined' && require.main==module) {
    var { getSetup } = require('./util/getSetup')
      , repoPath = './fontsgit'
      , setup = getSetup(), gitHubPRServer, port=50051
        // all PRs are based on this branch
      , upstream = new GitHubRef('google', 'fonts', 'master')
        // if not defined falls back to upstream
        // but this is for development, to not disturb
        // the production people
      , prTarget = new GitHubRef('graphicore', 'googleFonts', 'master')
      // FIXME: we could also use the authenticated user to perform the
      // push and in the spirit of the OAuthAPI, we maybe should …
      // This here may well be a temporary setup!
      // Though! this way, we can at least ensure that the access token
      // is authorized to push to the repo.
      , ghPushSetup = {
            repoOwner: 'graphicore',
            repoName: 'googleFonts',
            accessToken: setup.gitHubAPIToken
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

    gitHubPRServer = new GitHubPRServer(setup.logging, port, setup, repoPath
                            , upstream, ghPushSetup, prTarget);
    gitHubPRServer.serve()
        .then(
              ()=>setup.logging.info('Server ready!')
            , error=>{
                setup.logging.error('Can\'t initialize server.', error);
                process.exit(1);
            }
        );
}
