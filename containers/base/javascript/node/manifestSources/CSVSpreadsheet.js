#! /usr/bin/env node
"use strict";
// this is expected to run in nodejs
/* global require, module */
/* jshint esnext:true */

/**
 * This service provides repositories identified by csv-formatted data
 * (used as upstream sources) to the dashboard.
 *
 * Not implemented:
 * Add an extra grpc-interface service for "upstream-info/data"
 * When checks use the CSV data, along as the CSV is downloaded and
 * updated in here, the checks that use the data are not idempotent
 * for the dashboard! There's no implementation of this right now.
 *
 * -------------------------------------
 *
 * Currently we only use git repositories.
 *
 * In here, we don't have branch information yet, we use "master"
 * as referenceName  by default! We could include ":otherBranch" at the
 * end of "upstream" in the future.
 *
 * Runs immediately on init. Then it's called via the poke interface.
 * There's no scheduling in the ManifestSource itself.
 */
const { GitShared: Parent /*is a _Source*/ } = require('./Git')
  , { status: grpcStatus } = require('grpc')
  , csvParse = require('csv-parse')
  , NodeGit = require('nodegit')
  , { ManifestServer } = require('../util/ManifestServer')
  , { getSetup } = require('../util/getSetup')
  , https = require('https')
  , http = require('http')
  , fs = require('fs')
  , url = require('url')
  , { createMetadata, parseMetadata, serializeMetadata } = require('../util/getMetadataPb')
  ;

/**
 * Are there limits on cloning repos?
 *
 * NodeGit seems to have an internal thread pool limited to 8 threads.
 *
 * There's also a bug making using more than one parallel worker unreliable:
 * https://github.com/nodegit/nodegit/issues/1495
 * https://github.com/libgit2/libgit2/issues/4644
 *
 * Maybe GitHub:
 * https://platform.github.community/t/limit-on-cloning-repositories/3672/2
 * kytrinyx (GitHub Staff):
 * > here are no hard rate limits on cloning, so you are free to clone as
 *   much as you’d like. Still, we’d like to ask you to clone at a reasonable
 *   pace. Cloning a few (2-3-4) repositories in parallel is okay, cloning a
 *   100 repositories in parallel is not and can be detected as abusive
 *   behavior by our automated measures.
 */
const MAX_PARALLEL_GIT_FETCHES = 1; // 8;

/**
 * The sources are listed in a google docs spreadsheet.
 */
function CSVSpreadsheet(logging, id, reposPath, sheetCSVUrl, familyWhitelist
                                                        , reportsSetup) {
    this._log = logging;
    this._sheetCSVUrl = sheetCSVUrl;
    this._csvCache = null;// [promise, date, csvData]
    this._csvCacheMinutes = 5;

    // TODO: remove and delete files if a repo is  not in the CSV-sheet
    // anymore after an update?
    this._gitRepos = new Map();
    this.id = id;
    this._familyWhitelist = familyWhitelist;
    this._familyReportTable = null; // specific for this Source currently
    this._reposPath = reposPath;
    Parent.call(this, logging, id, familyWhitelist, reportsSetup);
}

var _p = CSVSpreadsheet.prototype = Object.create(Parent.prototype);

var CSVFamily = (function() {
    function CSVFamily(row) {
        this._row = row;
        this.dupes = [];
    }

    var _p = CSVFamily.prototype;

    /**
     * duplicates have the same name, but may be different otherwise
     */
    _p.addDuplicate = function(csvFamily) {
        this.dupes.push(csvFamily);
    };

    _p._toDictionary = function(names) {
        let d = {};
        for(let name in names)
            d[name] = this[name];
        return d;
    };

    function notImplementedGetter(name) {
        return {
                get: function(){
                    throw new Error('Getter "'+name+'" is not implemented');
                }
              , enumerable: true
        };
    }

    Object.defineProperties(_p, {
        upstream: notImplementedGetter('upstream')
      , name: notImplementedGetter('name')
      , nameConfirmed: notImplementedGetter('nameConfirmed')
      , fontfilesPrefix: notImplementedGetter('fontfilesPrefix')
      , status: notImplementedGetter('status')
      , upstreamType: {
            get: function() {
                if(this.upstream.indexOf('://github.com') !== -1)
                    return 'github';
                if(this.upstream.endsWith('.git'))
                    return 'git';
                return null;
            }
          , enumerable: true
        }
      , repoType: {
            get: function() {
                var gitTypes = new Set(['git', 'github']);
                if(gitTypes.has(this.upstreamType))
                    return 'git';
                return null;
            }
          , enumerable: true
        }
      , remoteUrl: {
            get: function() {
                if(this.upstreamType === 'github') {
                    // remove trailing /
                    // appending .git is actually not needed to be able
                    // to fetch from GitHub. But, we derive the repository
                    // disk location from the remoteUrl.
                    // A normalized remoteUrl helps to put the same
                    // repository to the same place on disk.
                    let remoteUrl = this.upstream.replace(/\/+$/, '');
                    return remoteUrl.endsWith('.git')
                            ? remoteUrl
                            // yeah, we have some of these: unify
                            // (It's not needed for GitHub!)
                            : remoteUrl + '.git'
                            ;
                }
                return this.upstream;
            }
          , enumerable: true
        }
      , remoteName: {
            get: function(){
                // make this explicit if usable for other repo types
                if(this.repoType === 'git')
                    return 'upstream/' + (this.name.replace(/ /g, '_'));
                // make this explicit if usable for other repo types
                throw new Error('"remoteName" not implemented for repoType: ' + this.repoType);
            }
          , enumerable: true
        }
      , referenceName: {
            get: function() {
                if(this.repoType === 'git')
                    return 'master';
                // make this explicit if usable for other repo types
                throw new Error('"referenceName" not implemented for repoType: ' + this.repoType);
            }
          , enumerable: true
        }
      , fontFilesLocation: {
            get: function() {
                let path = this.fontfilesPrefix.split('/')
                  , filesPrefix = path.pop()
                  ;
                return  [path.join('/'), filesPrefix !== undefined
                        ? filesPrefix
                        : ''
                        ];
            }
          , enumerable: true
        }
    });
    return CSVFamily;
})();

var CSVData = (function() {
    /**
     * using a class so we have a place to put data validation, easy accessors etc.
     */

    var knownSkippedStatuses = new Set(['ZIP', 'TTF', '?', 'RENAMED'
                , 'TTX', 'UFO', 'GH-PAGES', 'OTF', 'SOURCE-ONLY', ''
                , '404-ERROR', 'NOT-ON-GFONTS', 'NOT-ON-GH'])
      , acceptedStatuses = new Set(['OK', 'NOTE'])
        // also mapping from csv column headers to internally used names
      , expectedColumns = {
            'Status': 'status' // We are only interested in "OK" and "NOTE"
          , 'family': 'name' // A family name "with spaces"
          , 'family name is confirmed as good?': 'nameConfirmed' // "Passed" is true everything else is false
          , 'upstream': 'upstream' // starts with 'http://' or 'https://' (or 'git://'?)
          , 'fontfiles prefix': 'fontfilesPrefix' // seems like problematic data in the sheet
          , 'genre': 'genre'
          , 'designer': 'designer'
        }
      ;

    function makeCSVFamily(names) {
        // Make a subclass of CSVFamily that has getters that map names
        // to the row data. The names are the values of the expectedColumns
        // dictionary.
        var properties = {}
          , _makeRowGetter = (idx) => {
                return {
                    get: function() {
                        return this._row[idx];
                    }
                  , enumerable: true
                };
            }
         ;

        function CustomCSVFamily(...args) {
            CSVFamily.apply(this, args);
        }
        var _p = CustomCSVFamily.prototype = Object.create(CSVFamily.prototype);

        for(let name in names) {
            let idx = names[name];
            properties[name] = _makeRowGetter(idx);
        }
        Object.defineProperties(_p, properties);

        _p.toString = function() {
            let d = [];
            for(let name in names)
                d.push([name, this[name]].join(': '));
            return d.join(';\n    ');
        };

        _p.toDictionary = function() {
            return this._toDictionary(names);
        };

        return CustomCSVFamily;
    }

    function CSVData(namesRow) {
        this._data = new Map();
        this._names = {};
        for(let i=0,l=namesRow.length;i<l;i++) {
            let name = namesRow[i];
            if(!(name in expectedColumns))
                continue;
            let mappedName = expectedColumns[name];
            if(mappedName in this._names)
                throw new Error('A name "' + mappedName + '" already exists. '
                            + 'From column i:' + i + ', val:"' + name + '".');
            // map to internal name!
            this._names[mappedName] = i;
        }
        for(let name in expectedColumns)
            if(!(expectedColumns[name] in this._names))
                throw new Error('A column for "' + name + '" is missing');
        this.CSVFamily = makeCSVFamily(this._names);
        this._report = [['Family Name', 'Status', 'Message']];
    }
    var _p = CSVData.prototype;

    Object.defineProperty(_p, 'report', {
        get: function(){
            return this._report.slice();
        }
    });

    _p._pushReport = function(...row){
        this._report.push(Object.freeze(row));
    };

    _p._getEntry = function(row, name) {
        return row[this._names[name]];
    };

    _p.addFamily = function(familyRow) {
        // these column headers (first row contents) are expected
        // assert 'Status' in names ...
        // each row must define these indexes
        // extra points if we add simple validators to each entry
            // below is some check for this.
        var rawStatus = this._getEntry(familyRow, 'status')
          , familyName = this._getEntry(familyRow, 'name')
          , familyItem
          ;

        let status = rawStatus.toUpperCase();
        if(!acceptedStatuses.has(status)) {
            if(!knownSkippedStatuses.has(status))
                this._pushReport(familyName, 'warning',
                                'unrecognized status (skipped): ' + rawStatus);
            else
                this._pushReport(familyName, 'skipped',
                                'ignored status: ' + rawStatus);
            return; // skip
        }
        if(status !== rawStatus) {
            // e.g. 'Note' instead of 'NOTE'
            // should be fixed in the CSV
            this._pushReport(familyName, 'warning', ['Bad status style: '
                                , rawStatus, familyName, 'should be:'
                                , status].join(' '));
        }
        // Todo: sanity check all row data in the CTOR.
        familyItem = new this.CSVFamily(familyRow);
        if(this._data.has(familyItem.name)) {
            this._data.get(familyItem.name).addDuplicate(familyItem);
            this._pushReport(familyName, 'warning', 'Skipped duplicate '
                             + 'family row: ' + familyItem.name);
        }
        else
            this._data.set(familyItem.name, familyItem);
    };

    _p.values = function() {
        return this._data.values();
    };

    _p.get = function(familyName, defaultVal) {
        if(!this._data.has(familyName)) {
            if(arguments.length > 1)
                return defaultVal;
            var error = new Error('No family found for "' + familyName + '".');
            error.code = grpcStatus.NOT_FOUND;
            throw error;
        }
        return this._data.get(familyName);
    };

    _p.list = function() {
        return Array.from(this._data.keys()).sort();
    };

    return CSVData;
})();

function downloadCSVData(fileUrl) {
    function onResult(resolve, reject, res) {
        var csvReader = csvParse({
              //  columns:true// => creates dicts instead of arrays
                trim: true
              , skip_empty_lines: true
              , auto_parse: true
            })
          , result = null
          ;
        // res.pipe(process.stdout);// => for debugging
        res.pipe(csvReader) // ->  <stream.Writable>
            .on('data', function (row) {
                if(!result) {
                    // FIRST row arrived "namesRow"
                    result = new CSVData(row);
                    return;
                }
                result.addFamily(row);
            })
            .on('end', function (...args) {
                //jshint unused:vars
                resolve(result);
            })
            .on('error', function(err) {
                reject(err);
            });
    }
    return new Promise(function(resolve, reject) {
        let resultHandler = onResult.bind(null, resolve, reject)
          , protocol = fileUrl.split('://', 1)[0]
          ;

        if(protocol.startsWith('http')) {
            var httpx = protocol === 'https' ? https : http;
            httpx.get(url.parse(fileUrl), resultHandler);
        }
        else if(protocol === 'file')
            resultHandler(fs.createReadStream(fileUrl.slice('file://'.length)));
        else
            throw new Error('Don\'t know how to handle file url "'+fileUrl+'"; '
                + 'it should start with "http://", "https://" or "file://".');
    });
}

_p._downloadCSVData = function(force) {
    var [promise, date, csvData] = this._csvCache || [];
    if(promise)
        // a download is happening at the moment
        return promise;
    if(!force // we may use the cache
              && date // we have a cache
              // the cache is not timed out
              && date.toTime + (this._csvCacheMinutes * 60 * 1000) < Date.now())
        return Promise.resolve(csvData);

    promise = downloadCSVData(this._sheetCSVUrl)
    .then(csvData=>{
        this._csvCache = [null, new Date(), csvData];
        return csvData;
    }, error=>{
        // can't keep that promise forever
        this._csvCache = null;
        throw error;
    });
    this._csvCache = [promise, null, null];
    return promise;
};

_p._reportFamily = function(familyName, status, message) {
    if(!this._familyReportTable)
        // no reporting at the moment
        return;
    this._familyReportTable.push([familyName, status
                                , message !== undefined ? message : '']);
};

_p.__getRemote = function(repo, remoteName, remoteUrl, allowUpdateUrl) {
    return NodeGit.Remote.create(repo, remoteName, remoteUrl)
    .then(null, err => {
        if(err.errno !== NodeGit.Error.CODE.EEXISTS)
            throw err;
        // => err.errno === NodeGit.Error.CODE.EEXISTS

        // NOTE: the remote returned by Repository.getRemote has
        // a reference to the repository:
        // remote.repo, while the remote created using NodeGit.Remote.create
        // doesn't have that reference.
        // Iin both cases remote.owner() returns a repository.
        return repo.getRemote(remoteName).then(remote => {
            let currentUrl = remote.url();
            if(currentUrl === remoteUrl)
                return remote;

            // the url is different
            // FIXME: the url changed, but what has `allowUpdateUrl`
            // to do with this?
            if(!allowUpdateUrl)
                throw new Error('Remote "'+remoteName+'" exists '
                        + 'pointing to "'+currentUrl+'" but url "'
                        + remoteUrl+'" is expected and updating is '
                        + 'not allowed.');

            // update the remote remote url
            // remote.setUrl is sync; Returns Number 0 or an error value
            let result = remote.setUrl(repo, remoteName, remoteUrl);
            if(result !== 0)
                throw new Error('`remote.setUrl` failed with error '
                    + 'value "'+result+'" trying to set  remoteName: "'
                    + remoteName + '"; remoteUrl: "' + remoteUrl + '"'
                    +' old url was: "'+currentUrl+'".');
            return remote;
        });
    });
};

/**
 * _remoteUrl2Directory('https://github.com/googlefonts/Abc')
 * => 'github.com_googlefonts_Abc'
 *
 * If the resulting directory is shorter than 3 chars "__fallback__" is
 * returned.
 *
 * Having different repository directories is important to be able to
 * fetch in parallel, since a used repo will be locked while lib git
 * is writing.
 */
function _remoteUrl2Directory(remoteUrl) {
                             // remove protocoll like "https://"
    var directory = remoteUrl.split('://').slice(1).join('//')
                             // replace all slashes by '_'
                             .replace(/\//g, '_')
                             // remove all leading dots
                             .replace(/\.*/, '');
    if(directory.length <= 3) // 3 is just a random low number
        directory = '__fallback__';
    return directory;
}

_p._getRemote = function(remoteName, remoteUrl, allowUpdateUrl) {
    var directory = _remoteUrl2Directory(remoteUrl)
      , repoPath = this._reposPath + '/' + directory
      , repoPromise
      ;
    if(this._gitRepos.has(repoPath))
        // this._gitRepos.get(repoPath) can be a repo or a promise at this point,
        // BUT Promise.resolve can handle a promise (thennable) as argument
        // If it is still a promise, we'll just wait a bit longer.
        repoPromise = Promise.resolve(this._gitRepos.get(repoPath));
    else {
        repoPromise = new Promise((resolve, reject)=>{
            this._initRepo(repoPath).then(repo => {
                // replace this._gitRepos.get(repoPath)
                this._gitRepos.set(repoPath, repo);
                resolve(repo);
                return repo;
            }, reject);
        });
    }
    return repoPromise.then(repo =>
                this.__getRemote(repo, remoteName, remoteUrl, allowUpdateUrl))
            // FIXME: needs a logging strategy. It's at some points good
            // to know what operation failed, but also to keep the original
            // error bubbling on.
            .then(null, err=>{
                this._log.error('method: _getRemote', err);
                throw err;
            });
};

_p._fetchRef = function(remoteName, remoteUrl, referenceName) {
    return this._queue('git.lock ' + remoteUrl
                    , () => this.__fetchRef(remoteName, remoteUrl, referenceName));
};

_p.__runParallelJob = function(workerId, func, jobs) {
    this._log.info('__runParallelJob workerId:', workerId, 'jobs:', jobs.length);
    if(!jobs.length)
        // no jobs left
        return;

    var [args, resolve, reject] = jobs.shift();
    func(...args)
        .then(
            result=>{
                this._log.debug('worker-id', workerId, 'done');
                resolve(result);
            }
          , err=>{
                // just a debug, the rejection should be handled somewhere else
                this._log.debug('worker-id', workerId, 'failed with', err);
                // don't end the worker (by re-raising)
                reject(err);
            }
        )
        // regardless of the result: repeat
        .then(() => this.__runParallelJob(workerId, func, jobs))
        ;
};

_p._mapParallelJobs = function(func, data, maxParalellJobs, itemsAreArguments) {
    var promises = []
      , jobs = []
      ;

    for(let item of data) {
        let args = itemsAreArguments ? item : [item]
          , job = [args, /*resolve, reject*/]
          ;
        promises.push(new Promise(
            (resolve, reject)=>job.push(resolve, reject))); // jshint ignore:line
        jobs.push(job);
    }
    for(let workerId=0;workerId<maxParalellJobs;workerId++)
        this.__runParallelJob(workerId, func, jobs);
    return promises;
};

/**
 * See comment at MAX_PARALLEL_GIT_FETCHES for reasoning/documentation.
 */
_p._fetchGits = function(gitFamiliesData) {
    return this._mapParallelJobs(this._fetchGit.bind(this)
                               , gitFamiliesData
                               , MAX_PARALLEL_GIT_FETCHES
                               );
};

/**
 * Returns a promise resolving to a reference;
 */
_p._fetchGit = function(familyData) {
    // Pro-Tip: Shortcutting (for debbuging) can be done with `_getRemote`,
    // **if** the stuff is on disk already:
    // return this._getRemote(familyData.remoteName, familyData.remoteUrl, false)
    //     .then(remote=>this._getRef(remote.owner()
    //         , familyData.remoteName
    //         , familyData.referenceName)
    //     )
    //     .then(null, err => {
    //         this._reportFamily(familyData.name, 'failed'
    //                                             , '(_getRemote): ' + err);
    //         this._log.error('failed _getRemote/_getRef'
    //                     , 'remoteUrl:', familyData.remoteUrl
    //                     , 'remoteName:', familyData.remoteName
    //                     , 'referenceName:', familyData.referenceName
    //                     , err);
    //         throw err;
    //     });
    return this._fetchRef(familyData.remoteName
                        , familyData.remoteUrl
                        , familyData.referenceName)
        .then(null, err => {
            this._reportFamily(familyData.name, 'failed'
                                                , '(_fetchRef): ' + err);
            this._log.error('failed _fetchRef'
                        , 'remoteUrl:', familyData.remoteUrl
                        , 'remoteName:', familyData.remoteName
                        , 'referenceName:', familyData.referenceName
                        , err);
            throw err; // re-raise
        });
};

_p._fetchGoogleFontsMaster = function() {
    return this._fetchGit({
            name: 'Google Fonts GitHub Master'
          , remoteName: 'google/fonts'
          , remoteUrl: 'https://github.com/google/fonts.git'
          , referenceName: 'master'
    }); // -> git reference promise
};

function _getTreeFromTreeEntry(treeEntry) {
    if(treeEntry.isTree())
        return treeEntry.getTree();
    let path = treeEntry.path()
      , type = treeEntry.type()
      , typeName = 'UNKNOWN'
      ;
    for(let name of Object.keys(NodeGit.Object.TYPE))
        if (type === NodeGit.Object.TYPE[name]) {
            typeName = name;
            break;
        }
    throw new Error(['Entry at path: "', path, '" is not a directory (tree)!'
                        , 'Type is: ', typeName,' (',type,').'].join(' '));
}

/**
 * same as pythons builtin `zip` function
 */
function zip(...arrays) {
    var result = [];
    for(let i=0,l=Math.min(...arrays.map(a=>a.length));i<l;i++) {
        let row = [];
        for(let a of arrays) row.push(a[i]);
        result.push(row);
    }
    return result;
}

function _getMetadata(files, familyData, commit, tree, googleMasterFamilyTree) {
    var isUpdate = !!googleMasterFamilyTree
      , googleMasterDir = isUpdate
                            ? googleMasterFamilyTree.path()
                            : '(unknown)'
        // as default assuming OFL, the most common license,
        // otherwise, add the right license file to the repo data!
      , licenseDir = 'ofl'
      ;
    if(isUpdate)
            // If this is the wrong licenseDir it's unlikely that
            // the dispatcher pipeline will work for the family.
            // At least the PR will end in the wrong place!
            licenseDir = googleMasterDir.split('/')[0];
    // no update assumed
    else {
        for(let [file, dir] of [
                    ['UFL.txt', 'ufl']
                  , ['OFL.txt', 'ofl']
                    // this is last because the UFL font's also have a LICENSE.txt
                  , ['LICENSE.txt', 'apache']]) {
            if(files.has(file)) {
                licenseDir = dir;
                break;
            }
        }
    }

    return {
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
}

// insightful:
//  https://github.com/googlefonts/fontbakery/issues/637#issuecomment-175243241
function _fontFamilyGenre2Category(genre) {
    // 'Display' => 'DISPLAY'
    // 'Serif' => 'SERIF'
    // 'Sans Serif' => 'SANS_SERIF'
    // 'sans-serif' => 'SANS_SERIF' // this is not what we use
    // 'Handwriting' => 'HANDWRITING'
    // 'Monospace' => 'MONOSPACE'
    return genre.toUpperCase().replace(' ', '_').replace('-', '_');
}

_p._insertMetadataPB = function (filesData, metadata) {
    // We ALWAYS set our expectations from the CSV data row here,
    // making the CSV the single source of truth for that data, otherwise,
    // we don't learn about wrong/outdated information in the CSV data
    // via Font Bakery checking!

    // Uses the infamous gftools-add-fonts.py script, which does the
    // best it can, but fails to set the information an engineer would
    // do by hand in the human editable METADATA.pb file.
    // We use the CSV entry to set that information. Partly also, because
    // the names etc. set, for a new family taken from the font files, become
    // self-referential when checking metadata vs. font data and may yield
    // in false positives. Another good reason is to have a way to control
    // parts of the contents of METADATA.pb via the CSV row.
    this._log.debug('createMetadata ...')
    return createMetadata(filesData, metadata.licenseDir)// -> fileData <Uint8Array>
    // START manipulating METADATA.pb
    .then(fileData=>{
        this._log.debug('parseMetadata ...')
        return parseMetadata(Buffer.from(fileData))
    }) // -> familyProtoMessage <FamilyProto>
    .then(familyProtoMessage=>{
        // e.g. sourceDetails = {
        //      "status": "OK"
        //    , "name": "ANRT Baskervville"
        //    , "nameConfirmed": "Not checked",
        //    , "upstream": "https://github.com/anrt-type/ANRT-Baskervville"
        //    , "fontfilesPrefix": "fonts/Baskervville_TTF/Baskervville-"
        // }
        // default: python: _FileFamilyStyleWeights(fontdir)[0].family
        this._log.debug('changing familyProtoMessage ...')
        familyProtoMessage.setName(metadata.sourceDetails.name);
        let category = _fontFamilyGenre2Category(metadata.sourceDetails.genre);
        familyProtoMessage.setCategory(category); // default: "SANS_SERIF"
        if(metadata.sourceDetails.designer)
            // default: "UNKNOWN" if new or the value of the old METADATA.pb
            // We initially didn't have the designer field in the CSV data,
            // hence we just use the default gftools-add-fonts  behavior
            // if there was no designer in the csv field.
            familyProtoMessage.setDesigner(metadata.sourceDetails.designer);
        for(let font of familyProtoMessage.getFontsList())
            font.setName(metadata.sourceDetails.name);
        this._log.debug('DONE changing familyProtoMessage ...');
        return familyProtoMessage;
    })
    .then(familyProtoMessage=>{
        this._log.debug('serializeMetadata ...')
        return serializeMetadata(familyProtoMessage);
    }) // -> fileData <Uint8Array>
    // DONE manipulating METADATA.pb
    .then(fileData=>{
        this._log.debug('saving  METADATA.pb', Buffer.from(fileData).toString() ,'...');
        var metaDataFile = 'METADATA.pb'
          , resultFilesData = filesData.slice()
          ;
        // remove all existing entries for metaDataFile
        for(let i=resultFilesData.length-1;i>=0;i--) {
            if(resultFilesData[i][0] === metaDataFile)
                resultFilesData.splice(i, 1);
        }
        // insert the updated/new metaDataFile
        resultFilesData.push([metaDataFile, fileData]);
        return resultFilesData;
    }, err=>{
        // This is not a complete failure, Font Bakery will likely complain
        // here, because it was not possible to create or update the
        // METADATA.pb file
        this._log.warning('Can\'t create METADATA.pb:', err);
        return filesData;
    });
};

_p._collectDataGit = function(familyData, commit, tree, rootTree
            , masterFamilyTree, filesPrefix) {
    var files = new Map()
      , treeToFiles = (tree, filterFunc) => {
            return this._treeToFilesData(tree, filterFunc)
                    .then(filesData=>filesData.map(
                        // This will override entries that are already
                        // in files, which is expected.
                        fileData/*[name, data]*/=>files.set(...fileData)));
        };
    // From masterFamilyTree: get all files, except the .ttf ones
    return (masterFamilyTree
                // this may be null, e.g. if the family is a new addition
                ? treeToFiles(masterFamilyTree, filename=>!filename.endsWith('.ttf'))
                : Promise.resolve())
    // From tree: get all .ttf files starting with filesPrefix
    .then(()=>treeToFiles(tree, filename=>{
        return (filesPrefix
                    ? filename.startsWith(filesPrefix)
                    : true
                    // really only add ".ttf" files from the font files
                    // tree to the google fonts api/fontbakery check!
                ) && filename.endsWith('.ttf');
    }))
    // From rootTree: get all known license files. Usually there should
    // be only one, but this is the wrong place to detect and complain
    // about ambiguities (use Font Bakery). Also, the Ubuntu fonts have
    // both LICENSE.txt and UFL.txt with the same contents.
    .then(()=>treeToFiles(tree, filename=>{
        var licenseFiles = new Set(['OFL.txt', 'LICENSE.txt', 'UFL.txt']);
        return licenseFiles.has(filename);
    }))
    // Maybe we can have a drag and drop entry point for the dispatcher?
    // that way we could update stuff using the dispatcher pipeline
    // without having to program rare exceptions.
    .then(()=>{
        var metadata = _getMetadata(files, familyData, commit, tree, masterFamilyTree);
        return this._insertMetadataPB(
                        Array.from(files.entries()) // -> filesData
                     ,  metadata
                     ) // -> filesData
            .then(filesData=>[metadata, filesData]);
    })
    .then(([metadata, filesData])=>[
             filesData
           , metadata
           , tree.path()
           , familyData.name
    ]);// -> [filesData, metadata, path, familyName]
};


function _findTree(
                  root /*can be a tree or a commit (needs `getEntry`)*/
                , dirName
                , searchDirs) {
    // searchDirs will be consumed recursively: searchDirs.slice(1)
    var searchDir, path;
    if(!searchDirs.length)
        // A directory for dirName was not found.
        throw new Error('Directory not found for "' + dirName + '".');
    searchDir = searchDirs[0];
    path = [searchDir, dirName].join('/');
    return root.getEntry(path).then(
        /* found */
        _getTreeFromTreeEntry// treeEntry->tree
        /* redo */
      , err=> {
            if(err.errno === NodeGit.Error.CODE.ENOTFOUND)
                // retry
                return _findTree(root, dirName, searchDirs.slice(1));
            // fail, other kind of error
            throw err;
        }
    );
}

_p._getGitMasterTreeForFamily = function(familyName) {
    return this._fetchGoogleFontsMaster()
        .then(reference=>this._getCommit(reference.owner(), reference.target()))
        .then(currentCommit=>_findTree(
                currentCommit
              , familyName.toLowerCase().replace(/ /g, '')/*familyDirName*/
              , ['ofl', 'apache', 'ufl']/*licenseDirs*/))
        .then(null, err=>{
            this._log.info('Can\'t get ', familyName, 'tree from master:', err);
            return null;
        });
};

_p._getGitData = function(familyData, reference) {
    return this._getCommit(reference.owner(), reference.target())
        .then(commit=>{
            var [path, filesPrefix] = familyData.fontFilesLocation
              , rootTreePromise = commit.getTree()
              , treePromise = path === ''
                        ? rootTreePromise // -> no path: use root
                        : commit.getEntry(path) // -> treeEntry
                                .then(_getTreeFromTreeEntry) // -> tree
              , masterFamilyTreePromise = this._getGitMasterTreeForFamily(familyData.name)
              ;

            return Promise.all([familyData, commit, treePromise, rootTreePromise, masterFamilyTreePromise, filesPrefix]);
        })
        // args = [familyData, commit, tree, rootTree, masterFamilyTree, filesPrefix]
        .then(args=>this._collectDataGit(...args))// -> [filesData, metadata, path, familyName]
        ;
};

_p._prepareAndDispatchGit = function(familyData, reference) {
    return this._getGitData(familyData, reference) // -> args: [filesData, metadata, path, asFamilyName]
        .then(args=>this._dispatchFilesData(...args))// -> a promise to track when it's done, value not relevant
        .then(null, err=>{
            let [path, ] = familyData.fontFilesLocation
              , message = ['Can\'t dispatch path "' + path + '" for'
                          , familyData.name , 'derrived from fontfilesPrefix:'
                          , familyData.fontfilesPrefix
                          ].join(' ')
              ;
            this._reportFamily(familyData.name, 'failed'
                                , '(_prepareAndDispatchGit): ' + err
                                 + '\n' + message);

            this._log.error(message, err);
            throw err;
        });
};

_p._prepareAndDispatchGits = function(families_referencePromises) {
    var gitUpdatingPromises = [];
    for (let [familyData, referencePromise] of families_referencePromises) {
        // referencePromise doesn't seem to have an error handler attached!
        // if it rejects it won't be passed to _prepareAndDispatchGit
        gitUpdatingPromises.push(referencePromise.then(
                 this._prepareAndDispatchGit.bind(this, familyData)));
    }
    return gitUpdatingPromises;
};

_p._update = function(csvData) {
    // depends on the result of parseCSV
    var updating = []
      , gitFamilies = []
      ;

    for(let familyData of csvData.values()) {
        let familyName = familyData.name;
        if(this._familyWhitelist && !this._familyWhitelist.has(familyName)) {
            // TODO: maybe only report the whitelist once.
            // Much less noise! and it can be used as a tool to only update
            // selected families (e.g. just one)
            this._reportFamily(familyName,'skipped', 'Not whitelisted.');
            continue;
        }
        // FIXME: Take care of cleaning up!
        //        repoType could have changed between updates, is that a
        //        problem we need to take care of?
        if(familyData.repoType === 'git')
            gitFamilies.push(familyData);
        else {
            this._reportFamily(familyName,'skipped', 'Unknown repoType: ' + familyData.repoType);
            this._log.debug('Skipping:',  familyName, 'unknown repoType:', familyData.repoType);
        }
    }
    let fetchingingGits = zip(gitFamilies, this._fetchGits(gitFamilies))
      , dispatchingGits = this._prepareAndDispatchGits(fetchingingGits)
      ;
    // When/if we add support for other repo types, they will be added to
    // `updating` as well. But currently we only update git repos.
    updating.push(...dispatchingGits);
    this._lastAPIData = csvData;
    return this._waitForAll(updating);
};

_p.update = function() {
    // download the CSV file
    this._reportAdd(
          'md'
        , '## Start update.'
        , true /*initial entry*/
        );

    var  promise
      , finallyFunc = () => {
            this._reportFlush('update');
            this._familyReportTable = null;
        }
      ;

    promise = this._downloadCSVData(true)// -> instance of CSVData
        .then(csvData=>{
            this._reportAdd('table', {
                caption: 'CSV Data Import'
              , firstRowIsHead: true
              , firstColumnIsHead: true
              , data: csvData.report
            });

            this._familyReportTable = [['Family Name', 'Status', 'Message']];
            this._reportAdd('table', {
                caption: 'Family Updates'
              , firstRowIsHead: true
              , firstColumnIsHead: true
              , data: this._familyReportTable
            });

            return csvData;
        })
        .then(this._update.bind(this /* csvData */ ))
        .then(null, error=>{
            // this doesn't always mean it failed completely, just that
            // at least one family failed
            this._reportAdd('md', '## At least one family failed! '
                          + error +'\n\n' + '```'+error.stack+'```');
            throw error; // re-raise
        });
        // when ".finally" is available
        // return promise.finally(finallyFunc);
        promise.then(finallyFunc, finallyFunc); // no need to return this
        return promise;
};

_p.list = function() {
    // `force` could be an argument of this interface, for the caller
    // to decide whether to get a brand new list or maybe one that is
    // maybe a bit outdated. However, the use case here is currently
    // to show the list in a web facing user interface, where using
    // the cached version is suitable.
    var force = false;
    return this._downloadCSVData(force).then(csvData=>csvData.list());
};


/**
 * Get one family "package" by family name (via ManifestServer as a FamilyData message).
 * The data is the same as the update function dispatches, in this case
 * intended for the release pipeline.
 */
_p.get = function(familyName) {
    // update the csv
    return this._downloadCSVData(true)// -> instance of CSVData
        // get the row of the requested family
        // raises if familyName is not found
        .then(csvData=>csvData.get(familyName)) // -> instance of CSVFamily; raises if familyName doesn't exist
        // get the files
        .then(familyData=>{
            if(familyData.repoType !== 'git')
                throw new Error('Repository is not git.');
            return this._fetchGit(familyData)
                .then(reference=>this._getGitData(familyData, reference));
                // ->  [filesData, metadata, path, familyName]

        })
        .then(([filesData, metadata, path, familyName])=>[familyName, filesData, metadata]);
};


_p.getSourceDetails = function(familyName) {
    return this._downloadCSVData(true)// -> instance of CSVData
        // get the row of the requested family
        // raises if familyName is not found
        .then(csvData=>csvData.get(familyName)) // -> instance of CSVFamily; raises if familyName doesn't exist
        // get the files
        .then(familyData=>familyData.toDictionary());
};


if (typeof require != 'undefined' && require.main==module) {
    var setup = getSetup(), sources = [], server
      , familyWhitelist = setup.develFamilyWhitelist
      , repoPath = './git-repositories'
      // TODO: should be configured via setup
      // This is the production data
      //, sheetCSVUrl = 'https://docs.google.com/spreadsheets/d/1ampzD9veEdrwUMkOAJkMNkftqtv1jEygiPR0wZ6eNl8/pub?gid=0&single=true&output=csv'
      // this is the development version
      , sheetCSVUrl = 'https://docs.google.com/spreadsheets/d/1ODnp-yRYw1LrI3RTX-VZZsigPPieviE954sOsrlcx5o/pub?gid=0&single=true&output=csv'
      // NOTE: temporary local copy for development can be specified like.
      //, sheetCSVUrl = 'file://upstream-sources.csv'
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

    setup.logging.log('Loglevel', setup.logging.loglevel);
    if(familyWhitelist)
        setup.logging.debug('FAMILY_WHITELIST:', familyWhitelist);
    // the prod api

    // Could be used in local development to reduce environment complexity
    // setup.reports = null;
    // setup.cache = null;

    sources.push(new CSVSpreadsheet(setup.logging, 'upstream', repoPath
                            , sheetCSVUrl, familyWhitelist, setup.reports));

    // NOTE: this was used for development.
    // let _queues = new Map()
    //   , { AsyncQueue } = require('../util/ManifestServer')
    //   , _queue = function (name, job) {
    //         var job_, name_, queue;
    //
    //         [job_, name_] = typeof name === 'function'
    //                         ? [name, 'default']
    //                         : [job, name]
    //                         ;
    //
    //         queue = _queues.get(name_);
    //         if(!queue) {
    //             queue = new AsyncQueue();
    //             _queues.set(name_, queue);
    //         }
    //         return queue.schedule(job_);
    //     }
    // ;
    // sources[0].setQueue(_queue);
    // sources[0].update()
    //           .then(res=>console.log('rRREsslut!>>> entries:', res, 'total', res.length)
    //                 , console.warn.bind(console, 'F*** YOU LASSE!'));

    server = new ManifestServer(
            setup.logging
          , 'CSVSpreadsheet'
          , sources
          , grpcPort
          , setup.cache
          , setup.amqp
    );
    server.serve()
        //.then(()=>server.updateAll())
        .then(()=>setup.logging.warning('activate: `server.updateAll()`'))
        .then(
              ()=>setup.logging.info('Server ready!')
            , error=>{
                setup.logging.error('Can\'t initialize server.', error);
                process.exit(1);
            }
        );
}
