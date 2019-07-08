#! /usr/bin/env node
"use strict";
/* jshint esnext:true, node:true */

const cookieParser = require('cookie-parser')
  , { AuthStatus, AuthorizeRequest, SessionId } = require('protocolbuffers/messages_pb')
  , { Empty } = require('google-protobuf/google/protobuf/empty_pb.js')
  ;

const SESSION_COOKIE_NAME = 'session.github.oauth';

/**
 * OAuth2: https://tools.ietf.org/html/rfc6749
 *
 * https://developer.github.com/v3/guides/basics-of-authentication/
 * Flask example: https://gist.github.com/ib-lundgren/6507798
 */
function GithubOAuthService(server, app, logging, ghAuthClient, cookieSecret) {
    this._server = server;
    this._app = app;// === express()
    this._log = logging;

    this._ghAuthClient = ghAuthClient;

    // Parse cookies. But I believe this is only for the sub-app ;-)
    // Let's see what happens!
    // With a cookie secret, cookieParser signs the cookie for us,
    // thusly preventing the client from tampering with the cookie value.
    // use `res.cookie('cookie-name', 'value', { signed: true });`
    // `res.cookie will` use the cookieSecret passed to cookieParser!
    // use `req.signedCookies[]`
    if(!cookieSecret || !cookieSecret.length || cookieSecret.indexOf('FIXME:') !== -1)
        this._log.warning('You really should define a proper cookie secret!');
    this._app.use(cookieParser(cookieSecret));

    this._app.get('/', this._authorizationCallback.bind(this));

    this._app.get('/login', this._loginEntryPage.bind(this));

    this._app.post('/logout', this._logout.bind(this));

    this._app.get('/check-session', this._checkLogin.bind(this));

    //this._app.use('/', bodyParser.raw(
    //              {type: 'application/json'}));
}

var _p = GithubOAuthService.prototype;

_p._authAnswerFromAuthStatus = function(authStatus) {
    var answer
      , status = authStatusCodeToKey(authStatus.getStatus())
      ;

    if(status !== 'OK') {
        answer = {
            status: status
          , message: authStatus.getMessage()
        };
    }
    else {
        // client gets authentication token (session id).
        answer = {
            status: 'OK'
          , message: null
          , sessionId: authStatus.getSessionId()
          // also send some user data: gh-handle, profile image url
          , userName: authStatus.getUserName()
          , avatarUrl: authStatus.getAvatarUrl()
        };
    }
    return answer;
};

_p._sendClientAuthentienticationJson = function(req, res, next, authStatus) {
    // jshint unused: vars
    var answer = this._authAnswerFromAuthStatus(authStatus);
    // should we send structured data with Internal Server Error Codes?
    // the client doesn't expect that as of now.
    //if(status === 'ERROR')
    //    res.status(500);
    res.type('json').send(answer);
};

_p._sendClientAuthentienticationWindow = function(req, res, next, authStatus) {
    function escape(str) {
                // single quotes: ' => \'
                // and backslases \"word\" => \\"word\\"
        return str.replace(/['\\]/g, '\\$&')
                // ending tags: </script> => <\/script>
                // it's unlikely, that we send something like this
                // but still good to have some precaution
                  .replace(/<\//g, '<\\/');
    }

    var answer = this._authAnswerFromAuthStatus(authStatus)
      , sessionJSON = escape(JSON.stringify(answer))
      , client = `<!doctype html>
<html>
<head>
    <meta charset="utf-8" />
    <script type="text/javascript">
    var session = JSON.parse('${sessionJSON}');
    window.opener.postMessage({type: 'authentication', session: session}, window.origin);
    </script>
</head><body></body></html>
`;
    res.type('html').send(client);
};

/**
 * Web browsers and other compliant clients will only
 * clear the cookie if the given options is identical
 * to those given to res.cookie(), excluding expires
 * and maxAge.
 *
 * That's why we keep these options centrally.
 *
 * Client: set sessionId
 * OPTIONS (https://expressjs.com/en/api.html#res.cookie):
 *     domain   String; Domain name for the cookie.
 *              Defaults to the domain name of the app.
 *     encode   Function; A synchronous function used for
 *              cookie value encoding. Defaults to
 *              encodeURIComponent.
 *     expires  Date; Expiry date of the cookie in GMT.
 *              If not specified or set to 0, creates
 *              a session cookie.
 *     httpOnly Boolean; Flags the cookie to be accessible
 *              only by the web server.
 *     maxAge   Number; Convenient option for setting the
 *              expiry time relative to the current time
 *              in milliseconds.
 *     path     String; Path for the cookie. Defaults to “/”.
 *     secure   Boolean; Marks the cookie to be used with
 *              HTTPS only.
 *     signed   Boolean; Indicates if the cookie should
 *              be signed.
 *     sameSite Boolean or String; Value of the “SameSite”
 *              Set-Cookie attribute. More information at
 *              https://tools.ietf.org/html/draft-ietf-httpbis-cookie-same-site-00#section-4.1.1.
 */
Object.defineProperty(_p, '_cookieOptions', {
    value: {
          httpOnly: true // not readable by client js
        , signed: true // use cookieSecret
        // , secure: true //FIXME when we use HTTPs
        // , maxAge: null // null === default
        // , path: '/' // '/' === default
    }
});
// Not trusting the express js cookie
// functions keeping our options as it here ;-)
Object.freeze(_p._cookieOptions);

/**
 * POST, because we shouldn't use GET to change server state, ever.
 */
_p._logout = function(req, res, next) {
    // jshint unused: vars
    var promise;
    if(SESSION_COOKIE_NAME in req.signedCookies) {
        // delete the cookie
        res.clearCookie(SESSION_COOKIE_NAME, this._cookieOptions);
        let sessionId = req.signedCookies[SESSION_COOKIE_NAME]
         , sessionIdMessage = new SessionId()
         ;
        sessionIdMessage.setSessionId(sessionId);
        // delete the session
        promise = this._ghAuthClient.logout(sessionIdMessage);
    }
    else
        promise = Promise.resolve(true);

    return promise.then(()=>{
            var authStatus = new AuthStatus();
            authStatus.setStatus(AuthStatus.StatusCode.NO_SESSION);
            authStatus.setMessage('Logged out.');
            return this._sendClientAuthentienticationJson(req, res, next, authStatus);
    });
};

const _authStatusCodeToKeyMap = new Map(Object.entries(AuthStatus.StatusCode).map(([k,v])=>[v,k]))
  , authStatusCodeToKey = (statusCode)=>_authStatusCodeToKeyMap.get(statusCode)
  ;

/**
 * GET
 * responds with application/json
 *
 * do we even need a plain `check_session` interface?
 * or will we just always go via loginEntryPage?
 * it's kind of easiest to always use loginEntryPage ...
 * though, maybe we can spare the client from opening the pop-up!
 * so going via loginEntryPage would happen even less often
 */
_p._checkLogin = function(req, res, next) {
    // jshint unused: vars
    var promise;
    if(!(SESSION_COOKIE_NAME in req.signedCookies)) {
        // This check makes sense, though, the auth server would
        // answer with NO_SESSION anyways
        var authStatus = new AuthStatus();
        authStatus.setStatus(AuthStatus.StatusCode.NO_SESSION);
        authStatus.setMessage('No session cookie found.');
        promise = Promise.resolve(authStatus);
    }
    else {
        var sessionId = req.signedCookies[SESSION_COOKIE_NAME]
          , sessionIdMessage = new SessionId()
          ;
        sessionIdMessage.setSessionId(sessionId);
        promise = this._ghAuthClient.checkSession(sessionIdMessage);
    }
    promise.then(null, error=>{
            this._log.error('_checkLogin', error);
            var authStatus = new AuthStatus();
            authStatus.setStatus(AuthStatus.StatusCode.ERROR);
            authStatus.setMessage('Internal Server Error. Check logs'
                                + ' roughly at ' + new Date());
            return authStatus;
        })
        .then(authStatus=>this._sendClientAuthentienticationJson(
                                            req, res, next, authStatus));
};

/**
 * GET
 * If client is already logged in, i.e. has a valid session, we shouldn't
 * process this request further, (should POST to logout).
 */
_p._loginEntryPage = function(req, res, next) {
    var promise;
    if(SESSION_COOKIE_NAME in req.signedCookies) {
        let sessionId = req.signedCookies[SESSION_COOKIE_NAME]
         , sessionIdMessage = new SessionId()
         ;
        sessionIdMessage.setSessionId(sessionId);
        promise = this._ghAuthClient.checkSession(sessionIdMessage)
            .then(authStatus=>{
                return authStatus.getStatus() === AuthStatus.StatusCode.OK
                    // do the same as after a full succesful login!?
                    // leave this thread
                    ? authStatus
                    // else
                    // init a new session/login
                    // this will log out the client from existing sessions.
                    // "NOT_READY" indicates that the client has visited the
                    // _loginEntryPage but never arrived at _authorizationCallback.
                    // So, something went wrong and he's trying again.
                    // The session will eventually time out. Or some sort
                    // of debugging/inspection is going on, it's not usual
                    // at this point, but not totally strange. The
                    // authorizeUrl stays valid until the session times out.
                    // Other statuses indicate a fubar session that
                    // is already deleted on GitHubAuthServer.
                    : null
                    ;
            });
    }
    else
        // init a new session/login
        promise = Promise.resolve(null);

    return promise.then((authStatus)=>{
        if(authStatus) {
            // status is AuthStatus.StatusCode.OK
            // do the same as after a full successful login.
            return this._sendClientAuthentienticationWindow(req, res, next, authStatus);
        }
        return this._ghAuthClient.initSession(new Empty())
        // probably same message type as a not initial session message,
        // maybe some fields set differenty/not.
        .then(authStatus=>{
            // assert  authStatus.getStatus() === AuthStatus.StatusCode.INITIAL
            var sessionId = authStatus.getSessionId()
              , authorizeUrl = authStatus.getAuthorizeUrl()
              ;
            res.cookie(SESSION_COOKIE_NAME, sessionId, this._cookieOptions);
            // and redirect user to authorizeUrl
            res.redirect(302, authorizeUrl);
        });
    })
    .then(null, error=>{
        this._log.error('_loginEntryPage:', error);
        res.status(500);
        res.send('Internal Error on _loginEntryPage.');
    });
};


/**
 * GET
 *
 * This answers with html.
 *
 * A client using authorizeUrl will be sent back to Authorization callback URL:
 * https://developer.github.com/apps/building-oauth-apps/authorizing-oauth-apps/#2-users-are-redirected-back-to-your-site-by-github
 */
_p._authorizationCallback = function(req, res, next) {
    // jshint unused:vars
    this._log.debug('_authorizationCallback got params:', req.query);

    if(!(SESSION_COOKIE_NAME in req.signedCookies)) {
        // at this point authorization is actually just
        // having a session cookie from _loginEntryPage
        // but without that we can't proceed.
        res.status(401);
        res.send('Authorization Required. Use the login function.');
        // could redirect to the loginEntryPager (HTTP 302 Found)
        // but that depends on the client design.
        return;
    }

    var sessionId = req.signedCookies[SESSION_COOKIE_NAME];

    if(!req.query.code) {
        // could redirect to the loginEntryPage (HTTP 302 Found), but
        // the client handles visiting the loginEntryPage.
        res.status(404);
        res.send('Not Found. The OAuth authorization code is missing. '
               + 'Use the login function.');
        return;
    }

    var authorizeRequest = new AuthorizeRequest();
    authorizeRequest.setOAuthCode(req.query.code);
    authorizeRequest.setSessionId(sessionId);
    if(req.query.state)
        // this._ghAuthClient *most* probably expects this
        // but it sets it itself within `initialSessionMessage.getAuthorizeUrl()`
        authorizeRequest.setAuthorizeState(req.query.state);

    return this._ghAuthClient.authorize(authorizeRequest)
    .then(authStatus=>{
        this._sendClientAuthentienticationWindow(req, res, next, authStatus);
    }, error=> {
        this._log.error('_authorizationCallback:', error);
        res.status(500);
        res.send('Internal Error on _authorizationCallback.');
    });
};


module.exports.GithubOAuthService = GithubOAuthService;

if (typeof require != 'undefined' && require.main==module) {
    throw new Error ('Does not implemented a CLI!');
}
