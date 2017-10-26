#! /usr/bin/env node
"use strict";
// this is expected to run in nodejs
/* jshint esnext:true */


function Logging(loglevel) {
    this._numericLoglevel = this._levels[loglevel] || 0;
    this._loglevel = loglevel;
}

var _p = Logging.prototype;

Object.defineProperty(_p, 'loglevel', {
    get: function() {
      return this._loglevel;
    }
});

_p.log = console.log;

([
    ['DEBUG', 10, console.info]
  , ['INFO', 20, console.info]
  , ['WARNING', 30, console.warn]
  , ['ERROR', 40, console.error]
  , ['CRITICAL', 50, console.error]
]).forEach(function(setup) {
    // method names: debug, info, warning, etc..
    var loglevel = setup[0]
      , method = loglevel.toLowerCase()
      , numeric = setup[1]
      , log = setup[2]
      ;
    _p._levels[loglevel] = numeric;
    _p[method] = function() {
        if(numeric < this._numericLoglevel)
            return;
        var args = [loglevel], i, l;
        for(i=0,l=arguments.length;i<l;i++)
            args.push(arguments[i]);
        log.apply(null, args);
    };
});
exports.Logging = Logging;
