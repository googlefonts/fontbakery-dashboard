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
    , PYTHON_PARSE_FAMILY_PROTO = `
import sys
import gftools.fonts_public_pb2 as fonts_pb2
from google.protobuf import text_format
msg = fonts_pb2.FamilyProto()
text_format.Merge(sys.argv[1], msg)
sys.stdout.write(msg.SerializeToString())
`;
// < END INLINE PYTHON SCRIPT

/**
 * Returns a FamilyProto message instance.
 *
 * metadataPbTxt: the contents of a METADATA.pb file, which is a
 * google.fonts.FamilyProto serialized as protocol buffer text format.
 */
function parseMetadata(metadataPbTxt) {
    var py = spawn('python', ['-c', PYTHON_PARSE_FAMILY_PROTO, metadataPbTxt])
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
