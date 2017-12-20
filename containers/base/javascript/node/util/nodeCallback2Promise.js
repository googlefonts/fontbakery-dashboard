#! /usr/bin/env node
"use strict";
// this is expected to run in nodejs
/* jshint esnext:true */


// Turn node callback style into a promise style
function nodeCallback2Promise(func/* args */) {
    var args = [], i, l;
    for(i=1,l=arguments.length;i<l;i++)
        args.push(arguments[i]);

    return new Promise(function(resolve, reject) {
        // callback is the last argument
        args.push(function(err, result) {
            if(err) reject(err);
            else resolve(result);
        });
        func.apply(null, args);
    });
}

exports.nodeCallback2Promise = nodeCallback2Promise;
