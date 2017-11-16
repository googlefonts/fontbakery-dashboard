#! /usr/bin/env node
"use strict";
// this is expected to run in nodejs
/* global require, module */
/* jshint esnext:true */

const { _Source } = require('./_Source')
  , Parent = _Source
  , { ManifestServer } = require('../util/ManifestServer')
  , { getSetup } = require('../util/getSetup')
  , https = require('https')
  , http = require('http')
  , url = require('url')
  ;

function GoogleFonts(logging, id, apiDataUrl, familyWhitelist) {
    this._log = logging;
    this._apiAPIDataUrl = apiDataUrl; // contains api key
    this._lastAPIData = null;
    this.id = id;
    this._familyWhitelist = familyWhitelist;
    Parent.call(this);
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
_p.update = function(forceUpdate) {
    // download the API JSON file

    return downloadAPIData(this._apiAPIDataUrl)
        .then(this._update.bind(this, forceUpdate /* Map apiData */ ))
        ;
};

_p._update = function(forceUpdate, apiData) {
    var dispatchFamily, updating = [];

    for(let familyData of apiData.values()) {

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
