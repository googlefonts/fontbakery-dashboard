#! /usr/bin/env node
"use strict";
// this is expected to run in nodejs
/* global require, module */
/* jshint esnext:true */

const { _Source } = require('./_Source')
  , Parent = _Source
  , { ManifestServer } = require('../util/ManifestServer')
  , { getSetup } = require('../util/getSetup')
  , NodeGit = require('nodegit')
  ;

const GitBase = (function() {
function GitBase(logging, id, familyWhitelist) {
    this._log = logging;
    this.id = id;
    this._familyWhitelist = familyWhitelist;

    this._licenseDirs = new Set(['apache', 'ofl', 'ufl']);
    this._repoPath = '/tmp/fontsgit';
    this._repo = null;

    Parent.call(this);
}

var _p = GitBase.prototype = Object.create(Parent.prototype);

_p._initRepo = function() {
    // doesn't fail if the repository exists already
    // returns the repository
    var isBare = 1; // == true but must be a number
    return NodeGit.Repository.init(this._repoPath, isBare);
};

// remoteName = resourcePath.slice(1)
// remoteName = "google/fonts"
// remoteUrl = "https://github.com/google/fonts.git"
// referenceName = "master"
//
// remoteName = "m4rc1e/fonts"
// remoteUrl = "https://github.com/m4rc1e/fonts.git"
// referenceName = "pacifico"
_p._getRemote = function(remoteName) {
    // right now, hard-coding this to github.
    // githubResourcePath = '/google/fonts'
    // remoteName = github.resourcePath.slice(1)
    // var remoteUrl = ['git@github.com:', remoteName, '.git'].join('');
    // Use https for now, it is easier because it doesn't need ssh credentials!
    var remoteUrl = ['https://github.com/', remoteName, '.git'].join('');
    NodeGit.Remote.create(this._repo, remoteName, remoteUrl).then(null, err => {
        if(err.errno === NodeGit.Error.CODE.EEXISTS)
            // NOTE: the remote returned by Repository.getRemote has
            // a reference to the repository:
            // remote.repo, while the remote created using NodeGit.Remote.create
            // doesn't have that reference.
            // in both cases remote.owner() returns a repository, but these
            // are not the same instance as this._repo;
            return this._repo.getRemote(remoteName);
        throw err;
    });
};

_p._getRef = function(remoteName, referenceName) {
    // use _fetchRef to also update the ref
    var fullReferenceName = [remoteName, referenceName].join('/'); // m4rc1e/fonts/pacifico ???
    return this._repo.getReference(fullReferenceName);
};

_p._fetchRef = function(remoteName, referenceName) {
    return this._getRemote(remoteName)
        .then(remote => {
           this._log.info('Started fetching remote "'
                                + remoteName + ':' + referenceName + '"');
            // this may take a while!
            // E.g. initially fetching google/fonts:master
            // also, it kind of fails silently if there's no referenceName
            // at remote. Thus, later is checked if we can get the actual
            // reference from the repo.
           return remote.fetch(referenceName);
        })
        .then(() => this._getRef(remoteName, referenceName))
        .then(ref => {
            // this does not mean the remote reference exists now
            this._log.info('Finished fetching remote "'
                                + remoteName + ':' + referenceName + '"');
            return ref;
        }, err => {
            if(err.errno === NodeGit.Error.CODE.ENOTFOUND)
            // message: no reference found for shorthand '{fullReferenceName}'
            // errno: -3
                this._log.error('FAILED: Fetching remote "'
                                + remoteName + ':' + referenceName + '"');
            throw err;
        });
};

// this is a *good to know how* interface, we don't actually use it
// but it is good for debugging
_p._getOidType = function(oid) {
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
    this._repo.odb()
        .then(odb=>odb.read(oid))
        .then(odbObject => odbObject.type())
        ;
};

_p._getReferencedType = function(reference) {
    return this._getOidType(reference.target());
};

_p._getCommit = function(reference) {
    return NodeGit.Commit.lookup(this._repo, reference.target())
        .then(null, err => {
            // if reference target is something else
            // message the requested type does not match the type in ODB
            // errno: -3 }
            this._log.error(err);
            throw err;
        });
};


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
        Array.prototype.push.apply(flat, item);
        return flat;
    };
    return arrayOfArrays.reduce(reducer, []);
}

_p._getRootTreeFamilies = function(commit) {
    commit.getTree()
          .then(tree => {
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
        });
};

_p._dirsToCheckFromDiff = function (newTree, changedNamesDiff ) {
    let fileNames = changedNamesDiff.split('\n')
      , seen = new Set()
      , dirsToCheck = []
      ;
    for(let fileName of fileNames) {
        if(!fileName.length)
            // last line is empty afaik
            continue;
        let parts = fileName.split('/');
        if(!this._licenseDirs.has(parts[0]) || parts.length >= 2)
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

// returns a list of family directories that differ
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


const _FAMILY_WEIGHT_REGEX = /([^/-]+)-(\w+)\.ttf$/;
function familyNameFromFilename(filename) {
  /**
   * Ported partially from Python gftools.util.google_fonts.FileFamilyStyleWeight
   * https://github.com/googlefonts/tools/blob/master/Lib/gftools/util/google_fonts.py#L449
   *
   * If style and weight is needed it's worth porting the whole function.
   *
   * > familyNameFromFilename('LibreBarcode39ExtendedText-Regular.ttf')
   * 'Libre Barcode 39 Extended Text'
   */

  var m = filename.match(_FAMILY_WEIGHT_REGEX);
  if(!m)
    throw Error('Could not parse ' + filename);
  return familyName(m[1]);
}

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

_p._updateTreeEntry = function(treeEntry, metadata) {
    function treeEntryToFileData(treeEntry) {
        return treeEntry.getBlob()
                .then(blob => new Uint8Array(blob.content().buffer))
                .then(data => [treeEntry.name(), data])
                ;
    }

    function treeToFilesData(tree) {
        let fileEntries = tree.entries()
                              .filter(te=>te.isFile())
                              .map(treeEntryToFileData);
        return Promise.all(fileEntries);
    }

    let dispatchFilesData = (filesData) => {
        let familyName = null;
        for(let fileData of filesData) {
            let fileName = fileData[0];
            if(fileName.slice(-4) === '.ttf') {
                familyName = familyNameFromFilename(fileName);
                break;
            }
        }
        if(!familyName)
            throw new Error('Can\'t determine family name from files in '
                                + 'directory "' + treeEntry.path() + '".');

        if(this._familyWhitelist && !this._familyWhitelist.has(familyName))
            return null;

        return this._dispatchFamily(familyName, filesData, metadata);
    };
    return treeEntry.getTree()
                    .then(treeToFilesData)
                    .then(dispatchFilesData)
                    ;
};

this.init = function() {
    return this._initRepo.then(
        repo => this._repo = repo
      , err => {
          this._log.error('Can\'t init git reporsitory: ', err);
          throw err;
        }
    );
};

return GitBase;
})();

const GitBranch = (function() {

function GitBranch(logging, id, ...  setup, baseRef, familyWhitelist) {
    GitBase.call(this, logging, id, familyWhitelist);

    this._baseRef = baseRef;
    this._lastChecked = new Map();
    this._oldCommit = null;

}
var _p = GitBranch.prototype = Object.create(GitBase.prototype);

_p._update = function(forceUpdate, currentCommit) {
    let currentCommitTreePromise = currentCommit.getTree()
      , dirsPromise = this._oldCommit
            // based on diff
            ? Promise.all([this._oldCommit.getTree(), currentCommitTreePromise])
                     .then(trees => this._dirsToCheck(trees[0], trees[1]))
            // all families
            : this._getRootTreeFamilies(currentCommit)
      ;
    this._oldCommit = currentCommit;
    Promise.all([currentCommitTreePromise, dirsPromise])
    .then(resources => {
        let [currentCommitTree, dirs] = resources;
        return Promise.all(dirs.map(dir=>currentCommitTree.getEntry(dir)));
    })
    .then(treeEntries => {
        let promises = [];
        for(let treeEntry of treeEntries) {
            if(!forceUpdate && this._lastChecked.get(treeEntry.path()) === treeEntry.oid())
                // needs no update
                continue;
            this._lastChecked.set(treeEntry.path(), treeEntry.oid());
            let metadata = {
                commit: currentCommit.sha()
              , commitDate: currentCommit.date()
              , familyTree: treeEntry.sha()
              , familyPath: treeEntry.path()
              , repository: this._baseRef.remoteName
              , branch: this._baseRef.referenceName
            };
            promises.push(this._updateTreeEntry(treeEntry, metadata));
        }
        // some will resolve to null if there's a hit in this._familyWhitelist
        // though, at this point, error reporting may be the only thing left to
        // do.
        return Promise.all(promises);
    });
};

_p._fetchBaseRef = function() {
    return this._fetchRef(this._baseRef.remoteName, this._baseRef.referenceName);

    // only check PRs targeted at baseRef
    this._baseRef = baseRef;

};

// Runs immediately on init. Then it's called via the poke interface.
// There's no scheduling in the ManifestSource itself.
_p.update = function(forceUpdate) {
    // update the baseRef
    return this._fetchBaseRef()
        .then(reference => this._getCommit(reference))
        .then(currentCommit => this._update(forceUpdate, currentCommit))
        ;
};

return GitBranch;
})();


const GitBranchGithubPRs = (function() {
function GitBranchGithubPRs(logging, id, ... setup, familyWhitelist) {
    GitBase.call(this, logging, id, familyWhitelist);
}


var _p = GitBranchGithubPRs.prototype = Object.create(GitBase.prototype);
return GitBranchGithubPRs;
})();


function download(fileUrl) {
    function onResult(resolve, reject, res) {
        var data = [ ];
        res.on('data', function(chunkBuffer) {
            data.push(chunkBuffer);
        });
        res.on('end', function() {
            var binary = Buffer.concat(data);
            resolve(new Uint8Array(binary.buffer));
        });
        res.on('error', function(err) {
            reject(err);
        });
    }
    return new Promise(function(resolve, reject) {
        var http_ = fileUrl.indexOf('https') === 0 ? https : http;
        http_.get(url.parse(fileUrl)
                                , onResult.bind(null, resolve, reject));
    });
}

function download2JSON(uint8arr) {
    return JSON.parse(new Buffer(uint8arr).toString());
}

function apiData2Map(data) {
    var i, l, family
      , items = data.items
      , result = new Map()
      ;
    for(i=0,l=items.length;i<l;i++) {
        family = items[i].family;
        if(result.has(family))
            throw new Error('Assertion failed: Family is multiple times '
                            + 'in API data "' + family + '".');
        result.set(family, items[i]);
    }
    return result;
}




function downloadAPIData(url) {
    return download(url)
            .then(download2JSON)
            .then(apiData2Map)
            ;
}







_p._needsUpdate = function (familyData) {
    var familyName = familyData.family
      , oldFamilyData, variant, fileName
      ;

    if(!this._lastAPIData || !this._lastAPIData.has(familyName))
        // there's no API data yet, this is initial
        // or this is a new family
        return true;
    oldFamilyData = this._lastAPIData.get(familyName);
    if(familyData.lastModified !== oldFamilyData.lastModified
        || familyData.version !== oldFamilyData.version
        // this is essentially redundant data to familyData.files.keys()
        // despite of the order in variants which is not guaranteed in the
        // dictionary familyData.files
        || familyData.variants.length !== oldFamilyData.variants.length
    )
        return true;
    for(variant in familyData.files) {
        fileName = familyData.files[variant];
        if(!(variant in oldFamilyData.files))
            return true;
        if(fileName !== oldFamilyData.files[variant])
            return true;
    }
    // no indication for an update found
    return false;
};





_p._loadFamily = function(familyData) {
    var files = []
      , variant, fileUrl, fileName
      ;
    // download the files

    function onDownload(fileName, blob){
        return [fileName, blob];
    }
    for(variant in familyData.files) {
        fileUrl = familyData.files[variant];
        // make proper file names
        fileName = makeFontFileName(familyData.family, variant);
        // Bind fileName, it changes in the loop, so bind is good, closure
        // and scope are bad.
        files.push(download(fileUrl)
                    .then(onDownload.bind(null, fileName /* => blob */)));
    }

    return Promise.all(files);
};

// Runs immediately on init. Then it's called via the poke interface.
// There's no scheduling in the ManifesrSource itself.
_p.update = function(forceUpdate) {
    // download the API JSON file

    return downloadAPIData(this._apiAPIDataUrl)
        .then(this._update.bind(this, forceUpdate /* Map apiData */ ))
        ;
};

_p._update = function(forceUpdate, apiData) {
    var dispatchFamily, updating = [];

    for(let familyData  ) {

        let familyName = familyData.family
        if(this._familyWhitelist && !this._familyWhitelist.has(familyName))
            continue;

        if(!(forceUpdate || this._needsUpdate(familyData)))
            continue;
        dispatchFamily = this._dispatchFamily.bind(this, familyName);
        updating.push(this._loadFamily(familyData).then(dispatchFamily));
    }
    this._lastAPIData = apiData;
    return Promise.all(updating);
};







if (typeof require != 'undefined' && require.main==module) {

    // ensure a repository is available
    if (!repo)
        repo = new empy repo at var/fontsgit //a bare git



    // fetch all refs for constant monitoring
    // that is google/fonts:master
    //    we can keep this a remote ref as well, no need for local monitoring
    //    fetch is also not affected by conflicts e.g. in a case of a rollback or such

    for id, reponame, url, branch in monitored:
        // Git. Remote.create(repo, "m4rc1e", "https://github.com/m4rc1e/fonts")
        if (!has remote)
            Remote.create(repo, reponame, url)
        else
            // do we need to remeber the current tree-oid here?
            // I guess that's done somewhere else
            repo.getRemote(reponame).then()

        remote.fetch(branch).then(...)

    => we'll have to create remotes a lot and fetch referenced trees
       but, google/fonts:master is basically a default case


    google/fonts:master -> monitored branch
                        -> checks differences between last check and current
                           `if families in the branch changed`
                           -> to check if there was an actual change, we
                              keep the last checked commit-id for each font family
                              (or the tree-oid? more exact probably)
                           -> if the files are still identical, the ManifestMaster
                              will take care of this
                uses one old_tree and a list of one "new_trees"
                "old_tree" => oid of last checked "new_tree"
                              if no old_tree is available, we need to check
                              the full collection, i.e. the tree of the first commit?
                              maybe we can bypass and just send all entries of
                              new_tree that are in the target directories
                "new_tree" => current google/fonts/master


    google/fonts:master/pull-requests -> via github api!
                        -> fetches PRs from github for the monitored branch
                        -> so this is ONLY PRs to master
                        -> and also uses only the latest commit that is
                           adressed to master.
                uses one "old_tree" and many "new_trees"
                old_tree => current google/fonts/master (or rather the tree referenced by the commit)

    the sources are different implementations, but both run on the
    same ManifestServer, because they share the google/fonts repository.
    Thus, many git objects will be shared between both, which will make
    us inherit a lot of gits own optimizations.

    Thus, the two sources will be initialized serially, the first one
    (whichever it is) will load the  google/fonts:master tree
    the second one will only see see that it is already loaded (for the
    sake of simplicity probably even call git fetch, but without any download
    action following).



    function check_trees(old_tree, new_trees_in_order) {
        checks_to_do = new Map()
        for(new_tree in new_trees)
            changed_files = diff(repo, old_tree, new_tree)
            family_dirs_to_check = get_font_family_trees(changed_files, new_tree)
            for(family_dir of family_dirs_to_check) {
                if(checks_to_do.has(family_dir))
                    // a newer PR adressed this family
                    continue;
                // new_tree is the root directory
                // we could get here the actual root directory tree of the
                // font_dir and use its oid, then:
                //if(old_checks.get(font_dir) === oid)
                //    skip the check
                get_actual_id_for_cache(family_dir, new_tree)
                checks_to_do.set(family_dir, new_tree);
            }
    }

    // on update:

    // if there is no state information about the last update,
    // all of the fonts must be dispatched

    // if there is state information about the last update
    // dispatch only fonts with another tree object id than the state knows

    // dispatch: download the font dir
    // don't fetch files in subdirectories, we want a flat dir here
    // besides, at the moment, fontbakery-worker rejects sub directories
    //make and array:
    files = []
    files.push(fileName, [new Uint8Array(binary.buffer)])






    // This needs the github api first ...
    // for PR's
    // get all PRs from github.com/google/fonts
    //    this is possible, but we don't get the ssh-url nor the real git url:
    //          https://platform.github.community/t/ssh-url-of-repositories/3736
    //      repository.url: "https://github.com/google/fonts"
    //      reporsitory.resourcePath: "/google/fonts"
    //
    //       pullRequests.nodes[i].headRefName: "pacifico"
    //       pullRequests.nodes[i].headRef: {
    //            "id": "MDM6UmVmNjQyMTg3MjE6cGFjaWZpY28=",
    //            "name": "pacifico",
    //            "prefix": "refs/heads/",
    //            "repository": {
    //                  "id": "MDEwOlJlcG9zaXRvcnk2NDIxODcyMQ==",
    //                  "resourcePath": "/m4rc1e/fonts",
    //                  "url": "https://github.com/m4rc1e/fonts"
    //             }
    //
    // https: https://github.com/google/fonts.git
    //              either: "{url}.git"
    //                  or: "https://github.com{resourcePath}.git"
    //                  or: "https://github.com/{resourcePath.slice(1)}.git"
    //   ssh: git@github.com:google/fonts.git
    //                  "git@github.com:{resourcePath.slice(1)}.git"
    //
    //
    //
    // nodegit.Remote.create(repo, 'm4rc1e/fonts', "https://github.com/m4rc1e/fonts")
    //
    // > p = Git.Remote.create(repo, "m4rc1e", "https://github.com/m4rc1e/fonts").then(rem=>this.remote=rem)
    // > p.getReason()
    // { Error: remote 'm4rc1e' already exists
    // at Error (native) errno: -4 }
    //
    // var Git = require('nodegit')
    // > Git.Repository.open("../../../../fonts/").then(repo => this.repo=repo)

    // > repo.getRemote('m4rc1e').then(remote=>this.remote=remote).then(null, console.log)
    // > remote.fetch('pacifico').then(...)
    // p = repo.getReference('m4rc1e/pacifico').then(reference=>this.reference=reference)


todo: paginate github queries for PRs
      filter by pr's that go to master
      order by age

      -> this is basically the same for diffs between the last master commit
         and the current master commit
      check all the diffs and collect affected font families.
      if a font family is affected by many PRs, the youngest PR is chosen
      i.e. skip families that have been looked at before in this run
      mark the font-family versionfor the next run, could use all file-object
      ids, as that won't even change between rebasing. still, it is probably
      to just use the HEAD commit as mark.

var NodeGit = require('nodegit')
NodeGitGit.Repository.open("../../../../fonts/").then(repo => this.repo=repo)
p = repo.getReference('m4rc1e/pacifico').then(r=>this.reference=r)
NodeGit.Commit.lookup(repo, reference.target()).then(commit => this.commit=commit)
// only monitor the PR if it's going into master!
repo.getReference('master').then(masterRef=>this.masterRef=masterRef)
NodeGit.Commit.lookup(repo, masterRef.target()).then(masterCommit=>this.masterCommit=masterCommit)
masterCommit.getTree().then(m=>this.old_tree=m)
commit.getTree().then(m=>this.new_tree=m)
diffOptions = new NodeGit.DiffOptions();
NodeGit.Diff.treeToTree(repo, old_tree, new_tree, diffOptions).then(d=>this.diff=d)
diff.toBuf(NodeGit.Diff.FORMAT.NAME_ONLY).then(names=>this.names=names)
> names
'ofl/pacifico/METADATA.pb\nofl/pacifico/Pacifico-Regular.ttf\n'
> names.split('\n')
[ 'ofl/pacifico/METADATA.pb',
  'ofl/pacifico/Pacifico-Regular.ttf',
  '' ]


new_tree.getEntry('ofl/pacifico/METADATA.pb').then(treeEntry=>thistreeEntry=treeEntry)
treeEntry.getBlob().then(b=>b.toString()).then(console.log)
//  b.content() === <Buffer 12 34 ...>

new_tree.getEntry('ofl/pacifico').then(t=>this.ptreeEntry=t) // TreeEntry; ptree.dirtoparent => 'ofl'

ptreeEntry.getTree(t=>this.ptree = t);
ptree.entries().map(e=>e.name());


new_tree.getEntry('ofl/removed_font').then(null, console.error)
Promise { _55: 0, _87: null, _28: [] }
> { Error: the path 'removedFont' does not exist in the given tree
    at Error (native) errno: -3 }


    // use only the latest PR that changes a font family <= which font familie (subdirectories) are changed?
    //          the "files-changed" info is sufficient for this!
    // if a PR changes many families it's still only the latest that we
    // use
    // check the update state and fetch all those PR trees
    // that are newer/others than in the update state
    // dispatch the files and update the update state
    // update the


    var setup = getSetup(), sources = [], server
       , apiDataBaseUrl = 'https://www.googleapis.com/webfonts/v1/webfonts?key='
       , apiDataUrl = apiDataBaseUrl + process.env.GOOGLE_API_KEY
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

    if(!process.env.GOOGLE_API_KEY)
        // see: Using Secrets as Environment Variables
        // in:  https://kubernetes.io/docs/concepts/configuration/secret/#using-secrets-as-environment-variables
        // and: https://kubernetes.io/docs/tasks/inject-data-application/distribute-credentials-secure
        // $ kubectl -n $NAMESPACE create secret generic external-resources --from-literal=google-api-key=$GOOGLE_API_KEY
        throw new Error('MISSING: process.env.GOOGLE_API_KEY');

    setup.logging.log('Loglevel', setup.logging.loglevel);
    // the prod api

    if(process.env.DEVEL_FAMILY_WHITELIST) {
        familyWhitelist = new Set(JSON.parse(process.env.DEVEL_FAMILY_WHITELIST));
        if(!familyWhitelist.size)
            familyWhitelist = null;
        setup.logging.debug('FAMILY_WHITELIST:', familyWhitelist);
    }

    sources.push(new GoogleFonts(setup.logging, 'production', apiDataUrl, familyWhitelist));
    // the devel api
    //sources.push(new GoogleFonts('sandbox'/* setup.logging, setup.amqp, setup.db, setup.cache */));
    // FIXME: Lots of setup arguments missing

    server = new ManifestServer(
            setup.logging
          , 'GoogleFontsAPI'
          , sources
          , grpcPort
          , setup.cache
          , setup.amqp
    );
}
