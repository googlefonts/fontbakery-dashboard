"use strict";
/* jshint esnext:true, node:true*/


/**
 * Making these items unique objects so it's very explicit what is meant.
 */
function StatusCode (status) {
    Object.defineProperty(this, 'status', {
        value: status
      , writable: false
      , enumerable: true
    });
}
StatusCode.prototype.valueOf = function() {
    return this.status;
};

StatusCode.prototype.toString = function() {
    return this.status;
};

const PENDING = new StatusCode('PENDING')
  , OK = new StatusCode('OK')
  , FAILED = new StatusCode('FAILED')
  , LOG = new StatusCode('LOG')
  , statusCodes = new Map(Object.entries({PENDING, OK, FAILED, LOG}))
    // string2statusCode: statusCodes.get(string) => statusCode
    //                    statusCodes.get('FAILED') => FAILED
  , string2statusCode = string=>statusCodes.get(string)
  ;

exports.PENDING = PENDING;
exports.FAILED = FAILED;
exports.OK = OK;
exports.LOG = LOG;
exports.statusCodes = statusCodes;
exports.string2statusCode = string2statusCode;

const Status = (function() {
function Status(
            status/*status item*/
          , details/*string(markdown)*/
          , created/*Date: optional*/
          , data/* losslessly JSON serializable data: optional*/) {
    // FIXME: vaidate types!

    //must be an existing status item
    if(!statusCodes.has(status.toString()))
        throw new Error('`status` "'+status+'" is unknown.');
    this.status = status;

    if(typeof details !== 'string')
        throw new Error('`details` "'+details+'" is not a string "'+(typeof details)+'".');
    this.details = details; // TODO: must be a string

    if(created) {
        // if present must be a valid date
        if(!(created instanceof Date))
            throw new Error('`created` is not an instance of Date "'+created+'".');
        if(isNaN(created.getDate()))
            throw new Error('`created` is an Invalid Date "'+created+'".');
        this.created = created;
    }
    else
        this.created = new Date();
    // for structured data in advanced situations
    this.data = data || null;
}

const _p = Status.prototype;

_p.serialize = function() {
    return {
        status: this.status.toString()
      , details: this.details
                // for use with rethinkDB this can just stay a Date
      , created: this.created //.toISOString()
      , data: this.data
    };
};

/**
 * Just a factory function.
 */
Status.load = function(state) {
    var {
            statusString
          , details
          , created
          , data
        } = state;
    // stateString :must exist, check in here for a better error message
    if(!statusCodes.has(statusString))
        throw new Error('state.status is not a statusCodes key: "'+statusString+'"');

    // rethinkdb can store and return dates as it
    if(typeof created === 'string')
        created = new Date(created);
    return new Status(
        statusCodes.get(statusString)
      , details
      , created
      , data
    );
};

return Status;
})();

exports.Status = Status;
