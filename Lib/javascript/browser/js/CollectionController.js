define([
    'dom-tool'
], function(
    dom
) {
    "use strict";
    /*global window, console, XMLHttpRequest*/


    function CollectionController(container) {
        this.container = container;
        this._onResponseCallbacks = [];
        this._initControls();
        this._getReportLinks();
    }
    var _p = CollectionController.prototype;


    _p._send = function(secret) {
        var data = {secret: secret.value}
          , xhr
          ;
        xhr = new XMLHttpRequest();
        xhr.open('POST', '/runcollectionchecks');
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.responseType = 'json';
        var onResponse = this._onResponse.bind(this);
        _sendXHR(xhr, JSON.stringify(data), onResponse);
    };

    _p.onResponse = function(callback) {
        this._onResponseCallbacks.push(callback);
    };

    _p._onResponse = function(response) {
        var i, l;
        window.history.pushState(null, null, response.url);
        for(i=0,l=this._onResponseCallbacks.length;i<l;i++)
            this._onResponseCallbacks[i](response);
    };


    function _sendXHR(xhr, data, onResponse) {
        xhr.send(data);
        xhr.onreadystatechange = function () {
            if(xhr.readyState !== XMLHttpRequest.DONE)
                return;
            if(xhr.status !== 200)
                console.warn(xhr.status, xhr.statusText );
            else {
                console.info('Received:', xhr.responseType, xhr.response);
                onResponse( xhr.response );
            }
        };
    }

    _p._insertReportLinks = function(items) {
        var i, l, item, a, li, marker;

        items.forEach(function(item){
            item.created = new Date(item.created);
        });
        items.sort(function(a, b) {
            return a.created - b.created;
        });
        items.reverse();

        marker = dom.getMarkerComment(this.container, 'insert: link');
        for(i=0,l=items.length;i<l;i++) {
            item = items[i];
            a = dom.createElement('a', {href: item.href}, item.id);
            li = dom.createElement('li', {}, [a, ' ', item.created]);
            dom.insert(marker, 'after', li);
        }
    };

    _p._getReportLinks = function() {
        var xhr = new XMLHttpRequest()
          , onResponse = this._insertReportLinks.bind(this)
          ;
        xhr.open('GET', '/collection-reports');
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.responseType = 'json';
        _sendXHR(xhr, null, onResponse);
    };


    _p._initControls = function() {
        var send = dom.createElement('button'
                                        , null, 'Test the collection!')
          , secret = dom.createElement('input', {
                                                type: 'password'
                                              , placeholder: 'enter secret'
                                              })
          ;
        dom.insertAtMarkerComment(this.container, 'insert: send', send);
        dom.insertAtMarkerComment(this.container, 'insert: secret', secret);
        send.addEventListener('click', this._send.bind(this, secret));
    };

    return CollectionController;
});
