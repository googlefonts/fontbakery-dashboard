#! /usr/bin/env node
"use strict";
// this is expected to run in nodejs
/* jshint esnext:true */

const Logging = require('./Logging').Logging;

function getSetup() {
    var rethinkSetup = {
            host: null
          , port: null
          , db: 'fontbakery'
        }
      , amqpSetup = {
            host: process.env.RABBITMQ_SERVICE_SERVICE_HOST
                        || process.env.BROKER
                        || 'amqp://localhost'
        }
      , cacheSetup = {
            // call it: "fontbakery-cache"
            host: process.env.FONTBAKERY_CACHE_SERVICE_HOST
          , port: process.env.FONTBAKERY_CACHE_SERVICE_PORT
        }
      , logging = new Logging(process.env.FONTBAKERY_LOG_LEVEL || 'INFO')
      ;

    if(process.env.RETHINKDB_PROXY_SERVICE_HOST) {
        // in gcloud, we use a cluster with proxy setup
        // the proxy service is called: "rethinkdb-proxy" hence:
        rethinkSetup.host = process.env.RETHINKDB_PROXY_SERVICE_HOST;
        rethinkSetup.port = process.env.RETHINKDB_PROXY_SERVICE_PORT;
    }
    else {
        // Fall back to "rethinkdb-driver"
        rethinkSetup.host = process.env.RETHINKDB_DRIVER_SERVICE_HOST;
        rethinkSetup.port = process.env.RETHINKDB_DRIVER_SERVICE_PORT;
    }

    return {
        amqp: amqpSetup
      , rethink: rethinkSetup
      , cache: cacheSetup
      , logging: logging
    };
}

exports.getSetup = getSetup;
