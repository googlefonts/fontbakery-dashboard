#! /usr/bin/env node
"use strict";
// this is expected to run in nodejs
/* global require, module */
/* jshint esnext:true */

const { _Source: Parent } = require('./_Source')
  , { ManifestServer } = require('../util/ManifestServer')
  , { getSetup } = require('../util/getSetup')
  , https = require('https')
  , http = require('http')
  , fs = require('fs')
  , url = require('url')
  ;

function GoogleFonts(logging, id, apiDataUrl, familyWhitelist, reportsSetup) {
    this._apiAPIDataUrl = apiDataUrl; // contains api key
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

function download(fileUrl) {
    function onResult(resolve, reject, res) {
        var data = [ ];
        res.on('data', function(chunkBuffer) {
            data.push(chunkBuffer);
        });
        res.on('end', function() {
            resolve(new Uint8Array(Buffer.concat(data)));
        });
        res.on('error', function(err) {
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


// FIXME: I think we should cache this, for at least 5 Minutes
// The API changes seldomly.
function downloadAPIData(url) {
    return download(url)
            .then(download2JSON)
            .then(apiData2Map)
            ;
}

_p._loadFamily = function(familyData) {
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
            this._loadFamily(familyData) // -> filesData
                // Including familyData as metadata, leaves a
                // trail for documentation.
                .then(filesData=>this._dispatchFamily(familyName, filesData, familyData)) // jshint ignore:line
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
        if(!familyData)
            throw new Error('Not found family by name "'+familyData+'"');
        return familyData;
    })
    .then(familyData=>Promise.all([
          familyName
        , this._loadFamily(familyData) // filesData -> [[name, blob], [name, blob], ...]
        , familyData]))
    ;
    // -> [familyName, filesData, metadata]
};

if (typeof require != 'undefined' && require.main==module) {
    var setup = getSetup(), sources = [], server
       , familyWhitelist = setup.develFamilyWhitelist
       , apiDataBaseUrl = 'https://www.googleapis.com/webfonts/v1/webfonts?key='
       , apiDataUrl = apiDataBaseUrl + setup.googleAPIKey
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
