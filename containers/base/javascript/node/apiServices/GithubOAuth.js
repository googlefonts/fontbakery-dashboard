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
function GithubOAuthService(server, app, logging) {
    this._server = server;
    this._app = app;// === express()
    this._log = logging;


    // Parse cookies. But I believe this is only for the sub-app ;-)
    // Let's see what happens!
    // With a cookie secret, cookieParser signs the cookie for us,
    // thusly preventing the client from tampering with the cookie value.
    this._log.warning('FIXME: configure a cookie secret!');
    var cookieSecret = 'FIXME: configure a cookie secret!';
    // use `res.cookie('cookie-name', 'value', { signed: true });`
    // `res.cookie will` use the cookieSecret passed to cookieParser!
    // use `req.signedCookies[]`
    this._app.use(cookieParser(cookieSecret));

    this._app.get('/', this._authorizationCallback.bind(this));

    this._app.get('/login', this._loginEntryPage.bind(this));

    //this._app.use('/', bodyParser.raw(
    //              {type: 'application/json'}));
}

var _p = GithubOAuthService.prototype;

_p._sendClientAuthentientication = function(req, resp, next, authStatus) {
    TODO;
    // jshint unused: vars
    // load some sort of client
    // -> the client will:
    // window.opener.postMessage({sessionId, userName, avatarUrl}, window.origin);
    // and the  authentication requesting window will listen to the message event!
    // Then, the client window will then close itself.

    //So, either: "Login failed with message ..."
    //or sessionId, userName, avatarUrl

    // this is possible as well!
    // then there will be a `authStatus.getMessage()` with some information.
    if(authStatus.getStatus() !== AuthStatus.StatusCode.OK){
        {

        }
    }
    else {
        // client gets authentication token (session id).
        {
            sessionId: authStatus.getSessionId()
          , userName: authStatus.getUserName()
          , avatarUrl: authStatus.getAvatarUrl()

        }
    }
    // maybe also send some user data: gh-handle, profile image url
};

/**
 * Web browsers and other compliant clients will only
 * clear the cookie if the given options is identical
 * to those given to res.cookie(), excluding expires
 * and maxAge.
 *
 * That's why we keep these options centrally.
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
// functions keeping our options as it here, ;-)
Object.freeze(_p._cookieOptions);

/**
 * POST
 */
_p._logout = function(req, resp, next) {
    // jshint unused: vars
    if(SESSION_COOKIE_NAME in req.signedCookies) {
        // delete the cookie
        res.clearCookie(SESSION_COOKIE_NAME, this._cookieOptions);
        let sessionId = req.signedCookies[SESSION_COOKIE_NAME]
         , sessionIdMessage = new SessionId()
         ;
        sessionIdMessage.setSessionId(sessionId);
        // delete the session
        this._ghAuthClient.logout(sessionIdMessage);
    }
    // no answer message required
    res.status(200);
};

/**
 * GET
 *
 * do we even need a plain `check_session` interface?
 * or will we just always go via loginEntryPage?
 * it's kind of easiest to always use loginEntryPage ...
 * though, maybe we can spare the client from opening the pop-up!
 * so going via loginEntryPage would happen even less often
 */
_p._checkLogin = function(req, resp, next) {
    if(SESSION_COOKIE_NAME in req.signedCookies) {
        var sessionId = req.signedCookies[SESSION_COOKIE_NAME];
        sessionIdMessage = new SessionId();
        sessionIdMessage.setSessionId(sessionId);
        this._ghAuthClient.checkSession(sessionIdMessage)
            .then(authStatus=>{

            });
    }
    else
        Answer: NO_SESSION
};



login flow is:

GET: checkLogin
    if we have don't have a login
window open login page
listen for window.message





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
            return this._sendClientAuthentientication(req, res, next, authStatus);
        }
        return this._ghAuthClient.initSession(new Empty())
        // probably same message type as a not initial session message,
        // maybe some fields set differenty/not.
        .then(authStatus=>{
            // assert  authStatus.getStatus() === AuthStatus.StatusCode.INITIAL
            var sessionId = authStatus.getSessionId()
              , authorizeUrl = authStatus.getAuthorizeUrl()
              ;
            // Client: set sessionId
            // OPTIONS (https://expressjs.com/en/api.html#res.cookie):
            //     domain   String; Domain name for the cookie.
            //              Defaults to the domain name of the app.
            //     encode   Function; A synchronous function used for
            //              cookie value encoding. Defaults to
            //              encodeURIComponent.
            //     expires  Date; Expiry date of the cookie in GMT.
            //              If not specified or set to 0, creates
            //              a session cookie.
            //     httpOnly Boolean; Flags the cookie to be accessible
            //              only by the web server.
            //     maxAge   Number; Convenient option for setting the
            //              expiry time relative to the current time
            //              in milliseconds.
            //     path     String; Path for the cookie. Defaults to “/”.
            //     secure   Boolean; Marks the cookie to be used with
            //              HTTPS only.
            //     signed   Boolean; Indicates if the cookie should
            //              be signed.
            //     sameSite Boolean or String; Value of the “SameSite”
            //              Set-Cookie attribute. More information at
            //              https://tools.ietf.org/html/draft-ietf-httpbis-cookie-same-site-00#section-4.1.1.
            res.cookie(SESSION_COOKIE_NAME, sessionId, {
                    httpOnly: true // not readable by client js
                  , signed: true // use cookieSecret
                  // , secure: true //FIXME when we use HTTPs
                  // , maxAge: null // null === default
                  // , path: '/' // '/' === default
            });
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
        this._sendClientAuthentientication(req, res, next, authStatus);
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
