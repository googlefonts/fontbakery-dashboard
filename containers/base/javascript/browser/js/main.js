//jshint esversion:6
define([
    'dom-tool'
  , 'socket.io'
  , 'Controller'
  , 'Report'
  , 'CollectionController'
  , 'StatusController'
  , 'CollectionReport'
  , 'DashboardController'
  , 'DispatcherController'
  , 'DispatcherLists'
], function(
    dom
  , socketio
  , Controller
  , Report
  , CollectionController
  , StatusController
  , CollectionReport
  , DashboardController
  , DispatcherController
  , DispatcherLists
) {
    "use strict";
    /*global document, window, FileReader, Set, console*/
    //jshint browser:true

    const {
        DispatcherListsController
      , DispatcherListQueryUIController
    } = DispatcherLists;

    function makeFileInput(fileOnLoad, element) {
        var hiddenFileInput = dom.createChildElement(element, 'input'
                                , {type: 'file', 'multiple': 'multiple'});
        hiddenFileInput.style.display = 'none';

        function handleFiles(files) {
            var i, l, reader, file;
            for(i=0,l=files.length;i<l;i++) {
                file = files[i];
                reader = new FileReader();
                reader.onload = fileOnLoad.bind(null, file);
                reader.readAsArrayBuffer(file);
            }
        }

        // for the file dialogue
        function fileInputChange(e) {
            /*jshint validthis:true, unused:vars*/
            handleFiles(this.files);
            document.getElementById("dropzoneContainer").classList.remove("dragover");
            document.getElementById("dropzoneContainer").classList.add("filled");
            document.getElementById("file-bar").classList.remove("hidden");
            document.getElementById("run-button").classList.remove("hidden");
        }

        function forwardClick(e) {
            /*jshint unused:vars*/
            // forward the click => opens the file dialogue
            hiddenFileInput.click();
        }

        // for drag and drop
        function noAction(e) {
            e.stopPropagation();
            e.preventDefault();
        }

        function drop(e) {
            document.getElementById("dropzoneContainer").classList.remove("dragover");
            document.getElementById("dropzoneContainer").classList.add("filled");
            document.getElementById("file-bar").classList.remove("hidden");
            document.getElementById("run-button").classList.remove("hidden");
            e.stopPropagation();
            e.preventDefault();
            handleFiles(e.dataTransfer.files);
        }

        function colorBackground() {
          document.getElementById("dropzoneContainer").classList.add("dragover");
        }

        function unColorBackground() {
          document.getElementById("dropzoneContainer").classList.remove("dragover");
        }


        hiddenFileInput.addEventListener('change', fileInputChange);
        element.addEventListener("dragenter", colorBackground);
        element.addEventListener("dragover", noAction);
        element.addEventListener("dragleave", unColorBackground);
        element.addEventListener("drop", drop);

        // Open file browser on click
        document.getElementById("browse-link").addEventListener('click', forwardClick);
    }

    function initFileInputs(fileOnLoad, container, klass) {
        var _makefileInput =  makeFileInput.bind(null, fileOnLoad);
        Array.from(container.getElementsByClassName(klass)).forEach(_makefileInput);
    }

    function getTemplatesContainer(klass) {
        return document.querySelector('body > .' + klass);
    }

    function activateTemplate(klass) {
        var templatesContainer = getTemplatesContainer('templates')
          , target = document.getElementsByClassName('active-interface')[0]
          ;
        dom.clear(target, 'destroy');
        return activateElement(templatesContainer, klass, target, null);
    }

    function activateElement(templatesContainer, klass, targetContainer, markerComment) {
        console.log('activateElement', templatesContainer, klass, targetContainer, markerComment);
        var templateString = templatesContainer.innerHTML;
        var template = document.createRange().createContextualFragment(templateString);
        var activatedElement = template.querySelector("." + klass);

        if(!markerComment)
            targetContainer.appendChild(activatedElement);
        else
            dom.insertAtMarkerComment(targetContainer, markerComment, activatedElement, false);
        return activatedElement;
    }

    function initDNDSendingInterface() {
        var container = activateTemplate('sending-interface')
          , ctrl = new Controller(
                  container.getElementsByClassName('files-controls')[0]
                , container.getElementsByClassName('general-controls')[0]
            )
          ;
        initFileInputs(ctrl.fileOnLoad, container, 'drop-fonts');
        ctrl.onResponse(initReportingInterface);
    }

    function initReportingInterface(data) {
        var container = activateTemplate('reporting-interface')
          , templatesContainer = getTemplatesContainer('report-templates')
          , socket = socketio('/')
          , report = new Report(container, templatesContainer, data)
          , subscriptionRequest = 'subscribe-report'
          ;

        function subscribe() {
            return socket.emit(subscriptionRequest, { id: data.id });
        }

        socket.on('changes-report', report.onChange.bind(report));
        subscribe();

        // A disconnection will unsubscribe the socket on the server
        // we'll have to reconnect
        // since this is a new subscription, the server will send an
        // initial document and it seems like the client is re-initializing
        // the document correctly. CAUTION, this could be a source of a
        // hard to find bug, but it seems alright.
        function reconnectHandler (attemptNumber) {
            console.log('socket on reconnect', '#'+attemptNumber+':', subscriptionRequest);
            subscribe();
        }
        socket.on('reconnect', reconnectHandler);
    }

    function _initCollectionsInterface() {
        var container = activateTemplate('collection-landing-page')
          , ctrl = new CollectionController(container)
          ;
          return ctrl;
    }

    function _initStatusInterface() {
        var container = activateTemplate('status-landing-page')
          , ctrl = new StatusController(container)
          ;
        return ctrl;
    }

    function initCollectionReportInterface(data) {
        var container = activateTemplate('collection-report-interface')
          , templatesContainer = getTemplatesContainer('collection-report-templates')
          , socket = socketio('/')
          , report = new CollectionReport(container, templatesContainer, data)
          , subscriptionRequest = 'subscribe-collection'
          ;

        function subscribe() {
            socket.emit(subscriptionRequest, { id: data.id });
        }

        socket.on('changes-collection', report.onChange.bind(report));
        subscribe();
        // A disconnection will unsubscribe the socket on the server
        // we'll have to reconnect
        // since this is a new subscription, the server will send an
        // initial document and it seems like the client is re-initializing
        // the document correctly. CAUTION, this could be a source of a
        // hard to find bug, but it seems alright.
        function reconnectHandler (attemptNumber) {
            console.log('socket on reconnect', '#'+attemptNumber+':', subscriptionRequest);
            subscribe();
        }
        socket.on('reconnect', reconnectHandler);
    }


    // also used on the server, but useful in the client as well
    function _dashboarNormalizeFilter(userInputfilter) {
        return userInputfilter
            ? userInputfilter.split(',')
                  .map(function(s){return s.trim();})
                  .filter(function(s){return !!s;})
                  .sort()
                  .join(',')
            : ''
            ;
    }

    function initDashboard(data) {
        var socket = socketio('/')
         , lastQuery = null
         , socketChangeHandler = null
         , subscriptionRequest = 'subscribe-dashboard'
         , subscribe = null
         ;

        function reconnectHandler (attemptNumber) {
            if(subscribe === null) return;
            console.log('socket on reconnect', '#'+attemptNumber+':', subscriptionRequest);
            subscribe();
        }

        function onQueryFilterChange() {
            ignoreNextPopState = true;
            var hash = decodeURIComponent(window.location.hash) // it's a firefox bug apparently
              , marker = '#filter:'
              , userInputFilter = ''
              , queryFilter
              ;
            if(hash.indexOf( marker) === 0)
                userInputFilter = hash.slice(marker.length);


            queryFilter = _dashboarNormalizeFilter(userInputFilter);
            // set the normalized value
            window.location.hash = queryFilter ? marker.slice(1) + queryFilter : '';

            // did it really change?
            if(lastQuery === queryFilter)
                return;
            lastQuery = queryFilter;

            if(socketChangeHandler) {
                socket.off('changes-dashboard', socketChangeHandler);
                socket.off('reconnect', reconnectHandler);
                socketChangeHandler = null;
                subscribe = null;
            }
            // replace the whole thing!
            var container = activateTemplate('dashboard-interface')
              , templatesContainer = getTemplatesContainer('dashboard-templates')
              , dashboard = new DashboardController(container, templatesContainer, data)
              ;

            window.addEventListener('hashchange', onQueryFilterChange, false);
            container.addEventListener('destroy', function(){
                window.removeEventListener('hashchange', onQueryFilterChange, false);
            }, false);

            console.log('subscribe-dashboard, filter:' + queryFilter);
            socketChangeHandler = dashboard.onChange.bind(dashboard);
            subscribe = function() {
                return socket.emit('subscribe-dashboard', {filter: queryFilter});
            };
            socket.on('changes-dashboard', socketChangeHandler);
            socket.on('reconnect', reconnectHandler);
            subscribe();
        }

        // init
        onQueryFilterChange();
    }

    function initDispatcher(data, authController) {
        var container = activateTemplate('dispatcher-interface')
         , templatesContainer = getTemplatesContainer('dispatcher-templates')
         , socket = socketio('/')
         , ctrl = new DispatcherController(container, templatesContainer, socket, data)
         , sessionChangeHandler = ctrl.sessionChangeHandler.bind(ctrl)
         , unsubscribeSessionChange = authController.onSessionChange(sessionChangeHandler, true)
         ;
        container.addEventListener('destroy', unsubscribeSessionChange, false);
        return ctrl;
    }

    function initDispatcherLists(data/*, authController*/) {
        var container = activateTemplate('dispatcher-lists')
         , templatesContainer = null//getTemplatesContainer('dispatcher-templates')
         , socket = socketio('/')
         // There's just one set of channels for receiving these lists
         // and their updates, this separates the messages and sends
         // them to the subscribers.
         , listsCtrl = new DispatcherListsController(socket, data)
         // We can have multiple of these lists in a document, think of
         // a dashboard of interesting lists.
         , listUICtrl =  new DispatcherListQueryUIController(container
                                , templatesContainer, listsCtrl, data)
         ;
         // will be nice, to know if there's a "my-processes" list.
         //, sessionChangeHandler = dispatcher.sessionChangeHandler.bind(dispatcher)
         //, unsubscribeSessionChange = authController.onSessionChange(sessionChangeHandler, true)
        container.addEventListener('destroy'
                            , listsCtrl.destroy.bind(listsCtrl), false);
        return [listsCtrl, listUICtrl];
    }

    var AuthenticationController = (function(){
    function AuthenticationController(element) {
        this._loginURL = '/github-oauth/login';
        this._element = element;
        this._button = this._element.querySelector('button.action');
        this._user = this._element.querySelector('.user');
        this._lastLoginWindow = null;

        this._button.addEventListener('click', this._actionHandler.bind(this),false);
        this.window.addEventListener('message', this._onMessage.bind(this), false);

        this._sessionChangeHandlers = new Set();

        // needs checkSession for init
        // just to have the name officially defined for now
        this._session = null;
        // run the setter
        this._setSession(null);
    }
    var _p = AuthenticationController.prototype;

    _p.onSessionChange = function(callback, initial) {
        this._sessionChangeHandlers.add(callback);
        if(initial)
            callback(this.session);
        return function (){
            this._sessionChangeHandlers.delete(callback);
        }.bind(this);
    };

    function _sendXHR (verb/*GET|POST*/,url, responseType, body, contenType) {
        var xhr = new XMLHttpRequest();
        xhr.open(verb, url);
        if(contenType)
            xhr.setRequestHeader('Content-Type', contenType);
        xhr.send(body || null);
        xhr.responseType = responseType;

        return new Promise(function(resolve, reject) {
            xhr.onreadystatechange = function () {
                if(xhr.readyState !== XMLHttpRequest.DONE)
                    return;
                if(xhr.status !== 200) {
                    // We could handle other status codes reasonably here
                    // especially if they are still structured as expected.
                    // Though, the we may find well structured and not well
                    // structured responses.
                    // We could create a well structured response here and
                    // then: `resolve(errorResponse);`
                    reject(new Error(xhr.status + ': ' + xhr.statusText));
                }
                else
                    resolve(xhr.response);
            };
        });
    }

    _p._expectStatus = function(initiator, promise) {
        return promise.then(
            function(result) {
                this._setSession(result);
                return this.loggedIn;
            }.bind(this)
          , function(error) {
                console.error(initiator + ':', error);
                // can't change status, because we don't know what it is
            });
    };

    _p.checkSession = function() {
        return this._expectStatus(
                'sendXHRCheckSession'
              , _sendXHR('GET', '/github-oauth/check-session', 'json')
        );
    };

    function _toFeatureString(obj) {
        var key, val, parts = [];
        for (key in obj) {
            val = obj[key];
            if(typeof val === "boolean")
                val = obj[key] && 'yes' || 'no';
            parts.push(key + '=' + val);
        }
        return parts.join(',');
    }

    _p._openLoginWindow = function() {
        var window = this.window
          , url = window.location.protocol + '//' + location.host + this._loginURL
          , width = Math.max(Math.min(750, window.screen.availWidth), 100)
          , height = Math.max(Math.min(950, window.screen.availHeight), 100)
          , options = {
                 width: width
               , height: height
                 // trying to do some half-way reasonable positioning
               , left: window.screenX + ((window.outerWidth - width) / 2)
               , top: window.screenY + ((window.outerHeight - height) / 2.5)
               , toolbar: false
               , menubar: false
               , location: true
               , resizable: true
               , scrollbars: true
               , status: true
            }
          , strWindowFeatures = _toFeatureString(options)
          ;
        this._lastLoginWindow = this.window.open(url, 'login', strWindowFeatures);
    };

    /**
     * event.data
     *     The object passed from the other window.
     *
     * event.origin
     *     The origin of the window that sent the message at the time
     *     ostMessage was called. This string is the concatenation of
     *     the protocol and "://", the host name if one exists, and ":"
     *     followed by a port number if a port is present and differs
     *     from the default port for the given protocol. Examples of
     *     typical origins are https://example.org (implying port 443),
     *     http://example.net (implying port 80), and http://example.com:8080.
     *     Note that this origin is not guaranteed to be the current or
     *     future origin of that window, which might have been navigated
     *     to a different location since postMessage was called.
     *
     * event.source
     *     A reference to the window object that sent the message; you
     *     can use this to establish two-way communication between
     *     two windows with different origins.
     */
    _p._onMessage = function(event) {
        // window.opener.postMessage({type: 'authentication', session: session}, window.origin);
        var data = event.data;
        if(event.source !== this._lastLoginWindow)
            // wrong source;
            return;

        if(event.origin !== this.window.origin)
            // wrong origin
            return;

        if(!('type' in data) || data.type !== 'authentication')
            // not our business
            return;

        // accepted
        this._setSession(data.session);
        this._lastLoginWindow.close();
        this._lastLoginWindow = null;
    };

    _p._login = function() {
        // login flow is:
        //
        // GET: checkSession
        //     if we have don't have a login
        // window open login page
        // listen for window.message
        this.checkSession().then(function(loggedIn){
            if(loggedIn) return;
            this._openLoginWindow();
        }.bind(this));
    };

    _p.logout = function() {
        return this._expectStatus(
                'logout'
              , _sendXHR('POST', '/github-oauth/logout', 'json')
        );
    };

    // when the login/logout button is used
    _p._actionHandler = function(event) {
        // jshint unused:vars
        if(!this.loggedIn)
            this._login();
        else
            this.logout();
    };

    _p._setSession = function(session) {
        this._session = session || null;
        this._setLoginInterface();
        this._sessionChangeHandlers.forEach(function(callback){
             callback(this.session);
        }.bind(this));

    };

    Object.defineProperties(_p, {
        session: {
            get: function(){
                return this._session || {
                    state: 'NEEDS_INIT'
                  , message: 'Authentication is not initialized yet.'
                };
            }
        }
      , loggedIn: {
            get: function(){
                return this.session.status === 'OK';
            }
        }
      , window: {
            get: function(){
                return this._element.ownerDocument.defaultView;
            }
        }
    });

    _p._setLoginInterface = function() {
        var userChildren;
        if(this.loggedIn) {
            var session = this.session;
            this._button.textContent = 'logout';
            userChildren = [
                dom.createElement('img', {src: session.avatarUrl})
              , ' '
              , dom.createElement('strong', null, session.userName)
            ];
        }
        else {
            this._button.textContent = 'login with GitHub';
            userChildren = [dom.createElement('strong', null, '')];
        }
        dom.clear(this._user);
        dom.appendChildren(this._user, userChildren);
    };

    return AuthenticationController;
    })();

    function initAutentication() {
        var templatesContainer = getTemplatesContainer('templates')
          , header = document.querySelector('body header')
          , authenticationElement = activateElement(templatesContainer, 'authentication'
                                              , header, 'insert: authentication-ui')
          ;
          return new AuthenticationController(authenticationElement);
    }

    function getInterfaceMode() {
        var data = null
          , defaultMode = 'drag-and-drop'
          , defaultData = null
          , mode, init
          , pathparts = window.location.pathname.split('/')
          , parameters = []
          , i, l
          , modes = {
                // path-marker: "mode"
                // We use a mapping here for historical reasons.
                // Could maybe get rid of it.
                // Font Bakery result report
                report:  initReportingInterface
                // list of links to font bakery collection-reports
                // just one simple GET request
              , collections: _initCollectionsInterface
                // list of (source) status report logs
                // has infinite scroll/pagination
              , status: _initStatusInterface
                // individual (source) status report logs
              , 'status-report': function(){} // No action, is server side rendered.
              , 'collection-report': initCollectionReportInterface
              , 'drag-and-drop': initDNDSendingInterface
              , 'dashboard': initDashboard
              , 'dispatcher': initDispatcher
              , 'dispatcher/lists': initDispatcherLists
              , 'dispatcher/lists-query': initDispatcherLists
            }
          ;
        mode = defaultMode;
        // change mode?
        outer:
        for(i=0,l=pathparts.length;i<l;i++) {
            // removes parts from the front, maybe the root is in a sub-path
            // but there's currently no case for this so this.
            let subparts = pathparts.slice(i);
            while(subparts.length) {
                let testmode = subparts.join('/');
                if(testmode in modes) {
                    mode = testmode;
                    parameters = pathparts.slice(i + subparts.length);
                    break outer;
                }
                //Remove from the back, maybe there are parameters
                // that way we match the most specific (longest name)
                // mode.
                subparts.pop();
            }
        }
        init = modes[mode];
        // extra data for mode?
        i=0; //reset, i in parameters now
        switch(mode) {
            case('dispatcher/lists'):
            // falls through
            case('dispatcher/lists-query'):
                data = {
                    parameters: parameters
                  , url:  window.location.pathname
                  , mode: mode
                  , search: window.location.search
                };
                break;
            case('dispatcher'):
                if(parameters[0]==='process')
                    i = 1; // => dispatcher/process/{id}
                    // falls through
                    // now behaves exactly like report, but `id` is for process_id
                else {
                    data = defaultData;
                    break;
                }// jshint ignore:line
            case('collection-report'):
            // falls through
            // behaves exactly like report, but `id` is for collection_id
            case('report'):
                // if 'reporting/' in url
                // familytests_id is at reporting/{id}
                data = {
                    id: decodeURIComponent(parameters[i])
                  , parameters: parameters
                  , url:  window.location.pathname
                };
                break;
            //case('collection'):
            //case('drag-and-drop'):
            //case('dashboard'):
            default:
                data = defaultData;
            break;
        }
        return [data, init];
    }

    var ignoreNextPopState = false;// bad hack;
    return function main() {
        var authController = initAutentication();
        // returns a promise: true === logged in; false === logged out
        authController.checkSession();

        // here's an early difference:
        // either we want to bootstrap the sending interface OR the
        // reporting interface.
        // The sending interface will also transform into the reporting interface.

        var [data, init] = getInterfaceMode();
        init(data, authController);
        // Using pushState changes the behavior of the browser back-button.
        // This is intended to make it behave as if pushState was not used.
        window.onpopstate = function(event) {
            // jshint unused:vars
            if(ignoreNextPopState) {
                ignoreNextPopState = false;
                event.preventDefault();
                return;
            }
            window.location.reload();
        };
    };
});
