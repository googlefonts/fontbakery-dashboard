#! /usr/bin/env node
"use strict";
/* jshint esversion:9, node:true */

const { _BaseServer, RootService } = require('../_BaseServer')
  , { GithubOAuthService } = require('../apiServices/GithubOAuth')
  , { StorageDownloadService } = require('../apiServices/StorageDownload')
  , {
        ProcessQuery
      //, ProcessListQuery: ProcessListQueryMessage
      , ProcessCommand
      , ProcessCommandResult
      , DispatcherInitProcess
      , AuthorizedRolesRequest
      , SessionId
      , AuthStatus
    } = require('protocolbuffers/messages_pb')
  , { Path } = require('./framework/Path')
  ;

/**

const UiApi = (function() {

function UiApi(){}
const _p = UiApi.prototype;

// This kind of interaction either is coupled to a socket based communication
// OR, it requires some abstraction to piece it all together...
// Though, maybe it can be done...
// What is the the live expectation of the promise (returned by task._userInteraction{...}???
// if we have race conditions, we want to handle them gracefully.
// In general. I think the promise construct in here describes nicely
// the kind of ineraction that is expected. BUT it may be a bit complicated
// to orchestrate.

// TODO: NEXT: start sketching the UIServer in here, that
//          * loads processes
//          * and asks them among other things for their expected user interactions
//          * etc. How to do a correct feedback loop that goes through the model (react||process manager)
// ...
_p.request = function(...uiItems) {
    // jshint unused:vars
    var userResponsePromise = Promise((resolve, reject)=>{
        // generate the interfaces


        // wait for answers.

    });
    return userResponsePromise;
};

return UiApi;
})();
*/

/**

// used like this
// -> a promise; expecting uiApi.response(userResponse)
// to be called to fullfill the promise?
uiApi.request(
        new uiAPI.Select({
            id: 'status'
          , label: 'Set a final status.'
          , type: 'select'
          , select: [FAIL.toString(), OK.toString()]
        })
      , new uiAPI.Text({
            id: 'reasoning'
          , label: 'Describe your reasoning for the chosen status.'
          , type: 'text'
        })
    // this is bolloks, as it doesn't tell the whole story...
    // uiApi.request = funtion(...uiItems){
    //    var promise = new Promise((resolve, reject)=>{
    //        // here we need arrange that we can call
    //        // resolve(userResponse) maybe.
    //    });
    //    return promise;
    // }
    // // but what is this function supposed to do with
    // user Response
    ).then(userResponse=>{});
*/



/**
 * Using a class here, so state variables are managed not on module level
 * Initialization starts the server.
 *
 * `Server` is for stand alone use (development, testing). It also documents
 *  how to use `ProcessDispatcher`.
 * `appFactory` is for use as a sub-application in another express.js app.
 *
 *
 * Change of plan:
 *  * eventually Server will provide all the resources to the appFactory
 *    functions.
 *  * appFactory will kind of
 *
 *
 *
 * What do we want to share betwen the dashboard stuff and the
 * specific report
 *
 *
 * This Server is for testing in Development, it's not the production
 * tool! And it documents the dependencies.
 */
const Server = (function() {

function Server(...args) {
    this._serviceDefinitions = [
        ['/', RootService, ['server', '*app', 'log']]
      , ['/dispatcher', ProcessUIService, ['server', '*app', 'log', 'dispatcher', 'ghauth', 'io']]
      , ['/github-oauth', GithubOAuthService, ['server', '*app', 'log', 'ghauth', 'webServerCookieSecret']]
      , ['/download', StorageDownloadService, ['server', '*app', 'log'
                            , {/*cache: 'cache',*/ persistence: 'persistence'}]]
    ];
    _BaseServer.call(this, ...args);
}

_p = Server.prototype = Object.create(_BaseServer.prototype);

return Server;

})();


const ProcessListQuery = (function(){

function ProcessListQuery(log, tokens) {
    this._log = log;
    // TODO: this will have to interprete the semantics of tokens
    this._tokens = tokens;
    // This is a cache and must be invalidated (set to null again)
    // when this._tokens changes.
    this._query = null;
}

var _p = ProcessListQuery.prototype;

/*
_p._tokenDefinitions = {
    mode: 'sandbox', 'production' // could also be any string
    familyName: 'Gupter' // any string
    initiator: 'vv-monsalve' // any string

    order: 'changed', 'created', 'finished' * '-asc' '-desc'

    // as an index, could be a 2 bit flag:
    // then we can use e.g getAll([True, False], {index: 'waitingFor'})
    // False False, False True, True False, False False
    // also, if there's a waiting for, we have to use getAll, hence
    // nothing else may use getAll, unless we create a compound index
    // BUT then order-by({index: 'changed'}) won't work!
    // However, order-by works "after a between command provided it uses the same index."
    // so maybe we can have a waitingFor-changed index, the can get all
    // between [1, r.minval], [1, r.maxval]
    // where e.g. 1 === service-answers
    // then orderBy(index: 'waitingFor-changed')
    waitingFor: not-waiting, service-answers, user-answers, any-answers

    hmm, these queries, I guess, are interesting for either "my-own"
    e.g. the initiator processes or for all processes...
    hence an index [changed, waitingFor, initiator] could be interesting
    and the most interesting question is if r.minval/r.maxval works within
    a compound index: that example is in the docs!


    right now, thinking it may be best to tightly define the few queries
    we really need and how each individually is variable and then define
    the possible tokes to select a) the query + b) the possible variability
    settings per query. Without creating a full blown generic solution.



}

*/

/**
 * funny, all queries are probably conceivable as:
 *      for a specific initiator
 *      for all entries
 *
 * And it feels like a specific initiator limits the result set the most,
 * more like any other query, so that if possible, initiator should be
 * the index.
 *
 * by: all, initiator, familyName, initiator+familyname ?
 * filter: finished, running, waitng-for-*, mode:sandbox/production
 * orderBy: created, changed, finished
 *
 *
 * open-processes, closed-processes
 *
 *
 * OK in general, 'secondary indexes' are a premature optimization compared
 * to just using "filter". Only simple secondary indexes should be used
 * so far, it's basically impossible to write generic queries based on
 * mainly compound secondary indexes as they are very limiting.
 * :-(
 *
 * my processes: initiator => finished, open, waitingFor-* familyName mode
 * family processes: familyName => finished, open, waitingFor-* (familyKeySuffix) initiator mode
 *
 * one list: all index waiting-for {date}, id with pagination
 *           all orderBy changed   with pagination -< nice live list
 *           all orderBy created   with pagination
 *           all finished orderBy finished with pagination
 *              index finished-date: {date, id} : filter finished status (OK,FAIL)
 *              contains only finished
 *
 *
 *
 * query:waitingFor
 * query:initiator
 *
 * all queries using between for pagination need a secondary index like
 * [{date}, "id"] to make it a) sortable and b) all entries in the index unique
 * by taking the uniqueness of the primary index `id`
 *
 * because they are typical maybe
 * [initiator, {date}, id]
 * [familyName, familyKeySuffix, {date}, id]
 * could be used as well, though, these only qualify to query specific
 * initiator/familyName+suffix combinations
 *
 * so these could select a "family"
 * order by that index (one of created/changed/finished)
 * still filter by arbitrary stuff ... (well make a list of generic filters I guess)
 * be paginated
 */

/*
why waitingFor: service -> detect maybe stuck processes (changed-asc)
                user -> find processes that need attention by a human

may be needed as a virtual/generated field: for filter
may be needed as a secondary index, together with {date} , id



indexes:
    (ALL)
    created_id
    changed_id
    finished_id
        FILTERS: finished:any, finished:OK, finished:FAIL, finished:not
             **  waitingFor:not, waitingFor:any, waitingFor:service, waitingFor:user, waitingFor:both
                 mode:{(string) sndbox. production}
               * initiator:{gh-handle}
               * family:{(string)*familyName}{[optional :(string)*familyKeySuffix} <- no suffix === '', could allow '*' for any suffix

    ** should fall through to WAITING_FOR if orderBy is "changed"
        otherwise, we stay with the (ALL) filters because:
                orderBy finished is irrelevant or noise if it produces something
                orderBy created: is probably not irrelevant but not a really interesting query,
                    because it doesn't really help determining since when the processes are waiting.
    * if these are present, could fall through to one of the below
        suggesting: family before initiator, as I would expect family selects less than initiator, but that's
        speculation.


    (WAITING_FOR) waitingFor:not, waitingFor:service, waitingFor:user, waitingFor:both
            // waitingFor:any -> not usable as index -> bad order
    waitingFor_changed_id // this is a bad index idea, as when I look for service, I'm interested in service + both
                          // and when I look for user, I'm interested in user + both
                          // but actually, that fucks up my orderBy changed, as all
                          // e.g. only-service entries come before service + user entries
                          // that's just how these index orderings work!
                          // so this can only be a filter :-(
                          // or not a change feed ...
                          // or we need two secondary indexes
                          //    waiting for service
                          //    waiting for user
                          // not waiting should equal finished
                          // waiting for any should equal not-finished
                          // waiting for only user or only service is not really interesting
        waitingForService_changed_id
        waitingForUser_changed_id

        FILTERS: finished:any, finished:OK, finished:FAIL, finished:not //finished filters are probably not relevant
                 mode:{(string) sndbox. production}
                 // family and initator are falling through to the respective secondary index queries

    (FAMILY) family:{(string)*familyName}{[optional :(string)*familyKeySuffix} <- no suffix === ''
    familyName_familyKeySuffix_created_id
    familyName_familyKeySuffix_changed_id
    familyName_familyKeySuffix_finished_id
        FILTERS: finished:any, finished:OK, finished:FAIL, finished:not
                 waitingFor:not, waitingFor:*, waitingFor:service, waitingFor:user, waitingFor:both
                 mode:{(string) sndbox. production}
                 initiator:{gh-handle}

    (INITIATOR) initiator:{gh-handle}
    initiator_created_id
    initiator_changed_id
    initiator_finished_id
        FILTERS: finished:any, finished:OK, finished:FAIL, finished:not
                 waitingFor:any, waitingFor:service, waitingFor:user, waitingFor:both , waitingFor:not
                 mode:{(string) sndbox. production}
                 family:{(string)*familyName}{[optional :(string)*familyKeySuffix} <- no suffix === '', could allow '*' for any suffix

    All tokens are filtered such that the last token is used,
    could also be the first, but this way the ui can do a quick and dirty
    append token and get back a new query.
    If more power is needed, a value parser could be added.

    for anything else, we can use filter:
    obviously, only the last key of a kind is ever used.
    {token}:{value} => .filter({token: value})



custom calculated fields (very similar to the indexes!):
    waitingFor
    changed
    family // (`${familyName}:${familyKeySuffix}`)


change feeds paged mit changed_id machen nicht viel sinn, weil, wenn das
paging element sich ändert verliert die seite ihren semantischen sinn.

created_id und finished_id ändern sich hingegen nie: je nachdem von welcher
seite man diese feeds betrachet, bleiben die pages sogar stabil
(order-by: asc) => frühestes datum zuerst. aber die seite ist ja meist nicht
interressant!!!
trotzdem, auch bei orderBy: desc > spätestes datum zuerst ist die seite
vielleicht nicht die erste seite dann, aber die ansicht mit datum_id bleibt
stabil!

daher sollten pages in "changed" feeds mit skip/slice implementiert werden
was allerdings nicht zu funktionieren scheint! daher kein paging hier im
change feed, sondern statdessen immer größeres limit???
slice beended den change feed.


_p.queryDefinitions = {


};

*/

function _getOrderBy(value, defaultKey, defaultDir, validKeys) {
    var [key, dir] = value ? value.split('-') : []; // "changed" or "changed-asc"

    if(!validKeys.has(key))
        key = defaultKey;

    if(['asc', 'desc'].indexOf(dir) === -1)
        dir = defaultDir;

    return [key, dir];
}

/**
 * [familyName, familyKeySuffix] = getFamily('ABeeZee:*')
 */
function _getFamily(value) {
    var sepIndex = value ? value.indexOf(':') : -1
      , familyName, familyKeySuffix
      ;
    if(sepIndex === -1)
        return [value, ''];
    familyName = value.slice(0, sepIndex);
    familyKeySuffix = value.slice(sepIndex + 1);
    if(familyKeySuffix === '*')
        // any! only allowed as filter, not as secondary index, because
        // that screws up the ordering.
        familyKeySuffix = null;
    return [familyName, familyKeySuffix];
}

function _getLimit(value, defaultVal) {
    var limit = parseInt(value, 10);
    // Return only positive numbers bigger than zero or defaultVal.
    return limit && limit > 0 ? limit : defaultVal;
}

/**
 *
 */
_p._getNormalizedQuery = function(tokens) {
    // jshint unused:vars

    // hmm, this needs to filter the tokens to create something that makes
    // sense, hence, we kind of need an idea of the possible token values
    // in here.

    // we need to know how to create the query from this, it's not just
    // normalized tokens, it's also the automate that writes the query.

    // keeps order, removes duplicates
    var tokenMap = new Map();
    for(let [token, value] of tokens)
        tokenMap.set(token, value);

    // "desc" is the default direction to see the latest that happened.
    var [orderBy, orderDir] = _getOrderBy(tokenMap.get('orderBy')
                            , 'changed', 'desc' // TODO: store defaults centrally, DRY!
                            , new Set(['changed', 'created', 'finished'])
                            );

    var limit = _getLimit(tokenMap.get('limit'), 25);


    // first one found in this order is used!
    // waitingFor is first, because it can't be queried as a filter
    var indexTokens = ['waitingFor', 'family', 'initiator']
      , indexToken = null
      ;
    for(let _indexToken of indexTokens) {
        if(!tokenMap.has(_indexToken))
            continue;
        if(_indexToken === 'waitingFor') {
            // must be ordered by 'changed' or it doesn't apply as indexToken
            if(orderBy !== 'changed')
                continue;
            if(['user', 'service'].indexOf(tokenMap.get(_indexToken)) === -1)
                // we only have the indexes:
                //     waitingForService_changed_id
                //     waitingForUser_changed_id
                continue;
        }
        if(_indexToken === 'family') {
            let [/*familyName*/, familyKeySuffix] = _getFamily(tokenMap.get(_indexToken));
            if(familyKeySuffix === null)
                // if "any" is requested this can't be the secondary index
                continue;
        }
        // found one
        indexToken = _indexToken;
        break;
    }

    // * familyName/familyKeySuffix they are ignored and only
    //   "family" is used via _getFamily if "family" is present
    // * waitingFor is totally ignored as a filter, we use it only for
    //   the specific use case implied with the secondary indexes
    //
    // ignoring is interesting, as we allow generic filter tokens here.
    // so, why don't allow specifically unusable ones?
    // One reason might be, that the user will receive a canonical query
    // and these removed makes probably sense, as we know that they are
    // wrong here. Not entirely sure about the validity of the reasoning.
    // One point about these filters is, that if we get a zero result
    // we know the filter value doesn't exist.
    var ignoreFilters = new Set(['waitingFor', 'orderBy', 'limit']);
    if(tokenMap.has('family')) {
        ignoreFilters.add('familyName');
        ignoreFilters.add('familyKeySuffix');
    }

    // NOTE: filters as of now can only have string types!
    // but e.g. `familyKeySuffix` in the document can be `null` or a string
    // (can't be an empty string, so we can fix that manually) other
    // values could be numbers or other types. So, having only string
    // types can be a restriction. Maybe we can come up with a type marker.
    var filters = new Map();
    for(let [token, value] of tokenMap){
        if(token === indexToken)
            continue;
        if(ignoreFilters.has(token))
            continue;

        // if not ignored
        if(token === 'familyKeySuffix' && value === '')
            value = null;

        filters.set(token, value);
    }

    // TODO: missing: pagination items

    var query = {
        index: indexToken ? [indexToken, tokenMap.get(indexToken)] : null
      , orderBy: [orderBy, orderDir]
      , filters: filters
      , limit: limit
    };

    this._log.debug('normalized query from tokens:', tokens);
    this._log.debug('created normalized query:', query);

    // next: put this into an actual query
    // add the index definitions to the table definition

    return query;
};

_p._getNormalizedTokens = function(query) {
    var tokens = [];
    if(query.index)
        tokens.push(query.index.slice());

    tokens.push(...Array.from(query.filters)
                     .sort(([a, ], [b, ])=>{
                            if(a === b) return 0;
                            if(a > b) return 1;
                            return -1;
                }));

    if(query.orderBy) {
        let [orderBy, orderDir] = query.orderBy
          , value = `${orderBy}-${orderDir}`
          ;
        // TODO: store defaults centrally, DRY!
        if(value !== 'changed-desc') // default
            tokens.push(['orderBy', value]);
    }
    // TODO: store defaults centrally, DRY!
    if(query.limit !== 25)
        tokens.push(['limit', ''+query.limit]);

    //TODO: add paging

    return tokens;
};

/**
 * q.filter({
 *        mode: 'sandbox' // 'production'
 *      , familyName: 'Gupter'
 *      , initiator: 'vv-monsalve'
 *   })
 *
 * mode: ['sandbox', 'production'] // or not set == both
 *
 * Indexes (with getAll) are faster than filter queries, hence if there
 * is an index
 * equivalent to the filter, it should be used.
 * However, there can be many indexes that fit a subsection of the filter
 * and its not necessarily clear which filter to choose in those cases.
 * Also "between"
 */
_p.configureQuery = function(q, r) {

    var query = this.query
      , index, indexValue
      , [orderBy, orderDir] = query.orderBy
      ;

    //{
    //    index: indexToken ? [indexToken, tokenMap.get(indexToken)] : null
    //  , orderBy: [orderBy, orderDir]
    //  , filters: (Map) filters
    //}


    switch(query.index ? query.index[0] : 'ALL') {
        case('ALL'):
            // created_id
            // changed_id
            // finished_id
            index = `${orderBy}_id`;
            // not needed
            //indexValue = [
            //    [r.minval, r.minval]
            //  , [r.maxval, r.maxval]
            //];
            break;
        case('waitingFor'):
            // waitingForService_changed_id
            // waitingForUser_changed_id
            index = `waitingFor${query.index[1][0].toUpperCase()+query.index[1].slice(1)}_${orderBy}_id`;
            // not needed
            // index contains is [changed, id]
            // indexValue = [
            //              [r.minval, r.minval]
            //            , [r.maxval, r.maxval]
            //            ];
            break;
        case('family'):
            // familyName_familyKeySuffix_created_id
            // familyName_familyKeySuffix_changed_id
            // familyName_familyKeySuffix_finished_id
            index = `familyName_familyKeySuffix_${orderBy}_id`;
            // NOTE: it's important that in the actual index definition
            // a index for a process with a familyKeySuffix === null
            // is created using familyKeySuffix = ''.
            let [familyName, familyKeySuffix
                            ] = _getFamily(query.index[1]);
            indexValue = [
                         [familyName, familyKeySuffix, r.minval, r.minval]
                       , [familyName, familyKeySuffix, r.maxval, r.maxval]
                       ];
            break;
        case('initiator'):
            // initiator_created_id
            // initiator_changed_id
            // initiator_finished_id
            index = `initiator_${orderBy}_id`;
            indexValue = [
                         [query.index[1], r.minval, r.minval]
                       , [query.index[1], r.maxval, r.maxval]
                       ];
            break;
        default:
            throw new Error(`configureQuery don't know how to handle index: ${query.index.join(':')}.`);
    }
    if(indexValue)
        q = q.between(...indexValue, {index:index,  leftBound: 'closed', rightBound: 'closed'});


    q = q.orderBy({index: r[orderDir/* 'asc' | 'desc'*/](index)})
         .limit(query.limit);
    if(query.filters.size) {
        var filters = Object.fromEntries(query.filters);
        if('family' in filters) {
            let [familyName, familyKeySuffix] = _getFamily(filters.family);
            filters.familyName = familyName;
            if(familyKeySuffix !== null)
                // This is a bit confusing. Returned from _getFamily
                // null means "all" so as a filter: don't set it.
                // '' means "no suffix" (usually the production version)
                // but that's in the database document as `null`
                filters.familyKeySuffix = familyKeySuffix === ''
                                                ? null : familyKeySuffix;
            delete filters.family;
        }
        q = q.filter(filters);
    }

    this._log.debug('rDB query:', q.toString());

    // no paging yet
    // for pagination, it will be interesting to test:
    // .between and .limit with the change feed!
    // but in the worst case, we can do pagination in the client for a while
    // until the data gets too much.

    // pluck should be called before run, not in here, because then we
    // know most about the query/result structure!
    // must also pluck: ['type', 'old_offset', 'new_offset']
    // var pluckKeys = ['id', 'created', 'initiator', 'familyName']
    // q.pluck({new_val: pluckKeys, old_val: pluckKeys})
    return q;
};

Object.defineProperties(_p, {
    query: {
        get: function() {
            if(!this._query) {
                this._query = this._getNormalizedQuery(this._tokens);
                this._log.debug('query: got normalized: ', !!this._query);
                Object.freeze(this._query);
            }
            this._log.debug('query: returning query:', !!this._query);
            return this._query;
        }
    }
  , tokens: {
        get: function() {
            return this._getNormalizedTokens(this.query);
        }
    }
  , user: {
        get: function() {
            return _tokensToUserQueryString(this.tokens);
        }
    }
  , url: {
        get: function() {
            return _tokensToURLQueryString(this.tokens);
        }
    }
  , canBeChangeFeed:{
        get: function() {
            // FIXME: implement
            return true;
        }
    }
});



/**
 * Factory function, parses queryString into an instance of ProcessListQuery.
 *
 * It throws away anything it doesn't understand, this is considered
 * to function as a quick way of input validation. If more detailed
 * parsing messages are needed we'll have to implement it.
 *
 * A query string in general consists of key:value tokens.
 *
 * There are two ways to encode query strings:
 * - url parameter encoded: to maximize url readability, make parsing
 *   easier and to put it into urls
 * - user encoded: to make it easier for a user to enter and manipulate
 *   in a text input field.
 *
 * A url parameter encoded query string, used after the `?q=` part in the
 * query and ends at the first `&`
 *
 * A url parameter encoded query string starts with "q=" so we can clearly
 * discern it from a user encoded query string, which starts directly with
 * a token or with spaces.
 *
 * Tokens are separated by the `+` sign.
 *
 * Keys can only contain a-z and A-Z and 0-9, camelCase is suggested,
 * if word boundaries are needed.
 *
 * Values are encoded with `encodeUriComponent`, hence they don't contain
 * the separators `+`, `:` and `&` (etc)
 *
 * A user encoded query string, for a form input is a bit different:
 *
 * Tokens are separated by the space sign ` `
 *
 * Keys are the same as in the url parameter encoded query string.
 *
 * Values are just text, if they don't contain any spaces, which would
 * end the token. Spaces, if part of the value can be escaped with "\ ".
 *
 * To better readable values, that contain spaces, they can be put
 * between double quotes `"`. Then double quotes in the value must be
 * escaped with the backslash `\"`.
 *
 * A backslash itself can be escaped with another
 * backslash hence "\"" prints " and "\\" prints \ while "\\"" is an invalid
 * token (the value is just \ ) but then it's not separated by a space.
 * "\" is an invalid, unterminated value, because it doesn't end with a "
 * \ returns (escapes) its following character in any case so "\3" equals "3"
 * while "\\3" prints \3
 */
ProcessListQuery.fromString = function(log, queryString) {
    var tokens = queryString.startsWith('q=')
        ? _tokenizeURLQueryString(queryString)
        : _tokenizeUserQueryString(queryString)
        ;
    log.debug('ProcessListQuery.fromString in:',  queryString);
    log.debug('ProcessListQuery.fromString out:',  tokens);
    return new ProcessListQuery(log, tokens);
};

// one or more of a-z A-Z 0-9 and nothing else
const reKey = /^[a-z0-9]+$/i;

/**
 * returns a list of tokens where a token is a pair of:
 * [(string) key, (string) value]
 * [(string) flag, null] is a "flag"
 * [(string) key, empty string] is just an empty value
 * there are no empty string or null keys
 *
 * If this doesn't understand how to parse a token, it's silently skipped
 * at the moment.
 */
function _tokenizeURLQueryString(queryString) {
    if(queryString.indexOf('q=') === 0)
        queryString = queryString.slice(2);
    return queryString.split('+')
        .map(tokenString=>{
            var token = tokenString.split(':')
              , key, value
              ;
            if(token.length === 1) {
                // a flag
                key = token[0];
                value = null;
            }
            else if (token.length === 2) {
                [key, value] = token;
            }
            else
                // Zero length or more than 2 we don't try to understand.
                // For more than 2, the actual value is supposed to be
                // url-encoded, hence ":" should be encoded as "%3A".
                return false;

            if(!reKey.test(key))
                return false;

            if(value !== null) {
                // value.length === 0: An empty value is OK, but has probably
                // no semantic value later and may be ignored then.
                try { // don't know if this ever raises
                    value = decodeURIComponent(value);
                }
                catch(e) {
                    return false;
                }
            }
            return [key, value];
        })
        .filter(token=>!!token);
}

function _tokenizeUserQueryString(queryString) {
    var tokens = []
      , context = 'top'
      , prevContexts = []
      , enter = newContext=>{
            prevContexts.push(context);
            context = newContext;
        }
      , exit = ()=>{
            context = prevContexts.pop();
        }
      , key = null
      , value = null
      , flushToken = ()=>{
            var token = [
                key.join('')
                // if it's null it's a flag
              , (value !== null ? value.join('') : null)
            ];

            // key must pass this
            if(reKey.test(token[0]))
                tokens.push(token);
            key = null;
            value = null;
        }
      ;

    for(let char of queryString) {
        switch(context) {
            case 'top':
                key = null;
                value = null;
                if(reKey.test(char)) {
                    // enter key context
                    enter('key');
                    key = [char];
                }
                break;
            case 'key':
                if(char === ' ') {
                    //end key context: is a flag
                    flushToken();
                    exit();
                }
                else if(char === ':') {
                    // enter value
                    exit();
                    enter('value');
                    value = [];
                }
                else {
                    // Key could be bad and we will dismiss it in
                    // flushToken if it is invalid.
                    key.push(char);
                }
                break;
            case 'value':
                if(value.length === 0 && char === '"') {
                    exit();
                    // it's the other kind
                    enter('quotedValue');
                }
                else if(char === '\\') {
                    enter('escapedCharValue');
                }
                else if(char === ' ') {
                    // end value context
                    flushToken();
                    exit();
                }
                else {
                    value.push(char);
                }
                break;
            case 'quotedValue':
                if(char === '"') {
                    exit();
                    enter('endQuotedValue');
                }
                else if(char === '\\') {
                    enter('escapedCharValue');
                }
                else {
                    value.push(char);
                }
                break;
            case 'endQuotedValue':
                // A quoted value must be followed by a separator
                // or the end of the query string;
                if(char === ' ') {
                    flushToken();
                }
                // else: skip, don't understand
                exit();
                break;
            case 'escapedCharValue':
                value.push(char);
                exit();
        }
    }
    // cleanup
    switch(context) {
        // these can be flushed if active on queryString end
        case 'key':
            // falls through
        case 'value':
            // falls through
        case 'endQuotedValue':
            flushToken();
        // we don't flush in:
        //  top -> nothing to flush
        //  escapedCharValue -> there was nothing to escape and hence
        //                      the value was incomplete/invalid
        // quotedValue -> it didn't end with a " hence it's incomplete
    }
    return tokens;
}

function _tokensToUserQueryString(tokens) {
    return tokens.map(([k,v])=>{
        if(v===null)
            return k;
        v = v.replace(/\\/g, '\\\\');
        // Alternatively, we could escape the spaces with the backslash
        // but I think this is ultimately better readable
        if(v.indexOf(' ') !== -1)
            v = `"${v.replace(/"/g, '\\"')}`;
        return `${k}:${v}`;
    }).join(' ');
}

function _tokensToURLQueryString(tokens) {
    // For readability of the resulting url, we could use a less
    // strict version of encodeURIComponent. However, this is playing it
    // very save.
    return 'q=' + tokens.map(([k,v])=>`${k}:${encodeURIComponent(v)}`).join('+');
}
//
// > qs = 'Hello:"Wh ör\\"l:d" bÄd:key I:am 13ab::AB"C fully:"c o n t a i n e d " ' +
//      'this:\\\\\\\\ inval:"id"e go:od" noth:ing:::\\ matters captureTheFlag el:se\\'
// > console.log(qs)
// Hello:"Wh ör\"l:d" bÄd:key I:am 13ab::AB"C fully:"c o n t a i n e d " this:\\\\ inval:"id"e go:od" noth:ing:::\ matters captureTheFlag el:se\
// > _tokenizeUserQueryString(qs)
// [
//   [ 'Hello', 'Wh ör"l:d' ],
//   // 'bÄd:key' doesn't parse because we don't allow the Ä in kezs
//   [ 'I', 'am' ],
//   [ '13ab', ':AB"C' ],
//   [ 'fully', 'c o n t a i n e d ' ],
//   [ 'this', '\\\\' ],
//   // 'inval:"id"e' must be followed by a space, if it is a quoted value
//   [ 'go', 'od"' ],
//   [ 'noth', 'ing::: matters' ],
//   [ 'captureTheFlag', null ]
//   // '... el:se\\' is literally el:se\ and is not accepted because it has
//   // an escape without a value, hence the value never completes.
// ]

return ProcessListQuery;
})();


/**
 * TODO: Factor out the specific knowledge about the FontbakeryPRDispatcherProcess
 * e.g. make a DispatcherProcessUIService with special knowledge about our
 * workflow: authorization, how process data is structured.i.e.
 *      * _authorizeExecute looks into process state to fish for
 *        repoNameWithOwner, but that's a specific thing to our
 *        workflow, being based on GitHub.
 *      * _initProcess creates and sends our specific DispatcherInitProcess
 *       message. It also does authorization.
 *
 */
function ProcessUIService(server, app, logging, processManager, ghAuthClient
                        , io) {
    this._server = server;
    this._app = app;// === express()
    this._log = logging;
    this._processManager = processManager;
    this._ghAuthClient = ghAuthClient;
    this._io = io;

    this._app.get('/', this._server.serveStandardClient);
    // shows a query-editor interface, will be very rudimentary at the
    // beginning. Queries can be given via the ?q={query} parameter
    this._app.get('/lists-query', this._server.serveStandardClient);
    // Shows a collection of list queries. The intention is to use the
    // ?q={query} parameter to make the list queries more specific, i.e.
    // ?q=initiator:a-github-handle or ?q=family:AbBeeZee
    // but probably not all possible queries will work here in the ?q=
    // parameter, in fact, the specific queries may override some of
    // the ?q= query parameters according to their setup.
    this._app.get('/lists', this._server.serveStandardClient);
    this._app.get('/process/:id', this._checkProcessExists.bind(this));

    this._sockets = new Map();
    this._rooms = new Map();

    this._server.registerSocketListener('subscribe-dispatcher-list'
            , this._subscribeToList.bind(this)
            , null);

    this._server.registerSocketListener('unsubscribe-dispatcher-list'
            , this._unsubscribeFromList.bind(this)
            , null);


    this._server.registerSocketListener('initializing-ui-dispatcher-process'
            , this._initializingProcessUi.bind(this)
            , null);

    this._server.registerSocketListener('init-dispatcher-process'
            , this._initProcess.bind(this)
            , null);

    this._server.registerSocketListener('subscribe-dispatcher-process'
            , this._subscribeToProcess.bind(this)
            , null);

    this._server.registerSocketListener('execute-dispatcher-process'
            , this._execute.bind(this)
            , null);

    this._server.registerSocketListener('unsubscribe-dispatcher-process'
            , this._unsubscribeFromProcess.bind(this)
            , null);

    this._server.registerSocketListener('disconnect-dispatcher-socket'
            , null
            , this._disconnectFromRooms.bind(this));
}

var _p = ProcessUIService.prototype;

_p._checkProcessExists = function(req, res, next) {
    var processId = decodeURIComponent(req.param('id'))
      , processQuery = new ProcessQuery()
      ;
    processQuery.setProcessId(processId);
    this._processManager.getProcess(processQuery)
    .then(
        // This is the same client as the index page,
        // after the id was returned
        (/*processState*/)=>this._server.serveStandardClient(req, res, next)
        // answer 404: NotFound
      , error=>res.status(404).send('Not found: ' + error))
    .catch(next);
};

_p._getProcess = function(processId) {
    //jshint unused: vars
    // what if we have process already loaded?
    // do we keep it at all?
    // we have to update its state when it changes!
    // FIXME;// Won't be loaded from the DB but from ProcessManager
    // var state = dbFetch(processId)
    //     // .then(process
    //   , process = new this.ProcessConstructor(state)
    //   ;
    // FIXME;//return process.activate().then(()=>prcoess) ???
    // return process;
};

// how to show a process?
// -> user goes to dispatcher/process/{processID}
// -> if pid exists, the ui is loaded.
// -> the ui requests the process data via SocketIO
//          -> this ensures we can get live updates
//  -> the ui receives process data and renders it
//  -> if there's a ui requested the server sends it
//  -> if the user sends a ui-form the server receives it
//  the server can send:
//      * changes to process/step/task statuses
//          -> task wise, this are mainly only additions to the task history
//          -> probably easier to just send the whole process state each time
//             with UI information attached to it: {state: {}, ui: {}}
//      * user interface requests/removals to process/step/task
//              -> also responses whether a request was accepted or refused
//                 or, if applicable if the request failed.
//              -> maybe within a client/session specific log window
//                 it's not so interesting to have this data as a status
//                 in the task I guess.
//
// So, updates could also always update and redo the entire task
// or, at least additions to the task history bring their absolute index
// with them, so order of arrival is not that important.
//
// Process structure will never change, so it should be rather easy to
// implement all this.
// In fact, if the process structure is changed on the server, all
// running processes should be ended immediately and maybe link to a new
// process that is started instead.
//
// If we don't go with sockets, what are the alternatives?
// -> best: reload the process page when a ui is sent, but, then
//   other interactions are not live as well, like a pending fb-report
//   changing to a finsihed one. The page would need to be reloaded.
// That's maybe OK, user would kind of manually poll ... by reloading
// Or by posting a form to the page.
// But we don't need to, because we already have the infrastructure for
// a socket based UI.
// Bad thing so far: it was always very complex to implement these interfaces.
// especially the report and source interfaces were mad. The dashboard table
// was a bit better though!
//          Use: Elm, react or vue.js
//
// It may be nice to have a full html report for easy access e.g. to download
// and archive it, but we don't do this now at all. Maybe we can think
// of this stuff in a newer 2.0 version of the interfaces.


/**
 * Hmm,  looks like this has a GET/POST API in mind, receiving "request"
 * as an argument...
 */

_p.uiShowProcess = function(request) {
    var processId = request.processId // FIXME: just a sketch
      , process = this._getProcess(processId)
      ;


    if(process.userInteractionIsRequested) {
        if(request.userResponse) {
            // Todo: this must be a fit for the original defineUserInteracion
            // so some kind of id internal to the process state should make
            // sure this is a fit
            // ProcessManager must receive the interction, we must
            // eventually send it there.
            process.receiveUserInteracion(request.userResponse);


            // Maybe we can then just re-run this function?
            return;// ... ?
        }


        //uiApi = UiApi();
        //uiAPI.request(...process.requestUserInteracion());
    }
    // respond(processData);
};

//TODO: ASAP built the whole pipeline architecture from client to server
//and then iterate and refine until it's done.
// TODO: do this so that development is fast w/o docker stuff.

_p._subscribeList = function(socket, data) {
    //jshint unused: vars
    // WTF? what is this? there's already subscribeToList ...
    // var selection = data.selection; // ???
    // TODO;// what selections are needed?
    //   * running processes
    //   * finished processes
    //   * processes by family
    //   * processes by user/stakeholder => how do we know that?
    //   * process that need user interaction/attention
    //   * processes that need ui/attention by the user authorized for it.
    // This will be a rather tough thing to do efficiently in the DB
    // TODO(this.grpcClient.subscribeList(selection));
};



//TODO:// need thge whole pipeline now:
// client -> uiServer
//      SocketIO
//      get the channel sorted...
//      this will talk JSON
// uiServer -> PeocessManager
//      gRPC
//      this will talk protobufs

// there's a gRPC subscribe in process manager
_p._subscribeProcess = function(socket, data) {
    //jshint unused: vars
    // WTF? what is this? there's already subscribeToProcess ...
    // var processId = data.id;
    // TODO(this.grpcClient.subscribeProcess(processId));

    // TODO: depeneding on authorization the socket will transport
    // UI messages to this.grpcClient.execute
    // One thing to consider is that the authorization state can
    // change ot multiple places:
    //      user can log in/out
    //      authorization/role can be changed for user
    //      authorized users can change for process(family)
};

_p._handleAsyncGen = async function(generator, cancel, messageHandler) {
    try {
        for await(let message of generator)
            messageHandler(message);
    }
    catch(error) {
        // statusCANCELLED is expected
        // FIXME: we now got a case where we don't use this._processManager
        // and instead directly connect to rethinkDB, hence, statusCANCELLED
        // is not expected in that case (but what is acceptable?)
        // An error here ends in an "Exceptionally ended generator" message
        // and that's it, hence it's probably just fine.
        if(error.code !== this._processManager.statusCANCELLED) {
            this._log.error('generator', error);
            throw error;
        }
    }
    finally {
        // make sure to close the resource
        cancel();
    }
    return true;
};

_p._initRoom = function(generatorCancel, emit, process/*optional*/) {
    var room = {
            sockets: new Set()
          , cancel: ()=>{}
          , lastMessage: null
          , emit: emit
        }
      , messageHandler = (message)=>{
            // We can do optional pre-processing of the message here
            // so we don't have to create the actually emitted data
            // on each call to emit.
            var processed = process ? process(message, room.lastMessage) : message;
            room.lastMessage = processed;
            for(let socketId of room.sockets) {
                let socket = this._sockets.get(socketId).socket;
                room.emit(socket, processed);
            }
        }
      ;

    Promise.resolve(generatorCancel)
    .then(({generator, cancel})=>{
        room.cancel = cancel;
        // ALLRIGHT! when the process is not found or there's any other
        // error the second handler is called! Thus we should use this
        // to tell the client about the misfortune of not being able
        // to enter/open/stay in/init the room!
        //
        // also, generally, when the generator ends, this will be informed
        // via the result handler. I.e. the processManager can just
        // hang up using `call.end()`
        return this._handleAsyncGen(generator, cancel, messageHandler).then(
            (...args)=>this._log.debug('Well ended generator:', args)
                       // this should be fine, we handled it (used cancel).
          , (...args)=>this._log.debug('Exceptionally ended generator:', args)
        );
    })
    .then(null, error=>{
        // TODO: this implies creating the room failed, we should close
        // it and disconnect everyone.
        this._log.error(error);
        // FIXME: making this effectively an unhandled exception!
        // Maybe we should end the server here, could mean the db resource
        // is broken.
        // It's also likely, that for instance _queryProcessListChangeFeed failed
        // because the query is invalid. An invalid query would be a
        // good test case to trigger this and not really a reason to
        // end the server.
        throw error;
    })
    ;
    return room;
};


//////////////////////////////////////////////
//// Start infrastructure for _subscribeToList
//// Not using the once proposed this._processManager.subscribeProcessList
//// API, because this way is more straight forward.
////

_p._closeCursor = function(cursor) {
    if(cursor) {
        // rethinkDB doesn't emit the end event, but it's nice (not
        // necessarily needed), for the async generator that we use to
        // read the cursor.
        cursor.emit('end');
        cursor.close()
        .then(()=>this._log.debug('A cursor has been closed.'))
        .catch(this._io.r.Error.ReqlDriverError, (err) => {
            this._log.error('An error occurred on cursor close', err);
        });
    }
};

/**
 * Very similar to (started with a copy of) ProcessManagerClient._readableStreamToGenerator
 * Maybe these can be unified in a mixin-module???
 */
_p.rdbChangeCursorToAsyncGenerator =  async function*(cursor, bufferMaxSize, debugName) {
        var METHOD = debugName ? `[${debugName.toUpperCase()}]` : null
        // Buffer will be only needed if messages are incoming faster then
        // they can be consumed, otherwise a "waiting" promise will be
        // available.
        // Only the latest bufferMaxSize_ items are held in buffer
        // defaults to 1, meaning that only the latest message is relevant.
        // This only makes sense if message have no subsequent reference
        // like a series of diffs, and instead represent the complete
        // state at once.
        // Use Infinity if you can't loose any items at all
        // Use one if only the latest incoming item is interesting.
      , bufferMaxSize_ = Math.abs(bufferMaxSize) || 1 // default 1
      , buffer = [] // a FiFo queue
      , waiting = {}
      , setWaitingHandlers = (resolve, reject) => {
            waiting.resolve = resolve;
            waiting.reject = reject;
        }
      , _putMessage = (resolveOrReject, message) => {
            if(!waiting[resolveOrReject]) {
                buffer.push(Promise[resolveOrReject](message));
                let dropped = buffer.splice(0, Math.max(0, buffer.length-bufferMaxSize_));
                if(dropped.length)
                    this._log.debug('Dropped', dropped.length, 'buffer items.'
                                   , 'Buffer size:', buffer.length);
            }
            else
                waiting[resolveOrReject](message);
            waiting.reject = waiting.resolve = null;
        }
      , resolve = message=>_putMessage('resolve', message)
      , reject = error=>_putMessage('reject', error)
      ;

    cursor.on('data', message=>{
        if(METHOD)
            this._log.debug(METHOD, 'on:DATA', message.toString());
        resolve(message);
    });

    // The 'end' event indicates that the server has finished sending
    // and no errors occurred.
    cursor.on('end', ()=>{
        if(METHOD)
            this._log.debug(METHOD, 'on:END');
        resolve(null);//ends the generator
    });

    // An error has occurred and the stream has been closed.
    cursor.on('error', error => {
        if(METHOD)
            this._log.error(METHOD, 'on:ERROR', error);
        reject(error);
    });

    while(true) {
        let value = null
          , promise = buffer.length
                        ? buffer.shift()
                          // If no promise is buffered we're waiting for
                          // new events to come in
                        : new Promise(setWaitingHandlers)
          ;
        value = await promise; // jshint ignore:line
        if(value === null)
            // ended
            break;
        yield value;
    }
};

// for merge:
function _rqlChangedDef(process) {
    return process('execLog').nth(-1)(0).default(process('created')).default(null);
}

function _rqlFinishedDef(process) {
    return process('finishedStatus')('created').default(null);
}
function _rqlFamilyDef(r, process) {
    return r.expr([process('familyName'), process('familyKeySuffix')])
        // familyKeySuffix can be null in which case we don't want
        // a ":null" at the end instead, no colon at all
        .filter(item=>item.ne(null))
        //.join(':');
        .fold('', function (acc, word) {
            return acc.add(r.branch(acc.eq(''), '', ':')).add(word);
        })
        // new_val can be empty in a change feed, when process is removed
        .default(null);
}

function _rqlProcessMerges(r, process){
    return {
        changed: _rqlChangedDef(process)
      , finished: _rqlFinishedDef(process)
      , family: _rqlFamilyDef(r, process)
    };
}

const _PLUCK_DISPATCHER_LIST_ITEM = [
    'id', 'created', 'initiator', 'mode'
  // TODO: create changed an other derrived fields in the query!
  // BUT: since we likely can't merge before filter in a change feed,
  // we best can reuse the definition of these fields directly in the
  // filter as well.
  , 'changed', 'finished', 'family'
];


/**
 * returns promise {async generator, function cancel}
 */
_p._queryProcessListChangeFeed = function(processListQuery) {
    var q = this._io.query('dispatcherprocesses')
      , r = this._io.r
      ;

    q = processListQuery.configureQuery(q, r);

    return new Promise((resolve,reject)=>{
        q.changes({
            includeInitial: true
          , includeTypes: true
          , includeOffsets: true
        //  , squash: 1 -> ReqlLogicError: Cannot include offsets for range subs
        })
        .merge(changeRow=>({new_val: _rqlProcessMerges(r, changeRow('new_val').default(null))}))
        .pluck({new_val: _PLUCK_DISPATCHER_LIST_ITEM
                // only 'id' for applyChange is needed
              , old_val: ['id']
              , type: true
              , new_offset: true
              , old_offset: true
            })
        .run((err, cursor) => {
            if(err)
                reject(err);
            else
                resolve({
                    generator: this.rdbChangeCursorToAsyncGenerator(cursor, Infinity, 'PROCESS_LIST')
                  , cancel: ()=>this._closeCursor(cursor)
                });
        }, {cursor: true});
    });
};

_p._queryProcessList = function(processListQuery) {
    var q = this._io.query('dispatcherprocesses')
      , r = this._io.r
      ;

    return processListQuery.configureQuery(q, r)
        .merge(process=>_rqlProcessMerges(r, process))
        .pluck(_PLUCK_DISPATCHER_LIST_ITEM)
        .run()
        ;
        // doesn't return a cursor apparently
        //.then(cursor=>cursor.toArray());
};



/**
 * `applyChange` requires https://www.npmjs.com/package/deep-equal
 *
 * The good news is, that deepEqual is only used to compare the `id`
 * values of the entries, and since we use strings as ids, we can
 * easily shim this!
 */
function deepEqual(valA, valB) {
    var allowed = new Set(['string', 'number']);
    if(!allowed.has(typeof valA) || !allowed.has(typeof valB))
        throw new Error(`Only the types ${Array.from(allowed).join(', ')}`
                + 'can be compared. Found: '
                + `${Array.from(new Set([typeof valA, typeof valB])).join(', ')} `
                + 'Please use the npm deep-equal package instead.'
        );
    return valA === valB;
}

/**
 * A change feed from rethinkDB can have the option flag "includeOffsets"
 * set. In that case a "orderBy.limit" query adds information about
 * the changed item offset in the list.
 *
 * See more: https://rethinkdb.com/api/javascript/changes
 *
 * This function can update an existing list with the change information
 * taken from https://github.com/rethinkdb/horizon/blob/next/client/src/ast.js
 */

function applyChange(arr, change) {
    switch (change.type) {
    case 'remove':
    case 'uninitial': {
      // Remove old values from the array
      if (change.old_offset != null) {
        arr.splice(change.old_offset, 1);
      } else {
        const index = arr.findIndex(x => deepEqual(x.id, change.old_val.id));
        if (index === -1) {
          // Programming error. This should not happen
          throw new Error(
            `change couldn't be applied: ${JSON.stringify(change)}`);
        }
        arr.splice(index, 1);
      }
      break;
    }
    case 'add':
    case 'initial': {
      // Add new values to the array
      if (change.new_offset != null) {
        // If we have an offset, put it in the correct location
        arr.splice(change.new_offset, 0, change.new_val);
      } else {
        // otherwise for unordered results, push it on the end
        arr.push(change.new_val);
      }
      break;
    }
    case 'change': {
      // Modify in place if a change is happening
      if (change.old_offset != null) {
        // Remove the old document from the results
        arr.splice(change.old_offset, 1);
      }
      if (change.new_offset != null) {
        // Splice in the new val if we have an offset
        arr.splice(change.new_offset, 0, change.new_val);
      } else {
        // If we don't have an offset, find the old val and
        // replace it with the new val
        const index = arr.findIndex(x => deepEqual(x.id, change.old_val.id));
        if (index === -1) {
          // indicates a programming bug. The server gives us the
          // ordering, so if we don't find the id it means something is
          // buggy.
          throw new Error(
            `change couldn't be applied: ${JSON.stringify(change)}`);
        }
        arr[index] = change.new_val;
      }
      break;
    }
    case 'state': {
      // This gets hit if we have not emitted yet, and should
      // result in an empty array being output.
      break;
    }
    default:
      throw new Error(
        `unrecognized 'type' field from server ${JSON.stringify(change)}`);
    }
    return arr;
}

_p._getProcessListRoom = function(processListQuery) {
    var canonicalQueryString = processListQuery.user
        // could be a checksum of canonicalQueryString to make it shorter
        // in the messages, but like this it's easier to debug and refer
        // to. The "roomId" should however not be interpreted/parsed, itself
        // we should rather send the canonical query string explicitly for
        // those cases.
      , roomId = `list:${canonicalQueryString}`
      , room = this._rooms.get(roomId)
      ;
    if(!room) {
        let process = (changeObject, lastMessage)=>{
                console.log(`process ${roomId} ...`);

                var _lastMessage = lastMessage !== null
                      // Salvage the actual message from the argument list,
                      // it's the first argument ([0]),
                      // and make a copy (slice);
                    ? lastMessage[0].slice()
                      // empty list
                    : []
                    ;
                var result = applyChange(_lastMessage, changeObject);
                // is used as an argument list
                return [result];
            }
            // TODO: this will need more effort
          , emit = (socket, data)=>socket.emit('changes-dispatcher-list'
                    // Multiplexing the event, so we can listen to
                    // many lists at the same time.
                    , roomId
                    , ...data
            )
          ;
                              // Promise.resolve({ generator, cancel })
        room = this._initRoom(this._queryProcessListChangeFeed(processListQuery), emit, process);
        this._rooms.set(roomId, room);
    }
    return roomId;
};

////
//// END Infrastructure for _subscribeToList
////////////////////////////////////////////

_p._getProcessRoomId = function(processId) {
    return ['process', processId].join(':');
};

_p._initializingProcessUi = function(socket, data, answerCallback) {
    //jshint unused:vars
    this._processManager.getInitProcessUi()
        .then(processStateMessage=>{
            var uiDescription = JSON.parse(processStateMessage.getUserInterface());
            answerCallback(uiDescription, null);
        })
        .then(null, error=>answerCallback(null, '' + error))
        ;
};

const TODO=(...args)=>console.log('TODO:', ...args)
   , FIXME=(...args)=>console.log('FIXME:', ...args)
   ;
_p._authorizeInitProcess = function(socket, sessionId, data) {
    //jshint unused:vars

    this._log.warning('NOT IMPLEMENTED: _authorizeInitProcess, we have no roles check here!!!');
    TODO('make a quota of new, un-accepted processes for non-engineer users.');
    var sessionIdMessage = new SessionId();
    sessionIdMessage.setSessionId(sessionId);
    return this._ghAuthClient.checkSession(sessionIdMessage)
    .then(authStatus=>{
        var userName;
        if(authStatus.getStatus() === AuthStatus.StatusCode.OK)
            userName = authStatus.getUserName();
        else {
            // I wonder what I wanted to fix here, seems we just need to
            // return the message that the user is not authenticated???
            // well eventually we want authorization, that includes authentication …
            FIXME('_authorizeInitProcess: not authenticated');
            throw new Error('Not Authenticated.');
        }
        return [null, userName];
    });
};

_p._initProcess = function(socket, sessionId, data, answerCallback) {
    this._authorizeInitProcess(socket, sessionId, data)
    .then(([/*authorizedRoles*/, userName])=>{
        var initMessage = new DispatcherInitProcess();
        initMessage.setRequester(userName);
        initMessage.setJsonPayload(JSON.stringify(data.payload));
        return initMessage;
    })
    .then(initMessage=>this._processManager.initProcess(initMessage))
    .then(processCommandResult=>{
        this._log.debug('processCommandResult'
          , 'result:', processCommandResult.getResult()
          , 'message:', processCommandResult.getMessage()
          , ProcessCommandResult.Result.OK, ProcessCommandResult.Result.FAIL
        );
        var result = processCommandResult.getResult(), processId, error;

        if(result === ProcessCommandResult.Result.OK) {
            processId = processCommandResult.getMessage();
            answerCallback(processId, null);
            return true;
        }
        else {
            error = processCommandResult.getMessage();
            this._log.error('processCommandResult', error);
            answerCallback(null, error);
            return false;
        }
    })
    .then(null, error=>{
        this._log.error('InitProcessError', error);
        answerCallback(null, error.message);
    });
};

_p._authorizeExecute = function(socket, sessionId, commandData) {
    var targetPath = Path.fromString(commandData.targetPath)
      , processId = targetPath.processId
      , roomId = this._getProcessRoomId(processId)
      , room
      , processState, uiDescriptions
      , foundExpectedUI
      , uiRoles = new Set() // empty
      , addRoles = roles=>roles.forEach(role=>uiRoles.add(role))
      , authorizedRolesRequest
      ;
    // There's an assumption that the socket is alreay subscribed to
    // the process and that the process has already produced data, that
    // is now cached in the subscription room. This is how the client is
    // expected to behave.
    // related: kubernetes loadBalancer: sessionAffinity: ClientIP
    // This assumption ensures we don't have to create the room on the
    // fly. If this assumption proofs to be unpractical, we could fall
    // back to query the process directly in here.
    //      * A common case that triggers this error (in development) is
    //        when the server was restarted, but the client was not reloaded.
    //        Also, seems like sometimes the clients just disconnect
    //        (for no apparent reason). Maybe we need some reconnect
    //        management.
    if(!this._socketIsInRoom(socket, roomId))
        return Promise.reject('Socket must be subscribed to process.');

    // socketIsInRoom hence there *MUST* be a room, right?!
    room = this._rooms.get(roomId);
    if(!room || !room.lastMessage)
        // Fair enough? How else would client know about that UI?
        // Maybe a server that got shutdown. Then, though, we must teach
        // the client to properly reconnect to all its subscriptions etc.
        // See above.
        return Promise.reject('Process data not available yet.');

    // that's the process data
    [/*processId*/, processState, uiDescriptions] = room.lastMessage;

    foundExpectedUI = false;
    for(let uiDescription of uiDescriptions) {
        // {
        //      targetPath: item.path.toString()
        //    , callbackName
        //    , ticket
        //    , roles: def.roles
        //    , ui: def.ui
        // }
        if(uiDescription.targetPath === commandData.targetPath
                        && uiDescription.ticket === commandData.ticket) {
            // Hmm, no uiDescription.roles would be an error in the
            // definition I guess.
            foundExpectedUI = true;
            if(uiDescription.roles)
                addRoles(uiDescription.roles);
            break;
        }
    }
    if(!foundExpectedUI)
        return Promise.reject('The requested interaction is not expected.');
    else if(!uiRoles.size)
        return Promise.reject('No roles that apply for the request were found.');

    authorizedRolesRequest = new AuthorizedRolesRequest();
    authorizedRolesRequest.setSessionId(sessionId);
    authorizedRolesRequest.setRepoNameWithOwner(processState.repoNameWithOwner);
    authorizedRolesRequest.setInitiator(processState.initiator);

    // requester + eventually a list of equally authorized people (e.g. when
    // we add a database to manage sources, we can have a list of people
    // who are authorized to work the processes initialized with that source.
    // Also, via a form it could be possible to add more names to the process
    // directly.

    // This will also check if sessionId is valid!
    return this._ghAuthClient.getRoles(authorizedRolesRequest)
    .then(authorizedRoles=>{
        var roles = new Set(authorizedRoles.getRolesList())
        , userName = authorizedRoles.getUserName()
        , matches = new Set()
        ;
        for(let role of roles) {
            if(uiRoles.has(role))
                matches.add(role);
        }

        this._log.debug('Requester roles:', userName
                      , 'authorizedRoles:', roles, 'uiRoles:', uiRoles
                      , authorizedRoles.toObject()
                      );

        if(matches.size) // => hooray!
            return [matches, userName];
        else {
            throw 'Requester has no matching roles.\n'
                + ` * requester roles: ${Array.from(roles).join(', ')}\n`
                + ` * expected roles: ${Array.from(uiRoles).join(', ')}`;
        }
    });
};


/**
 * Send a command to execute in process manager.
 *
 * message ProcessCommand {
 *     string ticket = 1;
 *     string target_path = 2;
 *     string callback_name = 3;
 *     string requester = 4; // for authorization if needed
 *     oneof payload {
 *       // This way we can do better structured protobuf messages OR
 *       // faster to initially implemented JSON.
 *       string json_payload = 5;
 *       google.protobuf.Any pb_payload = 6;
 *     }
 * }
 */
_p._execute = function(socket, sessionId, commandData, answerCallback) {
    this._authorizeExecute(socket, sessionId, commandData)
    .then(([/*authorizedRoles*/, userName])=>{
        var processCommand = new ProcessCommand();
        processCommand.setTicket(commandData.ticket);
        processCommand.setTargetPath(commandData.targetPath);
        processCommand.setCallbackName(commandData.callbackName);
        processCommand.setRequester(userName);
        // the user could send the command and immediately log out
        // ... if we, while processing look up the session id, it may
        // already be invalid! could be a feature, like an "emergency logout"
        // move by the user (unlikely) or a bug ...
        // I prefer it this way, as it's more "realtime", we create less
        // possible cache-echoing effects  through the system (cached in
        // message transport in this case). The Process will likely have
        // to extract the GitHub OAuthToken from the session and keep that
        // for a bit longer! So, when at that point the sessoion is still
        // valid, we expect to be granted to use the token for the
        // upcoming github operation. The sessionId should be expected to
        // be used ASAP, if it is used at all.
        processCommand.setSessionId(sessionId);
        //processCommand.setPbPayload(anyPayload) // new Any
        processCommand.setJsonPayload(JSON.stringify(commandData.payload));
        return processCommand;
    })
    .then(processCommand=>this._processManager.execute(processCommand))
    .then(processCommandResult=>{
        this._log.debug('processCommandResult', processCommandResult);
        var result = processCommandResult.getResult()
          , message, error
          ;
        if(result === ProcessCommandResult.Result.OK) {
            message = processCommandResult.getMessage();
            answerCallback(message, null);
        }
        else {
            error = processCommandResult.getMessage();
            this._log.error('processCommandResult', error);
            answerCallback(null, error);
        }
    })
    .then(null, rejectionReason=>{
        this._log.info('processCommandResult rejection', rejectionReason);
        answerCallback(null, rejectionReason);
    });
};

_p._getProcessRoom = function(processId) {
    var roomId = this._getProcessRoomId(processId)
      , room = this._rooms.get(roomId)
      ;
    if(!room) {
        let processQuery = new ProcessQuery();
        processQuery.setProcessId(processId);
        let process = processStateMessage=>[
                processStateMessage.getProcessId()
              , JSON.parse(processStateMessage.getProcessData())
              , JSON.parse(processStateMessage.getUserInterface())
            ]
          , emit = (socket, data)=>socket.emit('changes-dispatcher-process'
                // data is the result of process:
                // processId, processData, userInterface
                                              , ...data)
          ;
                             // { generator, cancel }
        room = this._initRoom(this._processManager.subscribeProcess(processQuery)
                            , emit, process);
        this._rooms.set(roomId, room);
    }
    return roomId;
};

_p._registerSocketInRoom = function(socket, roomId) {
    var socketData = this._sockets.get(socket.id)
      , room = this._rooms.get(roomId)
      ;
    if(!socketData) {
        socketData = {
            socket: socket
          , rooms: new Set()
        };
        this._sockets.set(socket.id, socketData);
    }

    socketData.rooms.add(roomId);
    if(!room.sockets.has(socket.id)) {
        room.sockets.add(socket.id);
        if(room.lastMessage !== null) {
            // if available send an initial change state
            room.emit(socket, room.lastMessage);
        }
    }
};

_p._socketIsInRoom = function (socket, roomId) {
    var socketData = this._sockets.get(socket.id);
    if(!socketData)
        return false;
    return socketData.rooms.has(roomId);
};

/**
 * socket event 'subscribe-dispatcher-list'
 *
 * FIXME: seems like asChangeFeed could/should be part of the query string
 * request = {queryString: (string), asChangeFeed: (boolean)}
 * However, since it changes the format of the answer (yet, only if a
 * change feed is possible), it may be better when it's separated.
 */
_p._subscribeToList = function(socket, request, callback) {
    //jshint unused: vars
    // subscribe at processManager ...
    this._log.debug('_subscribeToList', request.queryString);
    // FIXME: make sure query.query is a string! seems like, if this
    // raises, the server is ended!
    var query = ProcessListQuery.fromString(this._log, request.queryString)
      , canonicalQuery = {
            user: query.user
          , url: query.url
        }
      , result = {
            roomId: null
          , canonicalQuery
          , isChangeFeed: null
          , data: null
        }
      ;
    // Some requests can't be change feeds, we should send the data
    // directly with the callback and don't have the whole subscription
    // model initiated.
    // Further, the client can request not to subscribe to a change feed
    // and also get's the data sent directly.

    // TODO:
    //      trying different queries DONE
    //      implement canBeChangeFeed
    //      pluck only useful fields DONE
    //      makew interfaces using these queries DONE (bad UI though)
    //          => one generic overview (dashboard)
    //                => fully generic
    //                => one generic personal overview (like generic overview but with family:name token in the url)
    //                => one generic family overview (like generic overview but with initiator:name token in the url)
    //                => each dashboard table can have its own link to the generic query interface (inspect or details or "open in query editor")
    //          => one generic query interface that can take url query strings
    //      clean up LOL
    if(request.asChangeFeed && query.canBeChangeFeed) {
        result.roomId = this._getProcessListRoom(query);
        result.isChangeFeed = true;
        // HMM, missing a way to receive/process error
        callback(result, null);
        // Do this after callback, otherwise the client will get confused,
        // since this will send initial data immediately if available.
        // Using Promise.resolve to run it async, alternatively, a small
        // setTimeout could be used to put a more significant delay
        // in between.
        // Promise.resolve(true).then(()=>
        this._registerSocketInRoom(socket, result.roomId);
        //);

    }
    else {
        return this._queryProcessList(query)
            .then(data=>{
                console.log('Got data:', data);
                result.data = data;
                result.isChangeFeed = false;
                callback(result);
            }
          , error=>{
                this._log.error(`Query list with "${canonicalQuery.user}" raised:`, error);
                callback(null, {
                        name: error.name
                      , message: error.message
                });
            });
    }

};

_p._unsubscribeFromList = function(socket, roomId) {
    this._removeSocketFromRoom(socket, roomId);
};

/**
 * socket event 'subscribe-dispatcher-process'
 */
_p._subscribeToProcess = function(socket, data) {
    //jshint unused: vars
    // subscribe at processManager ...

    this._log.info('_subscribeToProcess data:', data);
    var processId = data.processId
      , roomId = this._getProcessRoom(processId)
      ;
    this._registerSocketInRoom(socket, roomId);
};

_p._unsubscribeFromProcess = function(socket, data) {
    // jshint unused:vars
    var processId = data.processId
      , roomId = this._getProcessRoomId(processId)
      ;
    this._removeSocketFromRoom(socket, roomId);
};

_p._removeSocketFromRoom = function(socket, roomId) {
    var room = this._rooms.get(roomId)
      , socketData = this._sockets.get(socket.id)
      ;
    if(room) {
        room.sockets.delete(socket.id);
        if(!room.sockets.size) {
            // No more listeners: hang up at processManager.
            // I.e.: After each unsubscribe, we must check if there are
            // still clients connected, otherwise, close the subscription:
            room.cancel();
            this._rooms.delete(roomId);
        }
    }

    if(socketData) {
        socketData.rooms.delete(roomId);
        if(!socketData.rooms.size)
            // If the socket is in no more rooms, we can remove it from
            // the this._sockets map.
            this._sockets.delete(socket.id);
    }
};

_p._disconnectFromRooms = function(socket) {
    this._log.info('Disconnect socket from all dispatcher rooms:', socket.id);
    var socketData = this._sockets.get(socket.id);
    if(!socketData)
        return;

    for(let roomId of socketData.rooms)
        this._removeSocketFromRoom(socket, roomId);
    // assert !this._sockets.has(socket.id);
};

// !Plan here!
// Spent extra time to plan it as minimalistic and efficient as possible!

// The plan is to implement this as a state machine
// Steps: A step is made of one or more tasks.
//        All tasks must have a status of OK for the process can go to the next step.
//        If that is not the case the process fails and can't proceed to the next step.
//              -> there will be an explicit in between task to "finalize" a step
//              -> a finalized step either passes or not
//              -> when the step is finalized it *can't* be opened again, it's
//                 frozen. Before finalizing, especially tasks that are decided
//                 by humans can be re-run. Possibly all tasks, it makes sense
//                 in all cases where the computation is not idempotent, which
//                 is all cases right now.
//              -> after finalizing, if the step is not OK, the process is FAILED
//
// The proceed method is thus intrinsic for the process control. It's not
// quite clear if it should run automatically OR must be controlled by a human.
// In general, I tend to make an all-passing step proceed automatically, while
// a failing step will have to be finished (finishes the task as failing) by a human.
// That way, a human may prevent the failing state and it is given that a process
// closing is governed by a human, so it doesn't close unnoticed.
// That includes further steps, such as:
//          * filing an issue at upstream, google/fonts or even googlefonts/fontbakery-dashboard.
//            Ideally each failed process creates an issue somewhere! (reality will
//            not agree, but it's good to have ideals. If there's no other place to
//            file the bug, maybe `googlefonts/fontbakery-dashboard` is the place :-D
// A simple hack to make the auto-proceed go away would be a minimalistic task
// That requires human interaction. Just an ack: OK|FAIL would do. Maybe with
// a reasoning filed for a textual explanation.
//
// Each interaction with a task will have the authors github account attached
// to it.  Ideally, since we can change the results of tasks, there will
// be a history for each process. So, maybe in the DB, we'll have a list
// of status changes. On initialization of a task, status is always PENDING.
// So, tat should be the first status entry. Unless, init FAILED.
// `init` may also just OK directly, if the task is sync an can be decided
// directly.
// To redo a task we init it again, that's it. History is kept.
// Need a history inspection thingy. Each history item can just be rendered
// like the normal status. Should be not much more demanding than rendering
// just one thing.
//
// There's a lot of detailed work to implement the tasks, but everything
// else should be automated and standard. So that a task can be implemented
// focusing on its, well, task.
//
// Messaging:
// ==========
//
// A finished task writes a new status into its DB entry.
// There are different kinds of tasks and somehow they must all report to
// the DB. Ideally a process is monitoring (subscribing) to the database
// and on changes decides what to do, i.e. advance the process, inform the
// dev about a changed status (especially if it's a FAIL) and also inform
// the dev about required manual action. Other possible notifications are
// when a next step was entered (all passing statuses)
// The Frontend only displays the process-document, but also needs to provide
// interfaces for some tasks!
//   * Interface interactions needs to be send to the tasks for evaluation.
//   * I see myself dying over the interface implementation! DISLIKE! this
//     must be done very much more efficiently than I used to make it before.
//     - Plan possible interactions/reactions.
//     - Be quick and possibly dirty
//
//
// DO I need an extra long running process to monitor and control the
// dispatcher OR can the webserver do this? I tend to think an extra
// process is simpler, and all the web servers will talk to that.
// Sounds like a good separation of concerns to me, with the added problem
// that there's a lot of messaging to be done.
//   * What messages need to be sent?
//   * can the frontend display the process-doc without talking to that
//     service? (Ideally yes, just read/monitor the DB directly)
//   * The changes will come through via the db-subscription. Success/Fail
//     notifications may be interesting though.
//
//
// Processes/Code to be written:
//
// - UI-Server
// - UI-Client
// - process manager
// - task/step framework
// - basic task imlementations (Manual Ack Task, …)
// - special task implementations
// CONINUE HERE!
//
// The first special task is getting the package
// which is nice, we also need to persist these, getting is basically done
// This is an async task, but the get (the package) method returns at least
// directly. The fontbakery and diffbrowsers don't necessarily work that way
// we may need another active element, to send to and receive notifications
// about finished tasks.
// -- in case of Fontbakery:
//              - either monitor the DB
//              - or teach the cleanupjobs pod how/where to call back
//                when a report is done.
//
// What about versioning processes? Its clear that it will change and
// there are many instances that may fail when the details are changed.
//  - updated interfaces may fail rendering old tasks/steps/processes
//  - steps/tasks may disappear or appear.
//  - a process once started may be incompatible even before it finishes
//    with a changed process. So, we may init a process, then change the
//    general process structure and it would be hard to decide what to do
//    with the unfinished process. Can't continue(?) because we changed the
//    structure for a reason, that is, because it was insufficient before.
//    So, we should maybe discover that and fail all of these processes
//    automatically and maybe restart directly?
//  - Maybe, we use an explicit version and when changed, we know that the
//    unfinished processes are void/uncompleteable.
// * do we need to check periodically (cron-like) all open tasks for something?
// * on startup of process manager, it should check the versions of all
//   open tasks. Because, it's most likely that the version change happened
//   then, a version change will  always require a restart of the manager.
//   The only function of that version is to invalidate unfinished processes
//   and restart freshly.
//   => We should have a general process history, that can be used to
//      link the old and new processes together.
//      Forward from old to new?

// Tasks are firstly implemented in the process manager (via modules).
// Some tasks also require ui-interaction! It would be nice to have both
// in the same module, so we have it close together. The server module
// and the manager will load these explicitly.
// IMPORTANT: When a task changes manager AND ui-server must be updated
// otherwise there are incompatible implementations possible!
// Can the version thing help here too?
// Or we do fancy hot-swapping... hahaha, seems like a risky stupid thing
// to do with javascript, LOL!!!11!elf

// Namespace: what if a task needs to persist data? Either for itself
// or for another task in a later(also paralell task maybe) step?
// This may be very similar to hw we are going to resolve a "pending"
// status.
// So, the getPackage task may write to the `package` name and the Font Bakery
// task will read the `package` name. When organized into steps, we can
// get along without DI. Font Bakery would just Fail when `package` is
// not available and the developer is required to provide it, by putting
// getPackage into a prior step.
// So, do we use a file system fir this or the cache or a cache like
// service (a persistant cache?) or the DB directly?
// -> tendence: use a cache, but maybe extra to the one instance running
//    already.
//    * It's not persistant, but we can update the process manager and still
//      keep the data.
//    * making it persistent won't be hard, but we can get started without
//      that effort.

// TODO: plan more! This seems still too early to implement it the most
// efficient way possible!
// This stuff can also be a good start for documentation!
//
// process manager planning
// naming things! dispatcher process? Do I need to keep the dispatcher name?
// Could be the Familiy Pull Request Tool
//
// see:
// https://github.com/ciaranj/connect-auth
// https://github.com/doxout/node-oauth-flow
// https://github.com/simov/grant

// Side tasks: update FB workers to use Python 3.6
//             fix the db hickup: https://github.com/googlefonts/fontbakery-dashboard/issues/78

//
// Actions we need:
// a lot of lists...
// A list for the font family with all finished processes AND if any the current active one
// dispatch/start a process
// show latest/active process
// if process defines user interactions show and handle them (relay answers)
// if process is not finished: propagate updates
//    probably with lists: also propagate updates
//              (not sure if this is feasible)
// cancel any subscriptions if not needed anymore...
//

module.exports.ProcessUIService = ProcessUIService;

if (typeof require != 'undefined' && require.main==module) {
    var { getSetup } = require('../util/getSetup')
      , setup = getSetup()
      ;
    setup.logging.info('Init server ...');
    setup.logging.log('Loglevel', setup.logging.loglevel);
    // storing in global scope, to make it available for inspection
    // in the debugger.
    global.server = new Server(setup.logging, 3000, setup);
}
