#! /usr/bin/env node
"use strict";
// this is expected to run in nodejs
/* global require, module */
/* jshint esnext:true */

const { _Source: Parent } = require('./_Source')
  , { ManifestServer } = require('../util/ManifestServer')
  , { getSetup } = require('../util/getSetup')
  , { nodeCallback2Promise } = require('../util/nodeCallback2Promise')
  , https = require('https')
  , http = require('http')
  , fs = require('fs')
  , url = require('url')
  , { status: grpcStatus } = require('grpc')
  , yauzl = require('yauzl')
  ;

function GoogleFonts(logging, id, apiDataUrl, downloadFamilyUrl
                                      , familyWhitelist, reportsSetup) {
    this._apiAPIDataUrl = apiDataUrl; // contains api key
    this._downloadFamilyUrl = downloadFamilyUrl;
    this._familyWhitelist = familyWhitelist;
    Parent.call(this, logging, id, reportsSetup);
}

var _p = GoogleFonts.prototype = Object.create(Parent.prototype);

const variant2styleName = {
     '100': 'Thin'
   , '100italic': 'ThinItalic'
   , '200': 'ExtraLight'
   , '200italic': 'ExtraLightItalic'
   , '300': 'Light'
   , '300italic': 'LightItalic'
   , 'regular': 'Regular'
   , 'italic': 'Italic'
   , '500': 'Medium'
   , '500italic': 'MediumItalic'
   , '600': 'SemiBold'
   , '600italic': 'SemiBoldItalic'
   , '700': 'Bold'
   , '700italic': 'BoldItalic'
   , '800': 'ExtraBold'
   , '800italic': 'ExtraBoldItalic'
   , '900': 'Black'
   , '900italic': 'BlackItalic'
};

function _familyName2FileName(familyName) {
    return familyName.replace(/ /g, '');
}

function makeFontFileName(familyName, variant) {
    return [
          _familyName2FileName(familyName)
        , '-'
        , variant2styleName[variant]
        ,'.ttf'
    ].join('');
}


function _readStream2Uint8Array(stream, resolve, reject) {
        var data = [ ];
        stream.on('data', function(chunkBuffer) {
            data.push(chunkBuffer);
        });
        stream.on('end', function() {
            resolve(new Uint8Array(Buffer.concat(data)));
        });
        stream.on('error', function(err) {
            reject(err);
        });
}
function _dataFromStream(stream) {
    return new Promise(_readStream2Uint8Array.bind(null, stream/* resolve, reject*/));
}

function download(fileUrl) {
    var protocol = fileUrl.split('://', 1)[0];
    if(protocol.startsWith('http')) {
        var httpx = protocol === 'https' ? https : http;
        return new Promise((resolve/*, reject*/)=>httpx.get(url.parse(fileUrl), resolve))
        .then(stream=>{
            var { statusCode } = stream;
            if (statusCode !== 200) {
                var error = new Error(`Request Failed.\nStatus Code: ${statusCode}`
                               +` at URL: ${fileUrl}`);
                if(statusCode === 404) {
                    error.code = grpcStatus.NOT_FOUND;
                    error.name = 'NOT_FOUND';
                }
                throw error;
            }
            return _dataFromStream(stream);
        });
    }
    else if(protocol === 'file')
        return _dataFromStream(fs.createReadStream(fileUrl.slice('file://'.length)));
    else
        throw new Error('Don\'t know how to handle file url "'+fileUrl+'"; '
                + 'it should start with "http://", "https://" or "file://".');
}

function download2JSON(uint8arr) {
    return JSON.parse(Buffer.from(uint8arr).toString());
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


// FIXME: I think we should cache this, for at least 5 Minutes
// The API changes seldomly.
function downloadAPIData(url) {
    return download(url)
            .then(download2JSON)
            .then(apiData2Map)
            ;
}

_p._getDownloadFamilyUrl = function(familyName) {
    return this._downloadFamilyUrl.replace('$FAMILYNAME', encodeURIComponent(familyName));
};

//getZipFile(fileUrl).then(zf=>zipFile = zf);
//download(fileUrl).then(d=>zipdata=d);
//_loadZipFile(zipdata).then(zf=>zipFile=zf);
//p = _zipFileGetFiles(zipFile).then(r=>files=r, errr=>console.Error('onZipFile:', errr))

function _loadZipFile(zipData) {
    return nodeCallback2Promise(yauzl.fromBuffer, Buffer.from(zipData), {lazyEntries: true});
}
function _downloadZipFile(fileUrl) {
    return download(fileUrl)
    .then(
        _loadZipFile
      , err=>{
            console.error(err);
            throw err;
    });
}

function _zipFileOnEntry(zipFile, promises, entry) {
    if (/\/$/.test(entry.fileName)) {
        // Directory file names end with '/'.
        // Note that entires for directories themselves are optional.
        // An entry's fileName implicitly requires its parent directories to exist.
        // pass;
    } else {
        // file entry
        promises.push(
            nodeCallback2Promise(zipFile.openReadStream.bind(zipFile), entry)
                .then(_dataFromStream)
                .then(data=>[entry.fileName, data])
        );
    }
    zipFile.readEntry();
}

function _zipFileGetFiles(zipFile) {
    return new Promise((resolve, reject)=>{
        var promises = [];
        zipFile.on('entry', _zipFileOnEntry.bind(null, zipFile, promises));
        zipFile.on('error', reject);
        zipFile.on('end', ()=>resolve(Promise.all(promises)));
        zipFile.readEntry();
    });
}

const licenseFiles2Dirs = new Map([
        ['UFL.txt', 'ufl']
      , ['OFL.txt', 'ofl']
        // this is last because the UFL font's also have a LICENSE.txt
      , ['LICENSE.txt', 'apache']
]);

_p._loadFamily = function(familyName) {
    var url = this._getDownloadFamilyUrl(familyName);
    return _downloadZipFile(url)
    .then(_zipFileGetFiles)
    .then(files=>{
        let fonts = []
          , other = new Map()
          ;
        for(let file of files) {
            let [name, data] = file;
            if(name.endsWith('.ttf'))
                fonts.push(file);
            else
                other.set(name, data);
        }
        return [fonts, other];
    })
    .then(([fonts, other])=>{
            // unfortunately, we don't get all information from the API
            // FIXME: these files should be added eventually, ideally
            // without looking at the google/fonts repo! Right now progressing
            // without this data is OK.

            // TODO: create(!?) and add METADATA.pb
            // https://github.com/googlefonts/tools has a lot related code
            // files.push(['METADATA.pb', Uint8Array]); // serialize this in the human readable form

            // maybe we can just use a placeholder content like 'N/A' this data
            // is hard to come by when not using the googlefonts/tools repo
            // files.push(['DESCRIPTION.en_us.html', Uint8Array]);
        var files = [...fonts]
          , familyDirName = familyName.toLowerCase().replace(/ /g, '')
          , licenseDir = 'unknown_license'
          , baseDir
          ;
        for(let name of other.keys()) {
            licenseDir = licenseFiles2Dirs.get(name);
            if(!licenseDir)
                continue;
            files.push([name, other.get(name)]);
            break;
        }
        baseDir = `${licenseDir}/${familyDirName}`;
        return [baseDir, files];
    });
};

// Was used instead of _loadFamily I keep it because it has some
// useful knowledge how the API works and documents the makeFontFileName
// usage.
_p._loadFontsFromFamilyData = function(familyData) {
    var files = [];
    // download the files
    for(let variant in familyData.files) {
        let fileUrl = familyData.files[variant]
          // make proper file names
          , fileName = makeFontFileName(familyData.family, variant)
          ;
        files.push(download(fileUrl).then(blob => [fileName, blob])); // jshint ignore:line
    }


    /**
    // FIXME: these files should be added eventually, ideally
    // without looking at the google/fonts repo! Right now progressing
    // without this data is OK.

    // augment the API data...
    // unfortunately, we don't get all information from the API
    // TODO: create(!) and add METADATA.pb
    // https://github.com/googlefonts/tools has a lot related code
    files.push(['METADATA.pb', Uint8Array]); // serialize this in the human readable form

    // maybe we can just use a placeholder content like 'N/A' this data
    // is hard to come by when not using the googlefonts/tools repo, but
    // not so essential as well
    files.push(['DESCRIPTION.en_us.html', Uint8Array]);

    // We could use one of the fonts to extract the license type
    // and the Copyright text and then use templates with that information
    files.push([LicenseFile, Uint8Array]);
    // => filesData
    */
    return Promise.all(files);
};

// Runs immediately on init. Then it's called via the poke interface.
// There's no scheduling in the ManifesrSource itself.
_p.update = function() {
    // download the API JSON file

    return downloadAPIData(this._apiAPIDataUrl)
        .then(this._update.bind(this /* Map apiData */ ))
        ;
};

_p._update = function(apiData) {
    var updating = [];

    for(let familyData of apiData.values()) {
        let familyName = familyData.family;

        if(this._familyWhitelist && !this._familyWhitelist.has(familyName))
            continue;

        updating.push(
            this._loadFamily(familyName) // -> [baseDir, filesData]
                // Including familyData as metadata, leaves a
                // trail for documentation.
                .then(([baseDir, filesData])=>this._dispatchFamily(  // jshint ignore:line
                        familyName
                      , baseDir
                      , filesData
                      , familyData)
                )
        );
    }
    return this._waitForAll(updating);
};

_p.get = function(familyName) {
    // familyName from the API is with spaces i.e. "Aguafina Script"
    // to be fair, the family name in the spreadsheet source is the same
    return downloadAPIData(this._apiAPIDataUrl)
    .then(apiData=>{
        var familyData = apiData.get(familyName);
        if(!familyData) {
            var error = new Error('No family found for "' + familyName + '".');
            error.code = grpcStatus.NOT_FOUND;
            error.name = 'NOT_FOUND';
            throw error;
        }
        return familyData;
    })
    .then(familyData=>Promise.all([
          familyName
        , this._loadFamily(familyName) // [baseDir, filesData -> [[name, blob], [name, blob], ...]]
        , familyData]))
    .then(([familyName, [baseDir, filesData], familyData])=>[familyName, baseDir, filesData, familyData])
    ;
    // -> [familyName, baseDir, filesData, metadata]
};

if (typeof require != 'undefined' && require.main==module) {
    var setup = getSetup(), sources = [], server
       , familyWhitelist = setup.develFamilyWhitelist
       , apiDataBaseUrl = 'https://www.googleapis.com/webfonts/v1/webfonts?key='
       , apiDataUrl = apiDataBaseUrl + setup.googleAPIKey
       , downloadFamilyUrl = 'https://fonts.google.com/download?family=$FAMILYNAME'
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

    sources.push(new GoogleFonts(setup.logging, 'production', apiDataUrl, downloadFamilyUrl, familyWhitelist));
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
