#! /usr/bin/env node
"use strict";
// this is expected to run in nodejs
/* global require, module */
/* jshint esnext:true */

/**
 * TODO: I put this currently in here because I'm on an airplane and want
 * to resuse this docker image and probably some code as well. But,
 * this service should be separated from this image eventually. We'll
 * need a way to share some code though, maybe a `shared` lib via a symlink
 * that's then copied in the Dockerfiles.
 */


const serverExports = require('./main.js')
  // FIXME: make a common codebase for shared code
  // in this case an author of main.js may change the behavior of these
  // functions without checking here.
  // THOUGH: messaging will also change to be ProtoBuf based
  , { getSetup, initDB, initAmqp } = require('./util/getSetup')
  , mergeArrays = serverExports.mergeArrays
  , fs = require('fs')
  , StringDecoder = require('string_decoder').StringDecoder
  , express = require('express')
  , http = require('http')
  ;

function Collectiontester(logging, portNum, amqpSetup, dbSetup) {
    this._log = logging;
    this._portNum = portNum;

    this._dbSetup = dbSetup;
    this._r = null;
    this._amqp = null;
    // this requests to start a collection wide test run.
    this._initQueueName = 'init_collecton_test_queue';
    // use this to shamelessly reuse the existing workers
    // NOTE: one problem could become that we'll have like up to
    // 6 times of the collections font size on the amqp queue, this will
    // likely become a bottleneck/memory problem.
    // but it is the fastest way to proceed. I thought about a kind of
    // file service where we can get the files directly, that should help
    // keep the queues working.
    this._dispatchQueueName = 'fontbakery-worker-distributor';

    this._app = express();
    this._server = http.createServer(this._app);



    // I'll copy this from my harddrive and don't do any updates now.
    // I'm on an airplane, data is expensive!
    this._fontsRepositoryPath = '/var/fonts';

    // Start serving when the database and rabbitmq queue is ready
        Promise.all([
                 initDB(this._log,dbSetup)
               , initAmqp(this._log, amqpSetup)
               ])
    .then(function(resources){
        this._r = resources[0];
        this._amqp = resources[1];
    }.bind(this))
    .then(this._listen.bind(this))
    .catch(function(err) {
        this._log.error('Can\'t initialize.', err);
        process.exit(1);
    }.bind(this));

    this._app.get('/family/filenames/:licensedir/:family', this.getFamilyFilenames.bind(this));
    this._app.get('/family/files/:licensedir/:family', this.getFiles.bind(this));
}

var _p = Collectiontester.prototype;

_p._query = function(dbTable) {
    return this._r.table(dbTable);
};

// unused, reminder
_p._updateGIT = function() {
    // TODO: this is a placehoder to remind us that we should test the
    // requested version of the repository.
};

// return all family directories in one array
// eg: [ "apache/droidsans"
//     , "ofl/merriweather"
//     , "ofl/nunito"
//     , "ufl/ubuntu"
//     , ... etc.
//     ]
_p._fetchFamilies = function() {
    var licensdirs = ['ofl', 'apache', 'ufl']
      , i, l, dir
      , promises = []
      ;
    function addFamilyDir(licenseDir, familyDirs) {
        return familyDirs.map(function(familyDir){
                                return [licenseDir, familyDir].join('/');});
    }
    for(i=0,l=licensdirs.length;i<l;i++) {
        dir = [this._fontsRepositoryPath, licensdirs[i]].join('/');
        promises.push(readdir(dir)
                        .then(addFamilyDir.bind(null, licensdirs[i])));
    }

    function reduce(arrays) {
        var result = [], i, l;
        for(i=0,l=arrays.length;i<l;i++)
            Array.prototype.push.apply(result, arrays[i]);
        return result;
    }
    return Promise.all(promises).then(reduce);
};

// GET /family/filenames/:licensedir/:family'
// returns readdir of familyDir
// TODO: 404 Not Found: if licensedir/family is not in _fontsRepositoryPath
//       400 Bad Request: if licensedir or family are not only alphanumeric
_p.getFamilyFilenames = function(req, res) {
    var path = [this._fontsRepositoryPath, req.params.licensedir
                                            , req.params.family].join('/');
    return readdir(path).then(function(files) {
        res.setHeader('Content-Type', 'application/json');
        res.send(JSON.stringify(files));
    });
};

// GET /family/files/:licensedir/:family
// returns this.getPayload
// TODO: 404 Not Found: if licensedir/family is not in _fontsRepositoryPath
//       400 Bad Request: if licensedir or family are not only alphanumeric
_p.getFiles = function(req, res) {
    // packs the file part the same as the drag and drop does
    var dir = [req.params.licensedir, req.params.family].join('/');
    this.getPayload(dir).then(function(blob) {
        res.setHeader('Content-Type', 'appication/octet-stream');
        res.end(blob, 'binary');
    });
};

function str2Uint8Array(str) {
    // expecting str to be only ASCII chars, because serializing
    // higher unicode is not that straight forward.
    return Uint8Array.from(str,
                            function(chr){ return chr.charCodeAt(0);});
}

// Turn node callback style into a promise style
function nodeCallback2Promise(func/* args */) {
    var args = [], i, l;
    for(i=1,l=arguments.length;i<l;i++)
        args.push(arguments[i]);

    return new Promise(function(resolve, reject) {
        // callback
        args.push(function(err, files) {
            if(err) reject(err);
            else resolve(files);
        });
        func.apply(null, args);
    });
}

function readdir(path) {
    return nodeCallback2Promise(fs.readdir.bind(fs), path);
}

// pack binary data of dir files and filename into a struct
_p.getPayload = function(dir) {
    this._log.debug('getPayload', dir, 'in', this._fontsRepositoryPath);
    // looks the same in the and as an initial drag'n'drop job
    var path = [this._fontsRepositoryPath, dir].join('/');

    function getJobEntry(fileName, fileBuffer) {
        var bytesJson = str2Uint8Array(JSON.stringify(
                                            {filename: fileName}))
            // header, json, font
          , job = [null, bytesJson, fileBuffer]
          , header, i, l
          ;
        header = new Uint32Array(job.length-1);
        // store at the beginning the length of each element
        for(i=1,l=job.length;i<l;i++) {
            header[i-1] = job[i].byteLength;
        }
        job[0] = header;
        return job;
    }

    function getJobEntries (path, fileNames) {
        var jobPromises = []
          , jobPromise
          , i, l
          ;
        for(i=0,l=fileNames.length;i<l;i++) {
            var fileName = fileNames[i];
            jobPromise = getFileBuffer([path,fileName].join('/'))
                            .then(getJobEntry.bind(null, fileName));
            jobPromises.push(jobPromise);
        }

        return Promise.all(jobPromises);
    }

    function packJobEntries(entries) {
        var job = [], i, l;
        for(i=0,l=entries.length;i<l;i++)
            Array.prototype.push.apply(job, entries[i]);
        return mergeArrays(job);
    }

    var getFileNames = readdir;

    function getFileBuffer(path){
        return nodeCallback2Promise(fs.readFile.bind(fs), path);
    }

    return getFileNames(path)
        .then(getJobEntries.bind(null, path))
        .then(packJobEntries);
};

// dispatches message to queueName
_p._sendAMQPMessage = function (queueName, message) {
    var options = {
            // TODO: do we need persistent here/always?
            persistent: true // same as deliveryMode: true or deliveryMode: 2
        }
        ;
    function sendMessage(ok) {
        // jshint validthis:true, unused:vars
        this._log.info('sendToQueue: ', queueName);
        return this.amqp.channel.sendToQueue(queueName, message, options);
    }
    return this.amqp.channel.assertQueue(queueName, {durable: true})
           .then(sendMessage.bind(this))
           ;
};

// calls _sendAMQPMessage with a job that knows familyDir, docid
_p._dispatchJob = function(familyDir, dbResponse) {
    var docid = dbResponse.generated_keys[0]
      , job = {
            // use this to get the filenames/files of the family
            family: familyDir
            // use this to safe the test results
          , docid: docid
          , type: 'collectiontest'
        }
      , message = Buffer.from(JSON.stringify(job), 'utf8')
      ;

    return this._sendAMQPMessage(this._dispatchQueueName, message);
};


// use only by _dispatchDragAndDropStyleJob
_p._packMessage = function  (docid, payload) {
    this._log.debug('_packMessage:', docid);
    var docidArray = str2Uint8Array(docid)
      , docidLen = new Uint32Array(1)
      ;
    docidLen[0] = docidArray.byteLength;
    this._log.debug('docidLen is', docidArray.byteLength
                                                , 'for docid:', docid);

    return mergeArrays([docidLen, docidArray, payload]);
};

// unused:
// like _dispatchJob but loads ttf files into the message (this.getPayload)
_p._dispatchDragAndDropStyleJob = function(familyDir, dbResponse) {
    // this is the report docid NOT the collectiontestId
    var docid =  dbResponse.generated_keys[0]
      , messagePromise = Promise.all([
            docid
          , this.getPayload(familyDir)
           // args = [docid, payload]
        ]).then(this._packMessage.apply.bind(this._packMessage, this))
      ;
    this._log.debug('_dispatchJob', familyDir, 'job docid:', docid);
    return Promise.all([this._dispatchQueueName, messagePromise])
         // like: this._sendAMQPMessage.apply(this, [queueName, message])
        .then(this._sendAMQPMessage.apply.bind(this._sendAMQPMessage, this));

};

// prepare the test document
_p._dbInsertDoc = function(dbTable, doc) {
    return this._query(dbTable).insert(doc)
            .run()
            .error(function(err) {
                this._log.error('Creating a doc failed ', err);
            }.bind(this));
};

// creates job-docid (_dbInsertDoc) to prepare the tests
// calls _dispatchJob with familyDir
_p._comissionFamily = function(collectiontestId, familyDir) {
    this._log.debug('_comissionFamily', collectiontestId, familyDir);
    var doc = {
        created: new Date()
      , family_dir: familyDir
    };
    // very important
    doc[this._dbSetup.tables.collection + '_id'] = collectiontestId;

    return this._dbInsertDoc(this._dbSetup.tables.family, doc)
        .then(this._dispatchJob.bind(this, familyDir))
        // needs .error if dispatchJob fails?
        .catch(function(err) {
            this._log.error('dispatchJob failed ', err);
        }.bind(this));
};

// calls _comissionFamily once per family in families
_p._comissionFamilies = function(collectiontestId, families) {
    this._log.debug('_comissionFamilies', collectiontestId, 'families:', families.length);
    var i, results = []
      , numJobs = families.length
      , maxJobs
      ;

    if('DEVEL_MAX_JOBS' in process.env) {
        maxJobs = parseInt(process.env.DEVEL_MAX_JOBS, 10);
        if(maxJobs !== maxJobs)
            maxJobs = numJobs;
        this._log.info('Environment variable DEVEL_MAX_JOBS is:'
                        , process.env.DEVEL_MAX_JOBS, 'maxJobs is', maxJobs
                        , 'numJobs is', numJobs);
        numJobs = Math.min(maxJobs, numJobs);
    }

    for(i=0;i<numJobs;i++)
        results.push(this._comissionFamily(collectiontestId, families[i]));
    return Promise.all(results);
};

// get's the target collectiontestId via message
// calls _comissionFamilies collectiontestId (_fetchFamilies ) =>
_p._consumeQueue = function(message) {
    var decoder = new StringDecoder('utf8')
      , collectiontestId = JSON.parse(decoder.write(Buffer.from(message.content))).docid
      ;
    this._log.debug('_initJob', collectiontestId);
    this._amqp.channel.ack(message);
    // update git
    this._updateGIT();
    // get all family directories:
    // TODO: write the `started` field to the collectiontestId doc
    return this._fetchFamilies()
        .then(this._comissionFamilies.bind(this, collectiontestId))
        .catch(function(err) {
            this._log.error('Error initializing job:', err);
            // let this to hurt.
            throw err;
        });
};

// start the server
_p._listen = function() {
    this._log.debug('_listen');

    this._server.listen(this._portNum);
    this._log.info('Listening to port', this._portNum);


    function consume(reply) {
        // jshint validthis:true
        return this._amqp.channel.consume(reply.queue, this._consumeQueue.bind(this));
    }
    return this._amqp.channel.assertQueue(this._cleanupQueueName)
        .then(consume.bind(this))
        ;
};

if (typeof require != 'undefined' && require.main==module) {
    var setup = getSetup();
    setup.logging.info('Init server ...');
    setup.logging.log('Loglevel', setup.logging.loglevel);
    new Collectiontester(setup.logging, 3000, setup.amqp, setup.db);
}
