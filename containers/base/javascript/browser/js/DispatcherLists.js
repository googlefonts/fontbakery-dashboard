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
    _p._sendQuery = function(query) {
        return this._queryAPI.subscribeTo(this, query, this._renderList.bind(this));
    };

    /**
     * Change the List
     */
    _p._queryList = function() {
        var query = this._getQuery();
        return this._sendQuery(query)
        .then(canonicalQuery=>{
            // roomId stuff is handled by parent. This controller
            // doesn't know.
            // 3. if the roomId stays the same, we can stay in the room
            // 4. if the roomId changes we leave the old room and enter the new
            //    room

            //The canonical query may be changed (via server response),
            // change the input field and maybe also the window URL.
            // this._queryField.value = canonicalQuery.user;
            this._log.info('Got callback', canonicalQuery.user, canonicalQuery.url);

            // In any case, this should load/reload the room contents, for ease
            // of use.
            // this._renderList(listData);
            // live change events may be implemented later.
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
        this._rooms = new Map(); //(roomId=>set subscribers)
        this._subscribers = new Map(); // subscriber => {roomId, onData}

        var listener  = this._onChangeList.bind(this);
        this._socket.on('changes-dispatcher-list', listener);
    }
    var _p = DispatcherListsController.prototype;

    _p.destroy = function(e) {
        // jshint unused:vars
        // the way this is called, there are probably no more subscribers
        // but we can still try to unsubscribe any remainders.

        for(let subscriber of this._subscribers.keys()) {
            // Is this the right semantic, to destroy subscribers?
            // It' probably more common to destroy children in a
            // hierarchy. So, think of these subscribers as children,
            // or at least as irrecoverably dependent of this object.

            // Will unsbscribe itself!
            subscriber.destroy();
        }

        console.info('DispatcherListsController received destroy event.');
        for (let roomId of this._roomIds) {
            this._socket.emit('unsubscribe-dispatcher-list', roomId);
        }
        this._roomIds.clear();
        this._socket.off('changes-dispatcher-list', this._onChangeList.bind(this));
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
        for(let subscriber of room) {
            console.log('subscriber', subscriber);
            let {onData} = this._subscribers.get(subscriber);
            onData(data);
        }
        // WHEN?: this._socket.emit('unsubscribe-dispatcher-list', {});
    };

    _p._getElementFromTemplate = function(className) {
        var template = this._templatesContainer.getElementsByClassName(className)[0];
        return template.cloneNode(true);
    };

    _p._clearContainer = function() {
        dom.clear(this._container, 'destroy');
    };

    _p.unsubscribe = function(subscriber) {

    };

    _p.subscribeTo = function(subscriber, query, onData) {
        return new Promise((resolve, reject)=>{
            var callback = (result, error)=>{
                if(error) {
                  this._log.error(`Can\'t subscribe to dispatcher list: ${error}`);
                  reject(error);
                  return;
                }
                // canonicalQuery should update the query string sent
                // by the user interface and, if that's a thing, should
                // be placed into the query parameter of the url.
                var {roomId, canonicalQuery} = result
                  , room = this._rooms.get(roomId)
                  ;
                if(!room) {
                    room = new Set();
                    this._rooms.set(roomId, room);

                }
                console.info('callback:subscribe-dispatcher-list'
                              , `roomId: ${roomId}`
                              , `canonicalQueryString: ${canonicalQuery.user}`);
                this._subscribers.set(subscriber, {roomId, onData});
                room.add(subscriber);
                resolve(canonicalQuery);
            };
            // enters "the room"
            this._socket.emit('subscribe-dispatcher-list', {query}, callback);
        });
    };

    // _p._showProcess = function(processId) {
    //     var processElem = dom.createElement('div')
    //       , listener = this._onChangeProcess.bind(this, processElem)
    //       , subscriptionRequest = 'subscribe-dispatcher-process'
    //       , subscribe = null
    //       , reconnectHandler = (attemptNumber) => {
    //           if(subscribe === null) return;
    //           console.log('socket on reconnect', '#'+attemptNumber+':', subscriptionRequest);
    //           subscribe();
    //         }
    //       , destructor = (e)=>{
    //             //jshint unused:vars
    //             this._currentProcessListener = null;
    //             this._currentProcessLastData = null;
    //
    //             this._container.removeEventListener('destroy', destructor, false);
    //             this._log.info('OH, Hey!, the destroy event got received');
    //
    //             this._socket.off('changes-dispatcher-process', listener);
    //             if(processId) {
    //                 subscribe = null;
    //                 this._socket.off('reconnect', reconnectHandler);
    //                 this._socket.emit('unsubscribe-dispatcher-process', {
    //                     processId: processId
    //                 });
    //             }
    //         }
    //       ;
    //
    //     this._clearContainer();
    //     this._currentProcessListener = listener;
    //     this._currentProcessLastData = null;
    //
    //     dom.appendChildren(this._container, [this._log.container, processElem]);
    //     this._log.reatached();
    //
    //     this._socket.on('changes-dispatcher-process', listener);
    //     this._container.addEventListener('destroy', destructor, false);
    //     processElem.addEventListener('destroy', destructor, false);
    //     if(processId) {
    //         this._socket.on('reconnect', reconnectHandler);
    //         subscribe = ()=>this._socket.emit(subscriptionRequest
    //                                             , { processId: processId});
    //         subscribe();
    //     }
    // };

    return {
        DispatcherListsController
      , DispatcherListController
    };
});
