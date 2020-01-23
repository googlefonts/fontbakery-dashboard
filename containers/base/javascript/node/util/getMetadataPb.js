#! /usr/bin/env node
"use strict";
// this is expected to run in nodejs
/* jshint esnext:true */

/**
 * Protocol Buffer text format parsing in JavasSript is not supported
 * by https://github.com/google/protobuf.
 * There's a node package not using the google libraries:
 * "protobuf-textformat" but it failed with the first METADATA.pb file
 * I gave it.
 * This is a crude workaround, but it should be a solid one.
 */
const { spawn } = require('child_process')
    , { FamilyProto } = require('protocolbuffers/fonts_public_pb')
// > START INLINE PYTHON SCRIPT
// needs: $ pip install git+https://github.com/googlefonts/gftools.git@master
// sys.argv[1] is the unicode text content of a METADATA.pb file
    , PYTHON_PARSE_FAMILY_PROTO = `
import sys
import gftools.fonts_public_pb2 as fonts_pb2
from google.protobuf import text_format
msg = fonts_pb2.FamilyProto()
text_format.Merge(sys.argv[1], msg)
sys.stdout.buffer.write(msg.SerializeToString())
`// < END INLINE PYTHON SCRIPT
// > START INLINE PYTHON SCRIPT
// sys.stdin returns the binary serialization of a FamilyProto Message
// i.e.: `Buffer.from(processCommand.serializeBinary())`
    , PYTHON_SERIALIZE_FAMILY_PROTO = `
import sys
import gftools.fonts_public_pb2 as fonts_pb2
from google.protobuf import text_format
msg = fonts_pb2.FamilyProto()
msg.ParseFromString(sys.stdin.buffer.read())
sys.stdout.write(text_format.MessageToString(msg))
`// < END INLINE PYTHON SCRIPT
    , fs = require('fs')
    , tmp = require('tmp')
    , path = require('path')
    , { nodeCallback2Promise } = require('./nodeCallback2Promise')
    // /var/gftools is the default for the fontbakery-dashboard docker image
    , GFTOOLS_DIR = process.env.FONTBAKERY_GFTOOLS_DIR || '/var/gftools'
    , ADD_FONTS_SCRIPT = GFTOOLS_DIR + '/bin/gftools-add-font.py'
    , ADD_FONTS_NAM_DIR = GFTOOLS_DIR + '/encodings'
    ;

/**
 * Returns a FamilyProto message instance.
 *
 * metadataPbTxt: the contents of a METADATA.pb file, which is a
 * google.fonts.FamilyProto serialized as protocol buffer text format.
 */
function parseMetadata(metadataPbTxt) {
    var py = spawn('python3', ['-c', PYTHON_PARSE_FAMILY_PROTO, metadataPbTxt])
       , stderr = []
       , stdout = []
       ;
    return new Promise((resolve, reject)=> {
                                     // data is a Buffer
        py.stdout.on('data', (data)=>stdout.push(data));
        py.stderr.on('data', (data) => {
            var strData = data.toString();
            stderr.push(strData);
            // This may also end in the rejection message if the closing
            // code is not zero. But, if the code is zero, we still want
            // to log this.
            console.warn(strData);
        });

        py.on('close', (code) => {
            if(code !== 0) {
                // if there's a non 0 code reject
                reject(new Error('getMetadata python closed with a none zero'
                    + ' code: "'+code+'";'
                    + (stderr.length
                                ? '\nSTDERR>\n' + stderr.join('')
                                : '')
                    ));
                return;
            }
            var metadataBlob = new Uint8Array(Buffer.concat(stdout));
            try {
                let familyProto = FamilyProto.deserializeBinary(metadataBlob);
                resolve(familyProto);
            }
            catch(error) {
                reject(error);
            }
        });
    });
}

exports.parseMetadata = parseMetadata;

/**
 * return the METADATA.pb contents as a string
 */
function serializeMetadata(familyProtoMessage) {
    var buffer = Buffer.from(familyProtoMessage.serializeBinary())
      , py = spawn('python3', ['-c', PYTHON_SERIALIZE_FAMILY_PROTO, buffer])
      , stderr = []
      , stdout = []
      ;
    return new Promise((resolve, reject)=> {
                                     // data is a Buffer
        py.stdout.on('data', (data)=>stdout.push(data));
        py.stderr.on('data', (data) => {
            var strData = data.toString();
            stderr.push(strData);
            // This may also end in the rejection message if the closing
            // code is not zero. But, if the code is zero, we still want
            // to log this.
            console.warn(strData);
        });

        py.on('close', (code) => {
            if(code !== 0) {
                // if there's a non 0 code reject
                reject(new Error('serializeMetadata python closed with a none zero'
                    + ' code: "'+code+'";'
                    + (stderr.length
                                ? '\nSTDERR>\n' + stderr.join('')
                                : '')
                    ));
                return;
            }
            try {
                let metadataPbTxt = new Uint8Array(Buffer.concat(stdout));
                resolve(metadataPbTxt);
            }
            catch(error) {
                reject(error);
            }
        });
        py.stdin.write(buffer, err=>{
            if(err)
                reject(err);
            py.stdin.end();
        });
    });
}

exports.serializeMetadata = serializeMetadata;


function getTmpDir(options) {
    return new Promise((resolve, reject)=>{
        tmp.dir(options||{}, (err, path, cleanupCallback)=>{
            if(err) reject(err);
            else resolve({path, cleanupCallback});
        });
    });
}

function pythonCreateMetadata(filesPath) {
    var args = []
       , py
       , stderr = []
       , stdout = []
       , metadataFile = [filesPath, 'METADATA.pb'].join('/')
       ;

    args.push(ADD_FONTS_SCRIPT);
    args.push(filesPath);

    // this doesn't work because the ADD_FONTS_SCRIPT complains about
    // the number of arguments:
    // "One argument, a directory containing a font family"
    // args.push('--nam_dir="'+ADD_FONTS_NAM_DIR+'"')
    // Thus, changing cwd and going with the default location... "./encodings"
    py = spawn('python3', args, {cwd: path.dirname(ADD_FONTS_NAM_DIR)});

    return new Promise((resolve, reject)=> {
        // both stdout and stderr are just printed
        py.stdout.on('data', (data)=>{
            var strData = data.toString();
            stdout.push(strData);
            console.log(strData);
        });
        py.stderr.on('data', (data)=>{
            var strData = data.toString();
            stderr.push(strData);
            // This may also end in the rejection message if the closing
            // code is not zero. But, if the code is zero, we still want
            // to log this.
            console.warn(strData);
        });
        py.on('close', (code) => {
            if(code !== 0) {
                // if there's a non 0 code reject
                reject(new Error('pythonCreateMetadata python closed with a none zero'
                    + ' code: "'+code+'";'
                    + (stderr.length
                                ? '\nSTDERR>\n' + stderr.join('')
                                : '')
                    ));
            }
            else {
                nodeCallback2Promise(fs.readFile, metadataFile)
                    .then(buffer=>resolve(new Uint8Array(buffer)), reject);
            }
        });
        py.on('error', error=> reject(error));
    });
}


function createMetadata(filesData, licenseDir) {
        // build a tmp directory
    var tmpDir = null
      , resultPromise = getTmpDir({unsafeCleanup:true})
    .then(tmp=>{
        // add all files
        tmpDir = tmp;// set outer scope;
        tmp.fontsPath = [tmp.path, licenseDir].join('/');
        return nodeCallback2Promise(fs.mkdir, tmp.fontsPath)
        .then(()=>{
            var fileWrites = [];
            for(let [name, data] of filesData) {
                let file = [tmp.fontsPath, name].join('/');
                // data can be an <Uint8Array> directly, profit!
                fileWrites.push(nodeCallback2Promise(fs.writeFile, file, data));
            }
            return Promise.all(fileWrites);
        })
        .then(()=>tmp);
    })
    .then(tmp=>pythonCreateMetadata(tmp.fontsPath));// -> <Uint8Array>:data

    // finally delete the tmp directory
    function finallyFunc() {
        if(tmpDir)
            tmpDir.cleanupCallback();
    }
    resultPromise.then(finallyFunc, finallyFunc);

    // return the METADATA.pb contents as <Uint8Array>
    return resultPromise;
}

exports.createMetadata = createMetadata;
