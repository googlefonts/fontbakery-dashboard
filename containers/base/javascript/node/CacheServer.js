#! /usr/bin/env node
"use strict";
// this is expected to run in nodejs
/* global require, module */
/* jshint esnext:true */

const getSetup = require('./util/getSetup').getSetup
  , { CacheServer } = require('./util/StorageServers')
  ;

/**
What we want:

A) POST Files: returns an identifier where to GET Files
B) GET Files:
C) PURGE Files

use gRPC

Files is one "Family" of TTF files and metadata. Ideally we don't even look into the serialized message

There's probably a client-id in this message, so that the client can identify the answer
I guess gRPC has something buildin for us ;-)

Post Files can actually post a stream of files, which will conclude a whole collection
The answer then is a stream of identifiers that can be used to GET or PURGE the files

If you post the same Files twice, you got to PURGE the same file twice (unless force===true)

TODO: let's say a job died and is never going to PURGE. We need some
automatic cache invalidation (time based?), maybe pick something from
here: https://en.wikipedia.org/wiki/Cache_replacement_policies

TODO: paralell cache instances, that talk to each other for replcation
      if speed or memory size becomes a problem?

TODO: some form of persistence, if the pod dies, so that the cache still
      has its state after being up again.
*/

if (typeof require != 'undefined' && require.main==module) {
    var setup = getSetup(), cacheServer, port=50051
        // Keep entries for 24 hours, this timeout ensures the CacheServer
        // won't run out of memory BUT it expects that the client will
        // consume the data in a timely manner. So, if we don't have enough
        // workers for a big job, eventually we'll have failing jobs because
        // the cache cleaned up itself ...
        // To avoid this cleaning up, don't define dataItemTimeOutMinutes
      , dataItemTimeOutMinutes = 24 * 60
      ;

    for(let i=0,l=process.argv.length;i<l;i++) {
        if(process.argv[i] === '-p' && i+1<l) {
            let foundPort = parseInt(process.argv[i+1], 10);
            if(foundPort >= 0) // not NaN or negative
                port = foundPort;
            break;
        }
    }
    setup.logging.info('Init server, port: '+ port +' ...');
    setup.logging.log('Loglevel', setup.logging.loglevel);
    cacheServer = new CacheServer(setup.logging, port, dataItemTimeOutMinutes);
    cacheServer.serve();
}
