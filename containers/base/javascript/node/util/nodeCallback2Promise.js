#! /usr/bin/env node
"use strict";
// this is expected to run in nodejs
/* jshint esnext:true */


// Turn node callback style into a promise style
function nodeCallback2Promise(func, ...args) {
    return new Promise(function(resolve, reject) {
        function callback(err, result) {
            if(err) reject(err);
            else resolve(result);
        }
        // callback is the last argument
        func(...args, callback);
    });
}

exports.nodeCallback2Promise = nodeCallback2Promise;
