#! /usr/bin/env node
"use strict";
/* jshint esnext:true, node:true */

const grpc = require('grpc')
  , https = require('https')
  , { URL } = require('url')
  , querystring = require('querystring')
  , { AsyncQueue } = require('./util/AsyncQueue')
  , NodeGit = require('nodegit')
    //TODO
  //, { PullRequestService } = require('protocolbuffers/messages_grpc_pb')
  //, { AuthStatus, SessionId, AuthorizedRoles } = require('protocolbuffers/messages_pb')
  //, { Empty } = require('google-protobuf/google/protobuf/empty_pb.js')
  ;

//TODO: proper via setup/injection
const GITHUB_OAUTH_CLIENT_ID = process.env.GITHUB_OAUTH_CLIENT_ID
    , GITHUB_OAUTH_CLIENT_SECRET = process.env.GITHUB_OAUTH_CLIENT_SECRET
    ;

const GITHUB_API_HOST = 'api.github.com'
    , GITHUB_API_GRAPHQL_PATH = '/graphql'
    , GITHUB_HTTPS_GIT_URL = 'https://github.com/{remoteName}.git'
    ;



function GitHubRef(repoOwner, repoName, name) {
    this.repoOwner = repoOwner;
    this.repoName = repoName;
    this.name = name;
    // e.g. "google/fonts"
    this.remoteName = [this.repoOwner, this.repoName].join('/');
    this.remoteUrl = GITHUB_HTTPS_GIT_URL.replace('{remoteName}', this.remoteName);

    Object.freeze(this);
}

const upstreamMaster = new GitHubRef('google', 'fonts', 'master');

/**
 * This Server proivdes the grpc AuthService plus some special GitHub
 * related endpoints.
 *
 * Objectives are:
 *      - User Authentication via GitHub OAuth tokens.
 *      - Session management
 *      - access control/authorization services
 *
 * OAuth2: https://tools.ietf.org/html/rfc6749
 *
 * https://developer.github.com/v3/guides/basics-of-authentication/
 * Flask example: https://gist.github.com/ib-lundgren/6507798
 */
function GitHubPRServer(logging, port, repoPath) {
    this._log = logging;
    this._repoPath = repoPath;
    this._queue = new AsyncQueue();

    // FIXME: inject???
    // this._ghOAuth = {
    //     clientId: GITHUB_OAUTH_CLIENT_ID
    //   , clientSecret: GITHUB_OAUTH_CLIENT_SECRET
    // };
    //
    // this._server = new grpc.Server({
    //     'grpc.max_send_message_length': 80 * 1024 * 1024
    //   , 'grpc.max_receive_message_length': 80 * 1024 * 1024
    // });
    //
    // this._server.addService(PullRequestService, this);
    // this._server.bind('0.0.0.0:' + port, grpc.ServerCredentials.createInsecure());
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
              , 'User-Agent': 'Font Bakery: GitHub OAuth Client'
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

        options_.headers['Content-Length'] = body.length;
    }


    function onResult(resolve, reject, res) {
        //jshint validthis:true
        var data = [ ];
        res.setEncoding('utf8');
        res.on('data', chunk=>data.push(chunk));
        res.on('end', function() {
            try {
                let json = JSON.parse(data.join(''));
                if(res.statusCode !== 200) {
                    let error = Error('('+res.statusCode+') ' + json.message);
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
        var req = https.request(options_, result=>onResult.call(this, resolve, reject, result));
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
    return gitRemoteGetAdd(this._repo, 'upstream', upstreamMaster.remoteUrl);
};

_p._fetchRef = function(remoteName, remoteUrl, referenceName) {
    return this._queue.schedule(() => fetchRef(this._log, this._repo
                                , remoteName, remoteUrl, referenceName));
};


/**
 * $ git fetch upstream master
 *
 * this will run frequently before creating a new branch
 */
_p._fetchUpstreamMaster = function() {
    return this._fetchRef('upstream', upstreamMaster.remoteUrl, upstreamMaster.name); // -> ref
};

_p._branch = function(branchName, reference, force) {
    // https://www.nodegit.org/api/branch/#create

    // name: (String) Branch name, e.g. “master”
    // commit: (Commit, String, Oid) The commit the branch will point to
    // force: (bool) Overwrite branch if it exists
    return getCommitFromReference(reference)
        .then(commit=>this._repo.createBranch(branchName, commit, force));
        // -> branch reference!
};

_p._replaceDirCommit = function(ref, dir, files, commitMessage) {
    // jshint unused:vars
    // clear dir
    // put files into dir
    // commit -m commitMessage
    // return commitRef;
};

_p._push = function() {

};

_p.gitHubPR = function() {

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
        // call.request is a DispatchRequest
    // var dispatchRequest = call.request
    //   , storageKey = dispatchRequest.getStorageKey()
    //   , targetDirectory = dispatchRequest.getTargetDirectory()
    //   // !!! must be unique, maybe create in here using family name and date
    //   , branchName = dispatchRequest.getBranchName()
    //   , prMessage =  dispatchRequest.getPRMessage()
    //   , commitMessage = dispatchRequest.getCommitMessage()
    //   ;

    return this._fetchUpstreamMaster()// -> ref
        .then((ref)=>this._branch(ref))
        .then(()=>this._replaceDirCommit())
        .then(()=>this._push())
        .then(()=>this.gitHubPR())
        .then(()=>{
            // answer with branch URL and PR URL
        });
};

_p.serve = function() {
    // Start serving when the database is ready
    // No db yet!
    return this._initRepository()
        .then(()=>this._initUpstream())
        .then(()=>this._fetchUpstreamMaster())
        //.then(()=>this._server.start())
        ;
};


// from https://gist.github.com/getify/f5b111381413f9d9f4b2571c7d5822ce
function commitChanges(repo, branchName, treeOID, parentCommit, message) {
    console.log('commitChanges treeOID:', treeOID);
    var author = NodeGit.Signature.now("--Me--","--my@email.tld--");
    return repo.createCommit(
        'refs/heads/' + branchName,
        author,
        author,
        message,
        treeOID,
        [parentCommit]
    )
    .then(commit=>{
        console.log('created Commit', commit);
        return repo.getCommit(commit);
    });
}

function deepInsert(repo, tree, path, items/* [[oid, mode], ...] */) {
    var [dirName, ...pathparts] = typeof path === 'string'
                        ? path.split('/')
                        : path.slice() // defensive copy
      , promise
      ;

    console.log('deepInsert has tree', !!tree, '| >>>>', dirName, '<<<< pathparts:', pathparts);

    if(dirName) {
        var treeEntry = null;
        try {
            treeEntry = tree.entryByName(dirName);
        }
        // tree._entryByName(dirName) should return null if not found but seems broken
        catch(error){/*not found: pass*/}

        console.log('treeEntry for dirName:', dirName, 'is Directory', treeEntry && treeEntry.isDirectory());

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
        return treebuilder.write();// -> promise new tree oid
    });
}

function insertOrReplaceDir(repo, tree, path, items) {
    var pathParts = path.split('/')
      , target = pathParts.pop()
      ;

    return NodeGit.Treebuilder.create(repo, null)
    .then(treebuilder=>{
        for(let item of items)
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


_p.devMain = function(){
    this._log.info('======> dev main running!');

    var branchName = 'myDevTestingBranch';

    return this._fetchUpstreamMaster()// -> ref
    .then(reference=>this._branch(branchName, reference, true))
    .then(reference=>{
        // demonstrating how to use "nodegit" to modify and read from a local bare git repo
        // https://gist.github.com/getify/f5b111381413f9d9f4b2571c7d5822ce
        //
        // nodegit/test/tests/treebuilder.js
        // https://github.com/nodegit/nodegit/blob/8306c939888954cc447adeb3a834952125085c35/test/tests/treebuilder.js
        //
        // commit example
        // https://gist.github.com/yofreke/9379d1156fe6f5f0be73

        // _replaceDir
        //
        // ok so, for dev I'm going to replace the dir /tools/encodings
        // with a dir that contains just one or two bullshit files
        // using that dir, so I'm sure I can also delete sub-dirs ...

        getCommitResources(reference)
        .then(({reference, commit, commitTree})=>{
            var repo = reference.owner()
              , fileData = [
                    ['greetingsA.txt', Buffer.from('Hello World')]
                  , ['greetingsB.txt', Buffer.from('Hello Universe')]
                ]
              ;

             return Promise.all(fileData.map(([filename, buffer])=>{
                return NodeGit.Blob.createFromBuffer(repo, buffer, buffer.length)
                    .then(oid=>[filename, oid, NodeGit.TreeEntry.FILEMODE.BLOB]);
                }
            )) // ->files
            .then(entries=>insertOrReplaceDir(repo, commitTree, 'tools/encodings', entries))// -> oid
            .then(newTreeOID=>commitChanges(repo
                                          , branchName
                                          , newTreeOID
                                          , commit// HEAD
                                          , "Adding/updating files test"))
            ;

        })
        .then(commit=>{
            dumpCommitContents(commit);
            var stagingRef = new GitHubRef('graphicore', 'googleFonts', 'fontbakery-test_01');
            gitRemoteGetAdd(this._repo, 'staging', stagingRef.remoteUrl, true)
            .then(remote => {
                const GITHUB_API_TOKEN='';
                var localRef = 'refs/heads/' + branchName
                  , remoteRef = 'refs/heads/' + stagingRef.name
                  , refSpec = localRef + ':' + remoteRef
                  , options = {
                        callbacks: {
                            // Seems for mac there's is a problem where
                            // libgit2 is unable to look up GitHub certificates
                            // correctly, this is a bypass but not needed on Linux.
                            // certificateCheck: ()=>1,
                            credentials: ()=>NodeGit.Cred.userpassPlaintextNew(
                                        GITHUB_API_TOKEN, "x-oauth-basic")
                        }
                    }
                  ;
                console.log('remote.push', refSpec);
                return remote.push([refSpec], options);
            });
        })
        .then(null, err=>console.error(err))
        ;
        // commit -> to graphicore/googleFonts:myDevTestingBranch
    })
    ;
};


function getContents(entry) {
    if(new Set(['ofl','apache', 'ufl']).has(entry.name()))
        return Promise.resolve(['SKIP: ' +  entry.name()]);
    if (entry.isFile())
        return Promise.resolve(['FILE: ' +  entry.name()]);

    if (!entry.isDirectory())
        return Promise.resolve(['WTF: '+  entry.name()]);

    return entry.getTree()
                 .then(tree=>Promise.all(tree.entries().map(getContents)))
                 .then(results=>results.reduce((r, lines)=>{r.push(...lines); return r;}, []))
                 .then(lines=>[
                    'DIRECTORY: ' +  entry.name()
                    , ...lines.map(line=>'  ' + line)
                 ])
                 .then(null, err=>console.error(err));
}

function dumpCommitContents(commit) {
    console.log('dumpCommitContents', commit);

    commit.getTree().then(tree=> {
        var treeEntries = tree.entries();
        treeEntries.map(entry=>getContents(entry)
               .then(lines=>console.log(lines.join('\n'))));
    });
}





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
      , repoPath = '/tmp/fontsgit'
      , setup = getSetup(), gitHubPRServer, port=50051;

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
    gitHubPRServer = new GitHubPRServer(setup.logging, port, repoPath);
    gitHubPRServer.serve()
        .then(()=>gitHubPRServer.devMain())
        .then(
              ()=>setup.logging.info('Server ready!')
            , error=>{
                setup.logging.error('Can\'t initialize server.', error);
                process.exit(1);
            }
        );
}
