define([
    'dom-tool'
  , 'UserLog'
], function(
    dom
  , UserLog
) {
    /* jshint browser:true, esnext:true*/
    "use strict";

    const DispatcherListController = (function(){
    /**
     * This is controlling just a single list.
     */
    function DispatcherListController(container, templatesContainer, queryAPI) {
        this._container = container;
        this._templatesContainer = templatesContainer;
        this._queryAPI = queryAPI;

        this._log = new UserLog(dom.createElement('ol', {class: 'user-log'}));

        this._queryField = dom.createElement('input', {
                type: 'text'
              , name: 'query-process-list'
              , value: 'initiator:graphicoredummy'
            });
        this._queryFieldSend = dom.createElement('input', {type: 'button', name: 'send-process-list-query', value: 'send'});
        this._queryFieldSend.addEventListener('click', ()=>this._queryList());


        dom.appendChildren(this._container, [
            this._log.container
          , this._queryField
          , ' '
          , this._queryFieldSend
        ]);
        this._log.reatached();
        // this._log.infoMd('**data:**\n\n```\n'+ JSON.stringify(data, null, 2) +'\n```');

        container.addEventListener('destroy', this.destroy.bind(this), false);
        //this._queryList();
    }

    var _p = DispatcherListController.prototype;

    _p._renderList = function(listData) {
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
     * Get the new query from the input field, maybe also window URL or
     * if specified differently, from there.
     */
    _p._getQuery = function() {
        return this._queryField.value;
        // e.g.: 'initiator:qraphicore mode:sandbox orderBy:changed-desc';
        //return this._queryField.value;
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
     * Change the List
     */
    _p._queryList = function() {
        var query = this._getQuery()
          , asChangeFeed = true
          ;

        // In any case, this should clear the contents, for ease
        // of use. Some subscriptions don't produce any output and
        // hence never report anything.
        this._renderList([]);

        return this._sendQuery(query, asChangeFeed)
        .then(({canonicalQuery, isChangeFeed})=>{
            // Room subscription stuff is handled by parent.
            // This subscriber can only be in one room at a time.

            //The canonical query may be changed (via server response),
            // change the input field and maybe also the window URL.
            // this._queryField.value = canonicalQuery.user;
            this._log.info(`Got callback isChangeFeed ${isChangeFeed}`
                            , canonicalQuery.user, canonicalQuery.url);
        });
    };

    _p.destroy = function(e) {
        // jshint unused:vars
        this._log.info('DispatcherListController received destroy event.');
        return this._queryAPI.unsubscribe(this);
    };

    return DispatcherListController;
    })();


    /**
     * This is controlling many DispatcherListController. The reason is,
     * that all lists go through the same socket event (i.e. like multiplexing
     * and this controller is routing the events to their actual controllers.
     */
    function DispatcherListsController(socket, data) {
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
    var _p = DispatcherListsController.prototype;

    _p.destroy = function(e) {
        // jshint unused:vars
        console.info('DispatcherListsController received destroy event.');
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
        function callback(resolve, reject, result, error){
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
                    this.unsubscribe(subscriber);
            }
            // If subscriber was subscribed and roomId is the same
            // roomId is the same, this should be just fine.
            // onData will be replaced, but the subscriber is
            // expected to be cool with this.
            this._subscribers.set(subscriber, {roomId, onData});
            room.attendees.add(subscriber);
            resolve(result);// has: {canonicalQuery, isChangeFeed}
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
        DispatcherListsController
      , DispatcherListController
    };
});
