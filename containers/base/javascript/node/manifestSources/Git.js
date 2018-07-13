#! /usr/bin/env node
"use strict";
// this is expected to run in nodejs
/* global require, module */
/* jshint esnext:true */

const { _Source: Parent } = require('./_Source')
    , { ManifestServer } = require('../util/ManifestServer')
    , { getSetup } = require('../util/getSetup')
    , { parseMetadata } = require('../util/getMetadataPb')
    , NodeGit = require('nodegit')
    , https = require('https')
    ;

const GITHUB_HTTPS_GIT_URL = 'https://github.com/{remoteName}.git'
    , GITHUB_API_HOST = 'api.github.com'
    , GITHUB_API_PATH = '/graphql'
    ;

const GitShared = (function() {

/**
 * the sources are different implementations, but both run on the
 * same ManifestServer, because they share the google/fonts repository.
 * Thus, many git objects will be shared between both, which will make
 * us inherit a lot of gits own optimizations.
 *
 * The two sources should get initialized serially, the first one
 * (whichever it is) will load the  google/fonts:master tree
 * the second one will only see see that it is already loaded (for the
 * sake of simplicity probably even call git fetch, but without any download
 * action following).
 */

function GitShared(logging, id, familyWhitelist, reportsSetup) {
    this._familyWhitelist = familyWhitelist;
    Parent.call(this, logging, id, reportsSetup);
}

var _p = GitShared.prototype = Object.create(Parent.prototype);

_p._initRepo = function(repoPath) {
    // doesn't fail if the repository exists already
    // returns the repository
    var isBare = 1; // == true but must be a number
    return NodeGit.Repository.init(repoPath, isBare);
};

// remoteName = resourcePath.slice(1)
// remoteName = "google/fonts"
// remoteUrl = "https://github.com/google/fonts.git"
// referenceName = "master"
//
// remoteName = "m4rc1e/fonts"
// remoteUrl = "https://github.com/m4rc1e/fonts.git"
// referenceName = "pacifico"
/**
 * remoteName: a git repository name that makes sense in the source context
 *
 * remoteUrl: Use https for now, it is easier because it doesn't need ssh credentials!
 *
 * allowUpdateUrl: is only interesting in cases where the combination
 * of remoteName and remoteUrl can change. That is not always the case.
 * One case is our CSVSpreadsheet source, where remoteUrls are configured
 * externally. Within this module, the GitHub based sources don't have
 * changing remoteUrls for remoteNames.
 */
_p._getRemote = function(remoteName, remoteUrl, allowUpdateUrl) {
    // jshint unused:vars
    throw new Error('Not Implemented: GitShared.prototype._getRemote');
};

_p._getRef = function(repo, remoteName, referenceName) {
    // use _fetchRef to also update the ref
    var fullReferenceName = [remoteName, referenceName].join('/'); // m4rc1e/fonts/pacifico ???
    return repo.getReference(fullReferenceName);
};

_p.__fetchRef = function(remoteName, remoteUrl, referenceName) {
    return this._getRemote(remoteName, remoteUrl, true)
        .then(remote => {
           this._log.info(this.id + ': Started fetching remote "'
                                + remoteName + ':' + referenceName + '"');
            // this may take a while!
            // E.g. initially fetching google/fonts:master
            // also, it kind of fails silently if there's no referenceName
            // at remote. Thus, later is checked if we can get the actual
            // reference from the repo.
           return remote.fetch(referenceName).then(()=>remote);
        })
        .then((remote) => this._getRef(remote.owner() /* = repository */
                                     , remoteName, referenceName))
        .then(ref => {
            // this does not mean the remote reference exists now
            this._log.info(this.id + ': Finished fetching remote "'
                                + remoteName + ':' + referenceName + '"', ref.target());
            return ref;
        }, err => {
            if(err.errno === NodeGit.Error.CODE.ENOTFOUND)
            // message: no reference found for shorthand '{fullReferenceName}'
            // errno: -3
            // at the moment E.g.: ERROR upstream: FAILED: Fetching remote "upstream/Rakkas:master"
            // … for shorthand 'upstream/Rakkas/master'
            // And indeed, there's only a `gh-pages` branch (which is the default as well)
                this._log.error(this.id + ': FAILED: Fetching remote (branch) '
                                + '"' + remoteName + ':' + referenceName + '" '
                                + 'at url: ' + remoteUrl);
            throw err;
        });
};

_p._fetchRef = function(remoteName, remoteUrl, referenceName) {
    return this._queue('git.lock'
                    , () => this.__fetchRef(remoteName, remoteUrl, referenceName));
};

// this is a *good to know how* interface, we don't actually use it
// but it is good for debugging
_p._getOidType = function(repo, oid) {
    // returns http://www.nodegit.org/api/object/#TYPE
    // NodeGit.Object.TYPE.ANY       -2
    // NodeGit.Object.TYPE.BAD       -1
    // NodeGit.Object.TYPE.EXT1       0
    // NodeGit.Object.TYPE.COMMIT     1
    // NodeGit.Object.TYPE.TREE       2
    // NodeGit.Object.TYPE.BLOB       3
    // NodeGit.Object.TYPE.TAG        4
    // NodeGit.Object.TYPE.EXT2       5
    // NodeGit.Object.TYPE.OFS_DELTA  6
    // NodeGit.Object.TYPE.REF_DELTA  7
    return repo.odb()
        .then(odb=>odb.read(oid))
        .then(odbObject => odbObject.type())
        ;
};

_p._getReferencedType = function(reference) {
    return this._getOidType(reference.owner(), reference.target());
};

_p._getCommit = function(repo, commitOid) {
    return NodeGit.Commit.lookup(repo, commitOid)
        .then(null, err => {
            // if reference target is something else
            // message the requested type does not match the type in ODB
            // errno: -3 }
            this._log.error(err);
            throw err;
        });
};

const _FAMILY_WEIGHT_REGEX = /([^/-]+)-(\w+)\.ttf$/;
_p._familyNameFromFilename = function (filename) {
  /**
   * Ported partially from Python gftools.util.google_fonts.FileFamilyStyleWeight
   * https://github.com/googlefonts/tools/blob/master/Lib/gftools/util/google_fonts.py#L449
   *
   * If style and weight is needed it's worth porting the whole function.
   *
   * > familyNameFromFilename('LibreBarcode39ExtendedText-Regular.ttf')
   * 'Libre Barcode 39 Extended Text'
   */

  var m = filename.match(_FAMILY_WEIGHT_REGEX), name;
  if(!m) {
    name = filename.slice(0,-4);// remove .ttf;
    this._log.info('Cannot not parse ' + filename
                                    + ' (usually because it misses a '
                                    + '"-{WeightStyle}" part) '
                                    + 'using: ' + name);
  }
  else
    name = m[1];
  return familyName(name);
};

function familyName(fontname) {
  /**
   * Ported from Python gftools.util.google_fonts.FamilyName
   * https://github.com/googlefonts/tools/blob/master/Lib/gftools/util/google_fonts.py#L417
   *
   * Attempts to build family name from font name.
   * For example, HPSimplifiedSans => HP Simplified Sans.
   * Args:
   *   fontname: The name of a font.
   * Returns:
   *   The name of the family that should be in this font.
   */
  // SomethingUpper => Something Upper
  fontname = fontname.replace(/(.)([A-Z][a-z]+)/g, '$1 $2');
  // Font3 => Font 3
  fontname = fontname.replace(/([a-z])([0-9]+)/g, '$1 $2');
  // lookHere => look Here
  return fontname.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
}

_p._familyNameFromFilesData = function(path, filesData) {
    let fileNames = filesData.map(([fileName, ])=>fileName)
      , sufixes = new Set(['otf', 'ttf'])
      , metadataIndex = fileNames.indexOf('METADATA.pb')
      ;

    // use family name from METADATA.pb
    if(metadataIndex !== -1 ) {
        let metadataBlob = new Buffer(filesData[metadataIndex][1] /* = Uint8Array */);
        return parseMetadata(metadataBlob)
        .then(familyProto=>{
            let familyName = familyProto.getName();
            if(!familyName)
                throw new Error('Can\'t read familyName from METADATA.pb');
            this._log.debug(this.id + ':', 'took familyName from METADATA.pb: ', familyName);
            return familyName;
        });
    }
    // try to generate a family name from the first font file name
    // though, this should not happen in most cases anymore.
    for(let fileName of fileNames) {
        let suffix = fileName.indexOf('.') > 0
                ? fileName.split('.').pop().toLowerCase()
                : null
            ;
        if(sufixes.has(suffix)) {
            // Hmmm, not all file names are normalized/canonical!
            // see: https://github.com/googlefonts/fontbakery-dashboard/issues/73
            let familyName = this._familyNameFromFilename(fileName);
            this._log.debug(this.id + ':', 'took familyName from fileName '
                            + '"' + fileName+'": ', familyName);
            return Promise.resolve(familyName);
        }
    }
    throw new Error('Can\'t determine family name from files in '
                                + 'directory "' + path + '" files: '
                                + fileNames.join(', ') + '.');
};

_p._treeEntryToFileData = function(treeEntry) {
    return treeEntry.getBlob()
            .then(blob => new Uint8Array(blob.content()))
            .then(data => [treeEntry.name(), data])
            ;
};

_p._treeToFilesData = function (tree, filterFunction/*optional: filterFunction(string:filename)*/) {
    let fileEntries = tree.entries()// -> [treeEntry]
                          .filter(te=>te.isFile())
                          .filter(te=>filterFunction
                                            ? filterFunction(te.name())
                                            // if there's no filterFunction
                                            // this doesn't filter at all
                                            : true)
                          .map(treeEntry=>this._treeEntryToFileData(treeEntry));
    return Promise.all(fileEntries);
};

/**
 * for `this._log.debug` expects:
 *      metadata.repository
 *      metadata.branch
 *
 * asFamilyName: optional; string; otherwise trying to use _familyNameFromFilesData
 *               Some sources have "naturally" bad font file names that are
 *               not good enough to determine the family name from it. At
 *               least initially until it is fixed. But that is enough to
 *               put the check report into an odd/wrong row of the dashboard
 *               thus, using an explicit FamilyName can be much more robust
 *               here. See e.g. CSVSpreadsheet/upstream
 */
_p._dispatchTree = function(tree, metadata
            , asFamilyName/*optional: string*/
            , filterFunction/*optional: filterFunction(string:filename)*/) {

    return this._treeToFilesData(tree, filterFunction)
                .then(filesData=>this._dispatchFilesData(filesData, metadata
                                                , tree.path(), asFamilyName));
};

_p._dispatchFilesData = function(filesData, metadata, path, asFamilyName/*optional: string*/) {
    return (asFamilyName
                    ? Promise.resolve(asFamilyName)
                    // raises/rejects if it can't find a family name
                    : this._familyNameFromFilesData(path, filesData)
    ).then(familyName=> {
        if(this._familyWhitelist && !this._familyWhitelist.has(familyName))
            return null;
        this._log.debug(this.id+':', 'dispatching family', familyName
                    , 'of', metadata.repository + ':' + metadata.branch);
        return this._dispatchFamily(familyName, filesData, metadata);
    });
};


return GitShared;
})();

exports.GitShared = GitShared;


const GitBase = (function() {
const Parent = GitShared;
function GitBase(logging, id, repoPath, baseReference, familyWhitelist
                                                        , reportsSetup) {
    this._repo = null;
    this._repoPath = repoPath;
    this._initPromise = null;

    this._licenseDirs = new Set(['apache', 'ofl', 'ufl']);

    this._baseRef = {
        repoOwner: baseReference.repoOwner
      , repoName: baseReference.repoName
        // e.g. "google/fonts"
      , remoteName: [baseReference.repoOwner, baseReference.repoName].join('/')
      , name: baseReference.name
    };
    Parent.call(this, logging, id, familyWhitelist, reportsSetup);
}

var _p = GitBase.prototype = Object.create(Parent.prototype);

_p.init = function() {
    if(!this._initPromise)
        this._initPromise = Promise.resolve(Parent.prototype.init.call(this))
            .then(()=>this._initRepo(this._repoPath))
            .then(
                repo => {
                    this._repo = repo;
                    return null;
                }
              , err => {
                    this._log.error('Can\'t init git reporsitory: ', err);
                    throw err;
                }
            );
    return this._initPromise;
};

_p._getRemoteUrl = function(remoteName) {
    return GITHUB_HTTPS_GIT_URL.replace('{remoteName}', remoteName);
};

/**
 * Note: this doesn't do network requests yet. Thus, at this point we won't
 * get an error if remoteUrl is problematic.
 */
_p._getRemote = function(remoteName, remoteUrl, allowUpdateUrl) {
    return NodeGit.Remote.create(this._repo, remoteName, remoteUrl).then(null, err => {
        if(err.errno !== NodeGit.Error.CODE.EEXISTS)
            throw err;
        // => err.errno === NodeGit.Error.CODE.EEXISTS
        // NOTE: the remote returned by Repository.getRemote has
        // a reference to the repository:
        // remote.repo, while the remote created using NodeGit.Remote.create
        // doesn't have that reference.
        // in both cases remote.owner() returns a repository, but these
        // are not the same instance as this._repo;
        return this._repo.getRemote(remoteName).then(remote => {
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
            let result = remote.setUrl(this._repo, remoteName, remoteUrl);
            if(result !== 0)
                throw new Error('`remote.setUrl` failed with error '
                    + 'value "'+result+'" trying to set  remoteName: "'
                    + remoteName + '"; remoteUrl: "' + remoteUrl + '".');
            return remote;
        });
    });
};

_p.fetchBaseRef = function() {
    var remoteUrl = this._getRemoteUrl(this._baseRef.remoteName);
    return this._fetchRef(this._baseRef.remoteName, remoteUrl, this._baseRef.name);
};

// returns a list of family directories that differ

function _getChildDirPaths(tree) {
    // returns the full path of direct child directories
    // ['ofl/abeezee', 'ofl/abel','ofl/abhayalibre', ... ]
    return tree.entries()
        .filter(treeEntry => treeEntry.type() === NodeGit.Object.TYPE.TREE)
        .map(entry=>entry.path())
        ;
}

function _arrayFlatten(arrayOfArrays) {
    const reducer = (flat, item) => {
        flat.push(...item);
        return flat;
    };
    return arrayOfArrays.reduce(reducer, []);
}

_p._getRootTreeFamilies = function(tree) {
    let treeFamiliesPromises = [];
    for(let licensDir of this._licenseDirs) {
        // the underscore version returns Null if entry is not found
        // it's in the official api docs. But we can't use it further.
        // tree.entryByName(licensDir) would throw however.
        if(!tree._entryByName(licensDir))
            // not found
            continue;
        let treeEntry = tree.entryByName(licensDir);
        treeFamiliesPromises.push(treeEntry.getTree().then(_getChildDirPaths));
    }
    return Promise.all(treeFamiliesPromises).then(_arrayFlatten);
};

_p._dirsToCheckFromDiff = function (newTree, changedNamesDiff ) {
    let fileNames = changedNamesDiff.split('\n')
      , seen = new Set()
      , dirsToCheck = []
      ;
    for(let fileName of fileNames) {
        if(!fileName.length)
            // last line is empty, only case afaik
            continue;
        let parts = fileName.split('/');
        if(!this._licenseDirs.has(parts[0]) || parts.length < 2)
            continue;
        // 3 parts is the usual, e.g: ['ofl', 'abbeezee', 'Abeezee-Regular.ttf']
        let familyDir = parts.slice(0, 2).join('/');
        if(seen.has(familyDir))
            continue;
        seen.add(familyDir);
        // this is the last filter to see if familyDir is actually
        // in newTree. Afaik, changedNamesDiff also contains removed
        // names. This should be very solid.
        dirsToCheck.push(newTree.getEntry(familyDir)
                                // err is if family dir is not found
                                // which is OK at this point (see above)
                                .then(treeEntry=>treeEntry.path(), () => null));
    }
    return Promise.all(dirsToCheck)
            //some are null, if they have been removed in newTree
            .then(dirs => dirs.filter(entry =>!!entry))
            ;
};

_p._dirsToCheck = function(oldTree, newTree) {
    let diffOptions = new NodeGit.DiffOptions();
    return NodeGit.Diff.treeToTree(this._repo, oldTree, newTree, diffOptions)
        .then(diff => diff.toBuf(NodeGit.Diff.FORMAT.NAME_ONLY))
        // changedNamesDiff is a string not a buffer
        // if that ever changes:
        //       dirsToCheck(newTree, changedNamesDiff.toString())
        .then(changedNamesDiff => this._dirsToCheckFromDiff(newTree, changedNamesDiff))
        ;
};

return GitBase;
})();

const GitBranch = (function() {

// google/fonts:master -> monitored branch
//            -> checks differences between last check and current
//              `if families in the branch changed`
//            -> to check if there was an actual change, we
//               keep the last checked tree-id for each font family directory
// uses one old_tree and a "list" of one "new_trees"
// "old_tree" => tree of last checked commit.
//               if no old_tree is available, we check
//               the full collection, i.e. the tree of the current commit.
// "new_tree" => current google/fonts/master
function GitBranch(logging, id, repoPath, baseReference, familyWhitelist
                                                        , reportsSetup) {
    GitBase.call(this, logging, id, repoPath, baseReference, familyWhitelist
                                                        , reportsSetup);
    this._oldCommit = null;
}

var _p = GitBranch.prototype = Object.create(GitBase.prototype);

/**
 * don't fetch files in subdirectories, we want a flat dir here
 * besides, at the moment, fontbakery-worker rejects sub directories
 */
_p._update = function(currentCommit) {
    let currentCommitTreePromise = currentCommit.getTree()
      , dirsPromise = this._oldCommit
            // based on diff
            ? Promise.all([this._oldCommit.getTree(), currentCommitTreePromise])
                     .then(([oldTree, newTree]) => this._dirsToCheck(oldTree, newTree))
            // all families
            : currentCommitTreePromise.then(tree => this._getRootTreeFamilies(tree))
      ;
    this._oldCommit = currentCommit;

    Promise.all([currentCommitTreePromise, dirsPromise])
    .then(([currentCommitTree, dirs]) => {
        return Promise.all(dirs.map(dir=>currentCommitTree.getEntry(dir)));
    })
    .then(treeEntries => {
        // some will resolve to null if there's a hit in this._familyWhitelist
        // though, at this point, error reporting may be the only thing left to
        // do.

        return this._waitForAll(treeEntries.map(treeEntry => {
            let metadata = {
                commit: currentCommit.sha()
              , commitDate: currentCommit.date()
              , familyTree: treeEntry.sha()
              , familyPath: treeEntry.path()
              , repository: this._baseRef.remoteName
              , branch: this._baseRef.name
            };
            return treeEntry.getTree()
                            .then(tree=>this._dispatchTree(tree, metadata));
        }));
    });
};

// Runs immediately on init. Then it's called via the poke interface.
// There's no scheduling in the ManifestSource itself.
_p.update = function() {
    // update the baseRef => can take really long the first time
    return this.fetchBaseRef()
        .then(reference => this._getCommit(reference.owner(), reference.target()))
        .then(currentCommit => this._update(currentCommit))
        ;
};

return GitBranch;
})();

const GitBranchGithubPRs = (function() {

//     google/fonts:master/pull-requests -> via github api!
//              -> fetches PRs from github for the monitored branch
//              -> so this is ONLY PRs to master (===baseRefName)
//              -> and also uses only the latest commit that is
//                           adressed to master.
//             uses one "old_tree" and many "new_trees"
//             old_tree => current google/fonts/master (baseRefName)


function GitBranchGithubPRs(logging, id, repoPath, baseReference
                        , gitHubAPIToken, familyWhitelist, reportsSetup) {
    GitBase.call(this, logging, id, repoPath, baseReference
                                        , familyWhitelist, reportsSetup);

    this._gitHubAPIToken = gitHubAPIToken;
}


var _p = GitBranchGithubPRs.prototype = Object.create(GitBase.prototype);

const QUERY = `
query($repoOwner: String!, $repoName: String!, $baseRefName: String, $cursor: String )
{
  repository(owner: $repoOwner, name: $repoName) {
    nameWithOwner
    homepageUrl
    pullRequests(
          first: 45, states: OPEN
        , baseRefName: $baseRefName
        , after: $cursor
        , orderBy: {field: CREATED_AT, direction: DESC}
    ) {
      totalCount
      pageInfo {
        endCursor
      }
      nodes {
        headRef {
          target {
            oid
          }
        }
        id
        url
        createdAt
        updatedAt
        baseRefName
        resourcePath
        title
        mergeable
        headRefName
        headRepository {
          nameWithOwner
        }
      }
    }
  }
}`;

_p._makeGrapQlQueryBody = function(cursor) {
    return JSON.stringify({
        query: QUERY
      , variables: {
              repoOwner: this._baseRef.repoOwner
            , repoName: this._baseRef.repoName
            , baseRefName: this._baseRef.name // only fetch PRs to baseRefName
              // when in the response endCursor === null all items have been fetched!
              // when here cursor === null: fetches the beginning of the list
            , cursor:  cursor || null // data.repository.pullRequests.pageInfo.endCursor
        }
    });
};

_p._sendRequest = function(cursor) {
    var body = this._makeGrapQlQueryBody(cursor)
      , options = {
            hostname: GITHUB_API_HOST
          , path: GITHUB_API_PATH
          , method: 'POST'
          , port: 443
          , headers: {
                'Content-Type': 'application/json'
              , 'Content-Length': body.length
              , Authorization: 'bearer ' + this._gitHubAPIToken
              , 'User-Agent': 'Font Bakery: GitHub GraphQL Client'
           }
        }
      ;

    function onResult(resolve, reject, res) {
        var data = [ ];
        res.setEncoding('utf8');
        res.on('data', function(chunk) {
            data.push(chunk);
        });
        res.on('end', function() {
            try {
                let json = JSON.parse(data.join(''));
                if(res.statusCode !== 200) {
                    let error = Error('('+res.statusCode+') ' + json.message);
                    error.code = res.statusCode;
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

    return new Promise(function(resolve, reject) {
        var req = https.request(options, onResult.bind(null, resolve, reject));
        req.on('error', reject);
        req.write(body);
        req.end();
    });
};

_p._queryPullRequestsData = function() {
    var prs = null
      , recursiveFetch = data_ => {
        var data = data_.data
          , pullRequests = data.repository.pullRequests
          , cursor = data.repository.pullRequests.pageInfo.endCursor
          ;
        if(prs === null)
            prs = [];
        // filter because a node happened to be null at some point
        prs.push(...pullRequests.nodes.filter(node=>!!node));

        if(cursor !== null)
            return this._sendRequest(cursor).then(recursiveFetch);
        else {
            if(prs.length !== data.repository.pullRequests.totalCount)
                // This assertion should hold because it is documented
                // in the API, but it is no hard reason to fail.
                this._log.warning('Assertion failed: expected totalCount ('
                                + data.repository.pullRequests.totalCount+') '
                                + 'PullRequest items, but got ' + prs.length);
            return prs;// next step
        }
    };
    return this._sendRequest(null).then(recursiveFetch);
};


_p._getCommitResources = function(repo, commitOid) {
    var result = {
        commit: null
      , commitTree: null
    };

    return this._getCommit(repo, commitOid)
        .then(commit => {
            result.commit = commit;
            return commit.getTree();
        })
        .then(commitTree => {
            result.commitTree = commitTree;
        })
        .then(() => result)
        ;
};

_p._getReferenceResources = function(reference) {
    return this._getCommitResources(reference.owner(), reference.target())
        .then(result => {
            result.reference = reference;
            return result;
        });
};

// This is to not fetch if we already have the reference
// note that oid here and a freshly fetched oid can still differ
// due to race conditions. But the freshly fetched oid likely is
// more up to date then. This is OK for GitHub PRs which always
// point to the latest references of referenceName, so we get at
// least oid or something more up to date.
_p._getOrfetchRef = function(remoteName, referenceName, oid) {
    return this._getRef(this._repo, remoteName, referenceName)
        .then(ref => {
            let targetOid = ref.target().toString();
            if(targetOid === oid) {
                // the existing reference is sufficient
                this._log.debug(remoteName + ':' + referenceName
                            , 'pointing at ', oid, 'is already fetched.');
                return ref;
            }
            let message = 'Found reference but has an insufficient '
                        + 'OID: ' + targetOid
                        + ' expected: ' + oid
              , error = new Error(message)
              ;
            // the error handler will _fetchRef with this error code
            error.errno = NodeGit.Error.CODE.ENOTFOUND;
            throw error;
        })
        .then(null, err => {
            if(err.errno === NodeGit.Error.CODE.ENOTFOUND) {
                var remoteUrl = this._getRemoteUrl(remoteName);
                return this._fetchRef(remoteName, remoteUrl, referenceName);
            }
            throw err;
        });
};

/**
 * prData = [{
 *     "id": "MDExOlB1bGxSZXF1ZXN0MTU3MjIyNTc3",
 *     "url": "https://github.com/google/fonts/pull/1385",
 *     "createdAt": "2017-12-08T11:34:02Z",
 *     "updatedAt": "2017-12-08T12:24:06Z",
 *     "baseRefName": "master",
 *     "resourcePath": "/google/fonts/pull/1385",
 *     "title": "nunito: v3.500 added",
 *     "mergeable": "MERGEABLE",
 *     "headRefName": "nunito",
 *     "headRepository": {
 *         "nameWithOwner": "m4rc1e/fonts"
 * }]
 */
_p._fetchPullRequests = function(prsData) {
    this._log.debug('Fetching Pull Requests:', prsData.length);
    return Promise.all(prsData.map(prData => {
        // no fetch needed if:
        // prData.headRef.target.oid === reference.target().sha()
        return this._getOrfetchRef(
            prData.headRepository.nameWithOwner
          , prData.headRefName
          , prData.headRef.target.oid
        )
        .then(reference => this._getReferenceResources(reference))
        .then(referenceResources => ({
            data: prData
          , reference: referenceResources.reference
          , commit: referenceResources.commit
          , commitTree: referenceResources.commitTree
        }));
    }));
};

_p._filterPullRequests = function(prsData) {
    let reasons = {}
      , filtered = prsData.filter(prData => {
        let reason = null;
        if(prData.mergeable !== 'MERGEABLE')
            reason = prData.mergeable;
        else if(!prData.headRepository){
            // FIXME: is there a way to fetch these PR's without
            // having access to the headRepository?
            // real world example
            // {
            //    headRef: null,
            //    id: 'MDExOlB1bGxSZXF1ZXN0MTU1MTEzNjQ5',
            //    url: 'https://github.com/google/fonts/pull/1358',
            //    createdAt: '2017-11-28T16:07:22Z',
            //    updatedAt: '2017-11-28T16:07:22Z',
            //    baseRefName: 'master',
            //    resourcePath: '/google/fonts/pull/1358',
            //    title: 'Correct spelling of "emoji"',
            //    mergeable: 'MERGEABLE',
            //    headRefName: 'patch-1',
            //    headRepository: null
            //}
            reason = 'unkown reporsitory';
        }
        if(reason) {
            if(!(reason in reasons))
                reasons[reason] = [];
            reasons[reason].push(prData);
            return false;
        }
        return true;
    });

    if(filtered.length) {
        this._log.info('Filtered' , prsData.length - filtered.length
                                        , 'PRs of',  prsData.length);
        let dgb = ['Filtered', '…'];
        for(let reason in reasons) {
            dgb.push(reason + ':');
            Array.prototype.push.apply(dgb, reasons[reason]
                 .map(prData => { return prData.title + ' ' + prData.url
                                 + ' ' + prData.headRefName;}));
        }
        this._log.debug(dgb.join(' '));
    }

    return filtered;
};

_p._getPullRequests = function() {
    return this._queryPullRequestsData()
        .then(this._filterPullRequests.bind(this))
        .then(this._fetchPullRequests.bind(this));
};

_p._getBaseResources = function() {
    return this.fetchBaseRef()
               .then(reference => this._getReferenceResources(reference));
};

// see _fetchPullRequests for pr data format
// prsData => [{data: prData, reference: reference, commit: commit, commitTree:commitTree}]
_p._getPRchangedFamilies = function([baseData, prsData]) {
    return Promise.all(prsData.map(prData => {
        var newTree = prData.commitTree
          ;
                // oid = the commit OID of a merge base between 'one' and 'two'
        return NodeGit.Merge.base(this._repo, baseData.commit.id(), prData.commit.id())
        .then(this._getCommitResources.bind(this, this._repo))
        .then(baseCommitData => {
            let oldTree = baseCommitData.commitTree;

            return this._dirsToCheck(oldTree, newTree)
                .then(changedFamilies => {
                    prData.changedFamilies = changedFamilies;
                    return prData;
                });
        });
    }))
    .then(prsData => {
        let checkFamilies = new Map();
        // only do the "latest" commit for each family.
        // prsData is still ordered by {field: CREATED_AT, direction: DESC}
        // from the original github graphQL query.
        for(let i=0,l=prsData.length;i<l;i++) {
            let prData = prsData[i]
              , changedFamilies = prData.changedFamilies
              ;
            for(let j=0,ll=changedFamilies.length;j<ll;j++) {
                let family = changedFamilies[j];
                if(checkFamilies.has(family)) {
                    this._log.debug('Skip family ' + family + ' of ' + prsData[i].data.url);
                    continue;
                }
                this._log.debug('Checking family ' + family + ' of ' + prsData[i].data.url);
                checkFamilies.set(family, prsData[i]);
            }
        }
        return checkFamilies;
    });
};

_p._update = function(checkFamilies) {
    // some will resolve to null if there's a hit in this._familyWhitelist
    // though, at this point, error reporting may be the only thing left to do.
    var promises = [];
    checkFamilies.forEach((prData, dir) => {
        var promise = prData.commitTree.getEntry(dir).then(treeEntry => {
            let metadata = {
                    commit: prData.commit.sha()
                  , commitDate: prData.commit.date()
                  , familyTree: treeEntry.sha()
                  , familyPath: treeEntry.path()
                  , repository: prData.data.headRepository.nameWithOwner
                  , branch: prData.data.headRefName
                  , prUrl: prData.data.url
                  , prTitle: prData.data.title
            };
            return treeEntry.getTree()
                            .then(tree=>this._dispatchTree(tree, metadata));
        });
        promises.push(promise);
    });
    return this._waitForAll(promises);
};

/**
 * check all the diffs and collect affected font families.
 * if a font family is affected by many PRs, the youngest PR is chosen
 * i.e. skip families that have been looked at before in this run
 * mark the font-family version for the next run, could use all file-object
 * ids, as that won't even change between rebasing. still, it is probably
 * to just use the HEAD commit as mark.
 */
_p.update = function() {
    // update the baseRef => can take really long the first time
    return Promise.all([
            this._getBaseResources()
          , this._getPullRequests()
        ])
       .then(this._getPRchangedFamilies.bind(this))
       .then(checkFamilies => this._update(checkFamilies))
       ;
};

return GitBranchGithubPRs;
})();


if (typeof require != 'undefined' && require.main==module) {

    var setup = getSetup(), sources = [], server
       , familyWhitelist = setup.develFamilyWhitelist
       , repoPath = './var/fontsgit'
       , familyWhitelist = null
       , grpcPort=50051
       ;

    for(let i=0,l=process.argv.length;i<l;i++) {
        if(process.argv[i] === '-p' && i+1<l) {
            let foundPort = parseInt(process.argv[i+1], 10);
            if(foundPort >= 0) // not NaN or negative
                grpcPort = foundPort;
            break;
        }
    }

    if(!process.env.GITHUB_API_TOKEN)
        // see: Using Secrets as Environment Variables
        // in:  https://kubernetes.io/docs/concepts/configuration/secret/#using-secrets-as-environment-variables
        // and: https://kubernetes.io/docs/tasks/inject-data-application/distribute-credentials-secure
        // $ kubectl -n $NAMESPACE create secret generic external-resources --from-literal=github-api-token=$GITHUB_API_TOKEN
        throw new Error('MISSING: process.env.GITHUB_API_TOKEN');

    setup.logging.log('Loglevel', setup.logging.loglevel);
    if(familyWhitelist)
        setup.logging.debug('FAMILY_WHITELIST:', familyWhitelist);

    var baseReference = {
            repoOwner: 'google'
          , repoName: 'fonts'
          , name: 'master'
    };

    sources.push(new GitBranch(
            setup.logging, 'master', repoPath, baseReference, familyWhitelist
    ));
    sources.push(new GitBranchGithubPRs(
            setup.logging, 'pulls', repoPath, baseReference
          , process.env.GITHUB_API_TOKEN, familyWhitelist
    ));

    setup.logging.info('Starting manifest server');
    server = new ManifestServer(
        setup.logging
      , 'GitHub-GoogleFonts'
      , sources
      , grpcPort
      , setup.cache
      , setup.amqp
    );
}
