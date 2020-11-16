#! /usr/bin/env node
"use strict";
/* jshint esnext:true, node:true */

/**
 * Usage:
 * $ node node/MaintenanceServer.js suspended-note.html
 * Where "suspended-note.html" must be located in "browser/html/"
 */
const path = require('path')
  , ROOT_PATH = __dirname.split(path.sep).slice(0, -1).join(path.sep)
  , express = require('express')
  , http = require('http')
  ;

if (typeof require != 'undefined' && require.main==module) {
    var app = express()
      , portNum = 3000
      , httpServer
      , maintenanceFile = process.argv[process.argv.length-1]
      , maintenancePage = `browser/html/${maintenanceFile}`
      ;

    app.get('/',     (req, res, next) => {
        // jshint unused:vars
        return res.sendFile(maintenancePage, {root: ROOT_PATH});
    });
    app.use('/browser', express.static('browser'));
    app.get('/*',     (req, res, next) => {
        // jshint unused:vars
        //503 Service Unavailable
        res.status(503);
        return res.sendFile(maintenancePage, {root: ROOT_PATH});
    });

    httpServer = http.createServer(app);
    httpServer.listen(portNum);
    console.log(`Maintenance Server... port: ${portNum} serving: ${maintenancePage}`)
}
