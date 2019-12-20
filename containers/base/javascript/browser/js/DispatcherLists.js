define([
    'dom-tool'
  , 'UserLog'
], function(
    dom
  , UserLog
) {
    /* jshint browser:true, esnext:true*/
    /*global console*/
    "use strict";

    // matches ?q= or &q= until the next & or to the end includes
    // the "q=" part.
    // example: "http://hello.example/lists?q=family:ABeeZeee&some=other"
    // > window.location.search.match(r)[1]
    // "q=family:ABeeZeee"
    var matchURLQuery = /[\?&](q=[^&]*)/;

    const GenericDispatcherListController = (function() {
    /**
     * This is controlling just a single list.
     */
    function GenericDispatcherListController(container, queryAPI, log) {
        this._container = container;
        this._queryAPI = queryAPI;
        this._log = log;

        this._container.addEventListener('destroy', this.destroy.bind(this), false);

        this._roomId = null;
        //this._queryList(query, true);
    }

    var _p = GenericDispatcherListController.prototype;

    /**
     * Will be used with an empty array as listData to reset the
     * interface when a room was changed.
     */
    _p._renderList = function(listData) {
        console.log('_renderList -> listData', listData.length, listData);
        var target = dom.getMarkerComment(this._container, 'insert: dispatcher-list-item');
        while(target.parentNode.lastChild !== target)
            dom.removeNode(target.parentNode.lastChild);

        var listItems = [];
        for(let i=0,l=listData.length;i<l;i++){
            let {created, id, initiator, familyName} = listData[i]
              , execLog = listData[i].execLog
              , lastExecLog = execLog && execLog[execLog.length-1]
              , changed = lastExecLog && lastExecLog[0] || created
              ;
            listItems.push(dom.createElement('li', null, `${created} ${initiator} ${familyName} ${changed} ${id}`));
        }
        dom.insert(target, 'after', dom.createFragment(listItems));
    };

    /**
     * send the query to subscribe-dispatcher-list
     */
    _p._sendQuery = function(query, asChangeFeed) {
        return this._queryAPI.subscribeTo(this
                            , query
                            , asChangeFeed
                            , this._renderList.bind(this));
    };

    /**
     * This is to be implemented by the actual interface controller.
     * The aim is to update the source of the query-string that was
     * sent to the server with the canonical result in the response of
     * the server.
     * After using this, e.g. _getQuery should return the canonical query
     * either in user or in url format. url format starts with "q="
     */
    _p._receiveCanonicalQuery = function(canonicalQuery) {
        // jshint unused:vars
        throw new Error('Not implemented: _receiveCanonicalQuery');
    };

    /**
     * This is to be implemented by the actual interface controller.
     * The aim is to indicate whether the user is looking at a live
     * streamed, updating list or as a static list.
     */
    _p._setIsChangeFeed = function(isChangeFeed) {
        // jshint unused:vars
        throw new Error('Not implemented: _setIsChangeFeed');
    };

    /**
     * Change the List
     */
    _p._queryList = function(query, asChangeFeed) {
        // In any case, this should clear the contents, for ease
        // of use. Some subscriptions don't produce any output and
        // hence never report anything.
        console.log('_queryList query:', query, 'asChangeFeed', asChangeFeed);
        return this._sendQuery(query, asChangeFeed)
        .then(({/* roomId, */canonicalQuery, isChangeFeed})=>{
            // Room subscription stuff is handled by parent.
            // This subscriber can only be in one room at a time

            //The canonical query may be changed (via server response),
            // change the input field and maybe also the window URL.
            // this._queryField.value = canonicalQuery.user;
            this._log.info(`Got callback isChangeFeed ${isChangeFeed}`
                            , canonicalQuery.user, canonicalQuery.url);
            this._receiveCanonicalQuery(canonicalQuery);
            this._setIsChangeFeed(isChangeFeed);
        });
    };

    _p.destroy = function(e) {
        // jshint unused:vars
        this._log.info('GenericDispatcherListController received destroy event.');
        return this._queryAPI.unsubscribe(this);
    };

    /**
     * Shared helper, no side effects.
     */
    _p._setURLQueryToHref = function(href, urlQuery) {
        var pureURLQuery = urlQuery.slice(2)// remove "q="
          , url = new URL(href)
          , newUrl
          ;

        if(pureURLQuery !== '') {
            url.searchParams.set('q', 'REPLACEMENTMARKER');
            // searchParams.set URLEncodes the value, but we have done
            // that already sufficiently and optimized for better readability
            // on the server.
            newUrl = url.href.replace('q=REPLACEMENTMARKER', urlQuery);
        }
        else {
            url.searchParams.delete('q');
            newUrl = url.href;
        }
        return newUrl;
    };

    return GenericDispatcherListController;
    })();

    const DispatcherListQueryUIController = (function() {
    const Parent = GenericDispatcherListController;

    function DispatcherListQueryUIController(container, templatesContainer
                    , queryAPI, data) {
        this._templatesContainer = templatesContainer;
        var log = new UserLog(dom.createElement('ol', {class: 'user-log'}));

        Parent.call(this, container, queryAPI, log);

        dom.appendChildren(this._container, [
            this._log.container
        ]);
        this._log.reatached();

        this._queryField = dom.createElement('input', {
                type: 'text'
              , name: 'query-process-list'
              , value: ''
            });
        this._queryFieldSend = dom.createElement('input', {type: 'button', name: 'send-process-list-query', value: 'send'});
        this._queryFieldSend.addEventListener('click', ()=>this._queryList(...this._getQuery()));

        dom.appendChildren(this._container, [
            this._queryField
          , ' '
          , this._queryFieldSend
        ]);

        // on load, if there's a query in the url ...
        var urlQueryMatch = data.search.match(matchURLQuery)
           , urlQuery = urlQueryMatch ? urlQueryMatch[1] : ''
           ;
        // hmm this seems to unescape much of the query which makes
        // it useless as url query...
        //var urlSearchParams = new URLSearchParams(data.search)
        //  , urlQuery = urlSearchParams.has('q') ? `q=${urlSearchParams.get('q')}` : ''
        //  ;
        this._queryList(urlQuery, true);
    }
    const _p = DispatcherListQueryUIController.prototype = Object.create(Parent.prototype);

    /**
     * Get the new query from the input field, maybe also window URL or
     * if specified differently, from there.
     */
    _p._getQuery = function() {
        return [this._queryField.value, true];
    };

    _p._receiveCanonicalQuery = function(canonicalQuery) {
        var newUrl = this._setURLQueryToHref(window.location.href
                                           , canonicalQuery.url);
        if(newUrl !== window.location.href)
            window.history.pushState(null, null, newUrl);
        this._queryField.value = canonicalQuery.user;

    };

    /**
     * This is to be implemented by the actual interface controller.
     * The aim is to indicate whether the user is looking at a live
     * streamed, updating list or as a static list.
     */
    _p._setIsChangeFeed = function(isChangeFeed) {
        // jshint unused:vars
        // TODO:
        this._log.info(`TODO _setIsChangeFeed: (${isChangeFeed})`);
    };

    return DispatcherListQueryUIController;
    })();

    const DispatcherListsSimpleUIController = (function() {
    const Parent = GenericDispatcherListController;
    function DispatcherListsSimpleUIController(container, queryAPI
                    , log, title, description, query, asChangeFeed) {
        console.log('init DispatcherListsSimpleUIController', title, description, query, asChangeFeed);
        Parent.call(this, container, queryAPI, log);

        dom.insertAtMarkerComment(this._container, 'insert: title'
                                            , dom.createTextNode(title));
        if(description)
            dom.insertAtMarkerComment(this._container, 'insert: description'
                                , dom.createElement('p', {}, description));
        this._drilldownLink = dom.createElement('a', {}, 'drilldown');
        dom.insertAtMarkerComment(this._container, 'insert: drilldown-link'
                                                    , this._drilldownLink);
        // this thing is going to do two things:
        // a: query and display the result, live if it is a feed
        // b: show a link to the query in the query editor window
        //
        // no paging! -> just the x first rows
        // no query editing
        // no re-ordering
        // etc.
        // all these can be done in the more complete query editor.
        //
        // Maybe, the parent could change the query when running?
        // in that case, we shouldn't probably not query on init at all,
        // it's not the most flexible thing to do anyways.
        this._queryList(query, asChangeFeed);
    }

    const _p = DispatcherListsSimpleUIController.prototype = Object.create(Parent.prototype);

    _p._receiveCanonicalQuery = function(canonicalQuery) {
        var {user, url}= canonicalQuery
          , baseHref = '/dispatcher/lists-query'
            // an empty/default query would appear as "q="
          , href = url !== 'q='
                                ?`${baseHref}?${url}`
                                : baseHref
          ;
        this._drilldownLink.setAttribute('href', href);
        this._drilldownLink.setAttribute('title', user);
    };

    /**
     * This is to be implemented by the actual interface controller.
     * The aim is to indicate whether the user is looking at a live
     * streamed, updating list or as a static list.
     */
    _p._setIsChangeFeed = function(isChangeFeed) {
        // jshint unused:vars
        // TODO:
        // maybe turn a info marker on or so.
        this._log.info(`TODO _setIsChangeFeed: (${isChangeFeed})`);
        // hmm, given that in this case thiswill only be called once
        // because we don't query twice with these elements, this is
        // somehow OK. However, If we'd run this repeatedly,the last time
        // inserted element would have to  be removed here again.
        // But, this will rather be solved with a css class toggle, than
        // a inserted element,
        dom.insertAtMarkerComment(this._container
                , 'insert: is-change-feed-indicator'
                , dom.createElement('span', {}, isChangeFeed
                                                    ? 'live feed'
                                                    : 'static list'));
    };

    return DispatcherListsSimpleUIController;
    })();


    function _getElementFromTemplate(klass, deep, container) {
        var template = dom.getChildElementForSelector(container
                                                    , '.' + klass, deep)
          ;
        return template ? template.cloneNode(true) : null;
    }

    /**
     * This will initiate a couple of instances of
     * DispatcherListsSimpleUIController to show a dashboard like
     * overview if many lists.
     *
     */
    const DispatcherListsCollectionController = (function() {


    function DispatcherListsCollectionController(container, templatesContainer
                        , queryAPI, setup) {
        this._container = container;
        this._templatesContainer = templatesContainer;
        this._queryAPI = queryAPI;
        this._setup = setup;

        this._log = new UserLog(dom.createElement('ol', {class: 'user-log'}));
        dom.appendChildren(this._container, [
            this._log.container
        ]);
        this._log.reatached();

        this._children = new Set();

        var urlQueryMatch = setup.search.match(matchURLQuery)
           , urlQuery = urlQueryMatch ? urlQueryMatch[1].slice(2) : ''
           ;
        this._urlQuery = urlQuery ? urlQuery : null;
        this._initWidgets();
    }

    const _p = DispatcherListsCollectionController.prototype;

    _p.destroy = function() {
        for(let child of this._children.values())
            child.destroy();
        this._children.clear();
    };

    _p._getElementFromTemplate = function(klass, deep) {
        return _getElementFromTemplate(klass, deep, this._templatesContainer);
    };


    /**
     * Similar as in ProcessUIServer.js, using the url format because
     * we don't need to parse it in here then.
     */
    function _tokensToURLSubQueryString(tokens) {
        // For readability of the resulting url, we could use a less
        // strict version of encodeURIComponent. However, this is playing it
        // very save.
        return tokens.map(([k,v])=>`${k}:${encodeURIComponent(v)}`);
    }

    _p._initWidget = function(marker, setup) {
        // make a childContainer from _templatesContainer
        // must contain:
        //      insert: dispatcher-list-item
        //      insert: drilldown-link
        //      insert: title
        //      insert: description  (if a query needs more context)
        var childContainer = this._getElementFromTemplate('simple-list-widget');
        // insert before, to maintain the right order!
        dom.insert(...marker, childContainer);


        // Putting the this._urlQuery first, because this is user input
        // via the URL. Putting it first means the `setup.queryTokens`
        // can override tokens in the URL and hence stay more true to
        // their intent and to what is stated in the title.
        var query = [this._urlQuery, ..._tokensToURLSubQueryString(setup.queryTokens)]
                            .filter(item=>!!item);
        query = `q=${query.join('+')}`;
        console.log('init widget for:', query);
        return new DispatcherListsSimpleUIController(childContainer
                             , this._queryAPI, this._log
                             , setup.title
                             , setup.description
                             , query
                             , setup.asChangeFeed);

    };

    _p._initWidgets = function() {
        var marker = dom.getMarkerComment(this._container, 'insert: dispatcher-list-widget');
        for(let childSetup of this._setup.widgets) {
            // insert before marker to keep correct order in DOM
            let child = this._initWidget([marker, 'before'], childSetup);
            this._children.add(child);
        }
    };

    return DispatcherListsCollectionController;
    })();


    /**
     * This is controlling many instances ofGenericDispatcherListController.
     * The reason is, that all lists go through the same socket event
     * (i.e. like multiplexing) and this controller is routing the events
     * to their actual controllers.
     */
    function DispatcherListsQueryAPI(socket, data) {
        //jshint unused:vars
        this._session = null;

        this._socket = socket;
        this._rooms = new Map(); //(roomId=>{set attendees, string: canonical query})
        this._subscribers = new Map(); // subscriber => {roomId, onData}

        this._socketListener = this._onChangeList.bind(this);
        this._socket.on('changes-dispatcher-list', this._socketListener);
        this._reconnectHandler = this._onReconnect.bind(this);
        this._socket.on('reconnect', this._reconnectHandler);
    }
    var _p = DispatcherListsQueryAPI.prototype;

    _p.destroy = function(e) {
        // jshint unused:vars
        console.info('DispatcherListsQueryAPI received destroy event.');
        for(let subscriber of this._subscribers.keys()) {
            // Is this the right semantic, to destroy subscribers?
            // It' probably more common to destroy children in a
            // hierarchy. So, think of these subscribers as children,
            // or at least as irrecoverably dependent of this object.

            // Will unsbscribe itself!
            subscriber.destroy();
        }
        this._subscribers.clear();

        for (let roomId of this._rooms.keys()) {
            // There shouldn't be left much to do, since the
            // subscribers called unsubscribe themselves. However,
            // this is the essential dependency on the server,
            // unsubscribing just to be sure.
            this._socket.emit('unsubscribe-dispatcher-list', roomId);
        }
        this._rooms.clear();
        this._socket.off('changes-dispatcher-list', this._socketListener);
        this._socketListener = null;
        this._socket.off('reconnect', this._reconnectHandler);
        this._reconnectHandler = null;
    };

    // This should be forwarded to the single room handler, because
    // it now has a roomId and that means the handler can be called for
    // different rooms.
    // maybe more abstract: _forward(event, roomid, data)
    //    handler = getHandlerForRoom(roomId)
    //    handler(data)
    _p._onChangeList = function(roomId, data) {
        var room = this._rooms.get(roomId);
        console.log('_onChangeList for', roomId, 'data', data);
        for(let subscriber of room.attendees) {
            console.log('subscriber', subscriber);
            let {onData} = this._subscribers.get(subscriber);
            onData(data);
        }
    };

    _p._getElementFromTemplate = function(className) {
        var template = this._templatesContainer.getElementsByClassName(className)[0];
        return template.cloneNode(true);
    };

    _p._clearContainer = function() {
        dom.clear(this._container, 'destroy');
    };

    _p.unsubscribe = function(subscriber) {
        var subscription = this._subscribers.get(subscriber)
          , roomId, room
          ;
        if(!subscription) {
            // something went wrong
            console.error('Calling unsubscribe but there\'s no subscription',
                ' for', subscriber);
            return;
        }
        this._subscribers.delete(subscriber);
        roomId = subscription.roomId;
        room = this._rooms.get(roomId);
        room.attendees.delete(subscriber);
        if(!room.attendees.size) {
            this._socket.emit('unsubscribe-dispatcher-list', roomId);
            this._rooms.delete(roomId);
        }
    };

    _p._onReconnect = function() {
        function callback(roomId, result, error){
            if(error) {
                console.error('Can\'t resubscribe to dispatcher list '
                            + `for room ${roomId} with:`, error);
                return;
            }
        }
        for(let [roomId, room] of this._rooms) {
            this._socket.emit('subscribe-dispatcher-list'
                            , {queryString:room.query, asChangeFeed: true}
                            ,  callback.bind(this, roomId));
        }
    };

    _p.subscribeTo = function(subscriber, query, asChangeFeed, onData) {
        function callback(resolve, reject, result, error) {
            //jshint validthis:true
            // In some cases we don't have a change feed as a result,
            // just a list of entries, we handle both cases in here!
            if(error) {
              console.error('Can\'t subscribe to dispatcher list:', error);
              reject(error);
              return;
            }

            // canonicalQuery should update the query string sent
            // by the user interface and, if that's a thing, should
            // be placed into the query parameter of the url.
            var {roomId, canonicalQuery, isChangeFeed, data} = result;

            console.info('callback:subscribe-dispatcher-list'
                          , `roomId: ${roomId}`
                          , `canonicalQueryString: ${canonicalQuery.user}`
                          , `isChangeFeed: ${isChangeFeed}`
                          , 'data:', data);
            if(!isChangeFeed) {
                // assert roomId === null
                resolve(result);// has: {canonicalQuery, isChangeFeed}
                onData(data);
                return;
            }
            // is a change feed
            // assert data === null
            var room = this._rooms.get(roomId);
            if(!room) {
                room = {
                    attendees: new Set()
                  , query: canonicalQuery.user
                };
                this._rooms.set(roomId, room);
            }

            if(this._subscribers.has(subscriber)) {
                let oldSubscription = this._subscribers.get(subscriber);
                if(oldSubscription.roomId !== roomId)
                    // If the roomId changes we leave the old room
                    // and enter the new room, Only do this if roomId is
                    // different

                    // Send an empty list as a reset!
                    oldSubscription.onData([]);
                    this.unsubscribe(subscriber);
            }
            // If subscriber was subscribed and roomId is the same
            // roomId is the same, this should be just fine.
            // onData will be replaced, but the subscriber is
            // expected to be cool with this.
            this._subscribers.set(subscriber, {roomId, onData});
            room.attendees.add(subscriber);
            resolve(result);// has: {roomId, canonicalQuery, isChangeFeed}
        }

        return new Promise((resolve, reject)=>{
            // enters "the room"

            // asChangeFeed: some queries can't be a change feed, these
            // will ignore this flag and always return `isChangeFeed=False`
            // but all queries that can be change feeds can also be not
            // and for these this flag is effective.
            // TODO: we should maybe rename the event to:
            //              {"query" or "get"}-dispatcher-list
            this._socket.emit('subscribe-dispatcher-list',
                    {queryString:query, asChangeFeed: !!asChangeFeed},
                    callback.bind(this, resolve, reject));
        });
    };

    return {
        DispatcherListsQueryAPI
      , GenericDispatcherListController
      , DispatcherListQueryUIController
      , DispatcherListsCollectionController
    };
});
