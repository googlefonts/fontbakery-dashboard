#! /usr/bin/env node
"use strict";
/* jshint esnext:true, node:true */

const grpc = require('grpc')
  , https = require('https')
  , { URL } = require('url')
  , querystring = require('querystring')
  , { AuthService } = require('protocolbuffers/messages_grpc_pb')
  , { AuthStatus } = require('protocolbuffers/messages_pb')
  , { Empty } = require('google-protobuf/google/protobuf/empty_pb.js')
  , uid = require('uid-safe')
  ;

//TODO: proper via setup/injection
const GITHUB_OAUTH_CLIENT_ID = process.env.GITHUB_OAUTH_CLIENT_ID
    , GITHUB_OAUTH_CLIENT_SECRET = process.env.GITHUB_OAUTH_CLIENT_SECRET
    ;

const PENDING = Symbol('pending session');

/**
 * This Server proivdes the grpc AuthService plus some special GitHub
 * related endpoints.
 *
 * Objectives are:
 *      - User Authentication via GitHub OAuth tokens.
 *      - Session management
 *      - access control/authorization services
 *
 *
 * OAuth2: https://tools.ietf.org/html/rfc6749
 *
 * https://developer.github.com/v3/guides/basics-of-authentication/
 * Flask example: https://gist.github.com/ib-lundgren/6507798
 */
function GitHubAuthServer(logging, port) {
    this._logging = logging;

    // TODO: inject
    this._ghOAuth = {
        clientId: GITHUB_OAUTH_CLIENT_ID
      , clientSecret: GITHUB_OAUTH_CLIENT_SECRET
    };

    this._sessions = new Map();
    this._users = new Map();

    this._server = new grpc.Server({
        'grpc.max_send_message_length': 80 * 1024 * 1024
      , 'grpc.max_receive_message_length': 80 * 1024 * 1024
    });

    this._server.addService(AuthService, this);
    this._server.bind('0.0.0.0:' + port, grpc.ServerCredentials.createInsecure());

    // every 5 minutes should be easyily doable
    this._garbageCollectorInterval = 5 * 60 * 1000;
    this._scheduleGarbageCollector();
}

var _p = GitHubAuthServer.prototype;

function _copyKeys(target, source, skip) {
    for(let [k,v] of Object.entries(source)) {
        if(skip && skip.has(k))
            continue;
        target[k] = v;
    }
}

_p._sendRequest = function(url, options, bodyData) {
    var reqUrl = new URL(url)
      , options_ = {
            hostname: reqUrl.hostname
          , path: reqUrl.pathname
          , method: bodyData ? 'POST' : 'GET'// override with `options` arg
          // , port: 443 // 443 is the default for https
          , headers: {
                'Accept': 'application/json'
              , 'User-Agent': 'Font Bakery: GitHub OAuth Client'
              // , 'Content-Type': 'application/json'
              // , 'Content-Length': body.length
              // , 'Authorization': 'bearer ' + this._gitHubAPIToken
            }
        }
      , body = bodyData ? querystring.stringify(bodyData) : null
      ;

    if(options) {
        _copyKeys(options_, options, new Set(['headers']));
        if('headers' in options)
            _copyKeys(options_.headers, options.headers);
    }

    function onResult(resolve, reject, res) {
        //jshint validthis:true
        var data = [ ];
        res.setEncoding('utf8');
        res.on('data', chunk=>data.push(chunk));
        res.on('end', function() {
            try {
                let json = JSON.parse(data.join(''));
                if(res.statusCode !== 200) {
                    let error = Error('('+res.statusCode+') ' + json.message);
                    error.code = res.statusCode;
                    error.isHTTPError = true;
                    throw error;
                }
                resolve(json);
            }
            catch(err) {
                reject(err);
            }
        });
        res.on('error', reject);
    }

    return new Promise((resolve, reject) => {
        var req = https.request(options_, result=>onResult.call(this, resolve, reject, result));

        this._log.debug('sending headers:', req,JSON.stringify(req.headers, null, 2), '\n+++++++++++++');


        req.on('error', reject);
        if (body)
            req.write(body);
        req.end();
    });
};


/*
sooo -- we have an access_token! how to put this into
the socket.io sessions? We can definitely put it into
the session here!
the access_token + another request to gitHub will give
us the user name.
we can probably cache the access token, as a key to the
user-name! so for our auth
if there is an access-token
        if it's cached:
            use that user name
                    -> could be invalid though, we'd have
                       to handle this as if there was no
                       access-token to begin with.
                    -> I hope and believe that GitHub
                       takes care that access-tokens don't
                       collide (ever) everything else would
                       be very scary.
        else
            make the request
            cache that user name
            use that user name
https://medium.freecodecamp.org/session-hijacking-and-how-to-stop-it-711e3683d1ac
So, we don't need session-ids, because the access-token
will suffice. But only if the access tokens are really
well stored:
We'll have to use the session cookie flags:
HttpOnly: so javascript (Cross-site scripting/XSS etc.)
        can't see and steal the session.
Secure: once we have HTTPS in place, so the cookie is only
        transmitted via a secure connection and a man
        in the middle (or listening on the WIFI etc.)
        can't steal the session

Session Id's could make the usefulness of an attack, that
still somehow steals the session, less effective though.
If an attacker can steal the access-token, he's able
to do much more on github with the users account, than,
if the access token is never on the client. In that case
an attacker would be restricted to font-bakery APIs
(which in the first case is possible as well), less damage
for the user, same for Font Bakery Dashboard. And damage
for users who trust us is also our damage!
The acces-token requests don't seem to need the
client-id/client-secret information. Thus, in case someone
rolls this out without HTTPS, the access token should
never be sent to the client.
----
Generally, before I do an action, be it here or be it on GitHub, I wan't
to know who the user (authenticated) is and if the user is authorized.
for actions in here, we'll use our own authorization. (ghUserName->roles)

For GitHub, additionally, GitHub will do authorization with the access-token
but before that, we'll check on our side if an action is authorized.

So, i.e. ProcessManager will get a request with a `requester` field.
Probably the web server authenticated the user, ProcessManager will not
have the means of authenticating the (web)-user.
The requester could be the user-name (which is unique), or just a session
id. Anyways, ProcessManager takes that information and asks our
AuthorizationService for roles (or maybe just gives allowed roles and
the identity and receives an boolean "authorized", so the logic is central
in one place).
AuthorizationService will ideally also keep the access-token and from time
to time re-validate it against github. It's good to have this centralized,
so we can have many web-servers talking to a central place.

*/

_p._hasUser = function(id) {
    return this._users.has(id);
};

_p._getUser = function(id, defaultValue) {
    if(!this._users.has(id)) {
        if(arguments.length >= 2)
            return defaultValue;
        throw new Error('User with id "'+id+'" not found.');
    }
    return this._users.get(id);
};

_p._createUser = function(id) {
    var user = {
        login: null
      , avatarUrl: null
      , sessions: new Set()
    };

    if(this._users.has(id))
        throw new Error('User with id "'+id+'" already exists.');
    this._user.set(id, user);
    return user;
};

_p._updateUser = function(userData, createIfNotExists) {
    // userData = {
    //     "login": "graphicore",
    //     "id": 393132,
    //     "node_id": "MDQ6VXNlcjM5MzEzMg==",
    //     "avatar_url": "https://avatars2.githubusercontent.com/u/393132?v=4",
    //     "gravatar_id": "",
    //     "url": "https://api.github.com/users/graphicore",
    //     "html_url": "https://github.com/graphicore",
    //     "followers_url": "https://api.github.com/users/graphicore/followers",
    //     "following_url": "https://api.github.com/users/graphicore/following{/other_user}",
    //     "gists_url": "https://api.github.com/users/graphicore/gists{/gist_id}",
    //     "starred_url": "https://api.github.com/users/graphicore/starred{/owner}{/repo}",
    //     "subscriptions_url": "https://api.github.com/users/graphicore/subscriptions",
    //     "organizations_url": "https://api.github.com/users/graphicore/orgs",
    //     "repos_url": "https://api.github.com/users/graphicore/repos",
    //     "events_url": "https://api.github.com/users/graphicore/events{/privacy}",
    //     "received_events_url": "https://api.github.com/users/graphicore/received_events",
    //     "type": "User",
    //     "site_admin": false
    // }

    var id = userData.id
      , user = this._getUser(id, null)
      ;

    if(!user) {
        if(!createIfNotExists)
            throw new Error('User with id not found "'+id+'".');
        user = this._createUser(id);
    }

    user.login = userData.login;
    user.avatarUrl = userData.avatar_url;
    return user;
};

_p._newSession = function() {
    var session = {
        // a session with authorizeState will timeout very soonish,
        // as we expect it won't take very long to get this authorization.
          authorizeState: null
        // document all future keys here as well
        // accessToken = {
        //     access_token: '9b9209f61b86bd294d9bf8ead1ae0c2e49749108',
        //     token_type: 'bearer',
        //     scope: 'user:email'
        // };
        , accessToken: null
        // user.login, the GitHub name/handle
        // user.id, the GitHub user id
        // user.avatarUrl
        // user.sessions
        , user: null
        // just as general info
        , created: new Date()
        // used for timeouts/garbage collection
        , accessed: new Date()
    };

    session[PENDING] = null; // set in authorize

    // create sessionId and authorizeState, one that are hard to guess
    // or brute force.
    return Promise.all([uid(128), uid(64)])
    .then(([sessionId, authorizeState])=>{
        session.authorizeState = authorizeState;
        this._sessions.set(sessionId, session);
        return [sessionId, session];
    });
};

_p._deleteSession = function(sessionId) {
    var session = this._sessions.get(sessionId);
    if(!session)
        return false;
    this._sessions.delete(sessionId);
    if(session.user)
        session.user.delete(session);
    return true;
};

// => a user can have many sessions, i.e. in different browsers.
// => so, we can start a session immediately when the none session bearing
//    user arrives...
_p.initSession = function(call, callback) {
    // call.request is probably an empty message initially
    // until we need that "redirect_uri" parameter
    return this._newSession().then(([sessionId, session])=>{
        var authStatus = new AuthStatus()
          , url
          ;

        // prepare the answer
        authStatus.setSessionId(sessionId);
        authStatus.setStatus(AuthStatus.StatusCode.INITIAL);
        // send user to https://github.com/login/oauth/authorize
        // redirect address directly:
        // https://github.com/login/oauth/authorize?scope=user:email&client_id=<%= client_id %>
        url = new URL('https://github.com/login/oauth/authorize');
        url.searchParams.set('client_id', this._ghOAuth.clientId);
        url.searchParams.set('state', session.authorizeState);
        // no scopes needed yet...
        //.searchParams.set('scope', ...);
        // this parameter might become interesting at some point
        // the caller (rpc caller) would in this case have to
        // .searchParams.set('redirect_uri', ...);
        authStatus.setAuthorizeUrl(url.toString());
        // no user, nothing else yet
        callback(null, authStatus);
    });
};

_p.logout = function(call, callback) {
    // just unset the session id cookie
    var sessionId = call.request.getSessionId();
    this._deleteSession(sessionId);
    callback(null, new Empty());
};

_p._getSession = function(sessionId) {
    var session = this._sessions.get(sessionId)
      , status = null
      , message = null
      ;

    if(!session) {
        // means that the clients session should be deleted
        // and reset/replaced.
        status = AuthStatus.StatusCode.NO_SESSION;
        message = 'No session found for requested id.';
    }
    else if(this._sessionIsTimedOut(session)) {
        // timeout?
        // => from time to time check the gh access token
            // maybe scopes?
        // clean up! -> next garbage collector will
        status = AuthStatus.StatusCode.TIMED_OUT;
        message = 'Session is timed out.';
    }
    else {
        // all good
        if(session.user !== null)
            // if there's a user, reset timeout. Otherwise, session
            // may be stuck in authorize, which should be pretty fast
            // usually.
            session.accessed = new Date();
        return [session, null, null];
    }
    return [null, status, message];
};

_p._sessionIsTimedOut = function(session) {
    var timeOutHours = (session.authorizeState || session.user === null)
            // 1 hour -> plenty of time. Don't want this to sit around
            // forever; answering the authorization should be fairly quick!
            ? 1
            // 2 weeks -> The browser session will probably end earlier.
            // Also, we bump the accessed date each time we read the session.
            : 14 * 24
      , timeOutDate = new Date()
      ;
    timeOutDate.setHours(timeOutDate.getHours() - timeOutHours);
    return (session.accessed.getTime() - timeOutDate.getTime() < 0);
};

_p._sessionGarbageCollector = function() {
    for(let [sessionId, session] of this._sessions.entres()) {
        if(this._sessionIsTimedOut(session))
            this._deleteSession(sessionId);
    }
};

_p._scheduleGarbageCollector = function() {
    setTimeout(()=>{
        this._sessionGarbageCollector();
        // recursive
        this._scheduleGarbageCollector();
    }, this._garbageCollectorInterval);
};

function _setAuthStatusOK(authStatus, sessionId, session) {
    authStatus.setStatus(AuthStatus.StatusCode.OK);
    authStatus.setSessionId(sessionId);
    authStatus.setUserName(session.user.login);
    authStatus.setAvatarUrl(session.user.avatarUrl);
}

_p._authorize = function(authorizeRequest, sessionId, session
                       , authorizeState, gitHubAuthCode) {
    var authStatus = new AuthStatus();

    if(!authorizeState || (authorizeState !== session.authorizeState)) {
        // means: do initSession again to get a new authorizeState token
        authStatus.setStatus(AuthStatus.StatusCode.WRONG_AUTHORIZE_STATE);
        authStatus.setMessage('Authorize "state" token is wrong.');
        return Promise.resolve(authStatus);
    }

    // Use session.authorizeState only once!
    // When _checkSession now uses _getSession it is in a race condition
    // with _getAccessToken -> _checkAccessToken which means, there's no
    // session.accessToken or session.user yet!
    // In this gap, session could also be deleted if this function is
    // called twice, which is intended, authorizeState is one time use only!
    // Thus, a client should be able to handle being logged out abruptly,
    // but, that's also true if the same client uses the logout button from
    // another browser window.
    // Without this, the session timeout will be much longer.
    session.authorizeState = null;
    // there is a good session and a good authorizeState.
    return this._getAccessToken(gitHubAuthCode)
        .then(accessToken=>{
            session.accessToken = accessToken;
            return this._checkAccessToken(accessToken);
        })
        .then(accesTokenData=>{
            //all good, the user is authenticate and the session is linked to
            //that authentication.
            // we got a accesTokenData.user.login and accesTokenData.user.id
            // hence, we can put the session to a user
            var user = this._updateUser(accesTokenData.user, true);
            user.sessions.add(session);
            // this marks the end of authorize
            session.user = user;
            _setAuthStatusOK(authStatus, sessionId, session);
            return authStatus;
        }, error=>{
            this._log.error(error);
            authStatus.setStatus(AuthStatus.StatusCode.ERROR);
            authStatus.setMessage(error);
            this._deleteSession(sessionId);
            return authStatus;
        });
};

// get:
// client_id = find at: https://github.com/settings/applications/933523
// see: https://developer.github.com/apps/building-oauth-apps/authorizing-oauth-apps/#1-request-a-users-github-identity
// TODO: use the state parameter!
// <a href="https://github.com/login/oauth/authorize?scope=user:email&client_id=<%= client_id %>">Click here</a> to begin!</a>
// will be sent back to Authorization callback URL:
// https://developer.github.com/apps/building-oauth-apps/authorizing-oauth-apps/#2-users-are-redirected-back-to-your-site-by-github
_p.authorize = function(call, callback) {
    // jshint unused:vars
    var authorizeRequest = call.request
      , gitHubAuthCode = authorizeRequest.getOAuthCode()
      , sessionId = authorizeRequest.getSessionId()
      , authorizeState = authorizeRequest.getAuthorizeState() || ''
      , [   session
          , sessionStatus
          , sessionMessage] = this._getSession(sessionId)
      ;

    if(!session) {
        let authStatus = new AuthStatus();
        authStatus.setStatus(sessionStatus);
        authStatus.setMessage(sessionMessage);
        this._deleteSession(sessionId);
        callback(null, authStatus);
        return;
    }

    if(!session[PENDING]) {
        session[PENDING] = this._authorize(authorizeRequest, sessionId
                            , session, authorizeState, gitHubAuthCode);
        // delete session[pending] when done
        session[PENDING].then(()=>session[PENDING] = null);
    }
    session[PENDING].then(authStatus=>callback(null, authStatus));
};


// so, if the user has an authenticated session we can A) make it time out
// on the server and on the client. So, the server needs some kind of
// garbage collection when the session wasn't read/written to (touched) in
// a certain amount of time.
// The client session is just lost when logging out.
// If we are more confident, we can make it live forever and make
// the server session time out after a week or two. Maybe, we should check
// the access_token regularly then.
// we need garbage collection also, because the user may delete his session
// so why should we keep it around for ever. But maybe, also 2 weeks of
// timing out could be good enough.

_p.checkSession = function(call, callback) {
    var sessionId = call.request.getSessionId()
      , authStatus = new AuthStatus()
      , [   session
          , sessionStatus
          , sessionMessage] = this._getSession(sessionId)
      ;

    if(sessionStatus !== null) {
        // delete if the session is old or otherwise invalidated:
        // send the user through authentication again -> always
        authStatus.setStatus(sessionStatus);
        authStatus.setMessage(sessionMessage);
        this._deleteSession(sessionId);
    }
    else if(session[PENDING]) {
        // we are in the middle of authorize and will answer with its result
        session[PENDING].then(authStatus=>callback(null, authStatus));
        return;
    }
    else if(session.authorizeState !== null) {
        // authorize has not been called since initSession
        authStatus.setStatus(AuthStatus.StatusCode.NOT_READY);
        authStatus.setMessage('GitHub authorization callback pending: '
                            + 'the session is not ready yet.');
    }
    else {
        // the session is good
        // return user/session information
        _setAuthStatusOK(authStatus, sessionId, session);
    }

    callback(null, authStatus);
};

/**
 * The actual call to get the authorized access token.
 */
_p._getAccessToken = function(gitHubAuthCode) {
    return this._sendRequest(
        'https://github.com/login/oauth/access_token'
      , {method: 'POST'}
      , {
            client_id: this._ghOAuth.clientId
          , client_secret: this._ghOAuth.clientSecret
          , code: gitHubAuthCode
        }
    )
    .then(result=>{
            /*
            If this goes wrong we get something like:
            {
                error: 'bad_verification_code',
                error_description: 'The code passed is incorrect or expired.',
                error_uri: 'https://developer.github.com/apps/managing-oauth-apps/troubleshooting-oauth-app-access-token-request-errors/#bad-verification-code'
            }

            If this goes well we get something like this:
            {
                access_token: '9b9209f61b86bd294d9bf8ead1ae0c2e49749108',
                token_type: 'bearer',
                scope: 'user:email'
            }
             */
            if(result.error) {
                this._log.error(result);
                throw new Error('Can\'t authorize at GitHub: ' + result.error);
            }
            else {
                // NOW: use access token to get a authentication, i.e. the
                // user name!
                return result;
            }
        }
        , err=> {
            // This is rather a network or connection problem
            // than a failed access token verfication!
            this._log.error(err);
            throw new Error('Problem calling GitHub.');
        }
    );
};


/**
 * https://api.github.com/applications/453cdec533fdaf45e9d1/tokens/12671fc8ecb11a03b397293d201974d44a72758f
 *
 * Check an authorization
 *
 * OAuth applications can use a special API method for checking OAuth token
 * validity without running afoul of normal rate limits for failed login
 * attempts. Authentication works differently with this particular endpoint.
 * You must use Basic Authentication when accessing it, where the username
 * is the OAuth application client_id and the password is its client_secret.
 * Invalid tokens will return 404 NOT FOUND.
 * ---
 *
 * We use the result of this request as authentication, as the token
 * has a user.login field, with the GitHub handle of the user and
 * a user.id field, which I think we can use as a user id as well.
 *
 *   "user": {
 *       "login": "graphicore",
 *        "id": 393132,
 *    [...]
 *    }
 *
 * This is a complete answer:
 *
 *    {
 *      "id": 236964268,
 *      "url": "https://api.github.com/authorizations/236964268",
 *      "app": {
 *        "name": "Font Bakery Dashboard",
 *        "url": "http://fontbakery.com",
 *        "client_id": "453cdec533fdaf45e9d1"
 *      },
 *      "token": "12671fc8ecb11a03b397293d201974d44a72758f",
 *      "hashed_token": "263e758f59a826680bf2b1b57f16f65c6be9932b0521ee77a0aeab821f7eb7d0",
 *      "token_last_eight": "4a72758f",
 *      "note": null,
 *      "note_url": null,
 *      "created_at": "2018-11-15T14:58:06Z",
 *      "updated_at": "2018-11-15T14:58:07Z",
 *      "scopes": [
 *        "user:email"
 *      ],
 *      "fingerprint": null,
 *      "user": {
 *        "login": "graphicore",
 *        "id": 393132,
 *        "node_id": "MDQ6VXNlcjM5MzEzMg==",
 *        "avatar_url": "https://avatars2.githubusercontent.com/u/393132?v=4",
 *        "gravatar_id": "",
 *        "url": "https://api.github.com/users/graphicore",
 *        "html_url": "https://github.com/graphicore",
 *        "followers_url": "https://api.github.com/users/graphicore/followers",
 *        "following_url": "https://api.github.com/users/graphicore/following{/other_user}",
 *        "gists_url": "https://api.github.com/users/graphicore/gists{/gist_id}",
 *        "starred_url": "https://api.github.com/users/graphicore/starred{/owner}{/repo}",
 *        "subscriptions_url": "https://api.github.com/users/graphicore/subscriptions",
 *        "organizations_url": "https://api.github.com/users/graphicore/orgs",
 *        "repos_url": "https://api.github.com/users/graphicore/repos",
 *        "events_url": "https://api.github.com/users/graphicore/events{/privacy}",
 *        "received_events_url": "https://api.github.com/users/graphicore/received_events",
 *        "type": "User",
 *        "site_admin": false
 *      }
 *    }
 */
_p._checkAccessToken = function({access_token: accessToken}) {
    // jshint unused:vars
    var url = [
                'https://'
              , 'api.github.com'
              , '/applications/'
              , this._ghOAuth.clientId
              , '/tokens/'
              , accessToken
              ].join('')
      ;
    return this._sendRequest(url, {
        method: 'GET'
      , auth: this._ghOAuth.clientId + ':'+ this._ghOAuth.clientSecret
    })
    .then(null, error=>{
        if(error.isHTTPError && error.code === 404) {
            // (Invalid tokens will return 404 NOT FOUND)
            this._log.error(error);
            throw new Error('Access Token is invalid.');
        }
        throw error;
    });
};

module.exports.GitHubAuthServer = GitHubAuthServer;

if (typeof require != 'undefined' && require.main==module) {
    var { getSetup } = require('../util/getSetup')
      , setup = getSetup(), processManager, port=50051;

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
    processManager = new GitHubAuthServer(setup.logging, port);
    processManager.serve();
}
