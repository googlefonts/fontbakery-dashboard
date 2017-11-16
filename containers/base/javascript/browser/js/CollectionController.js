define([
    'dom-tool'
], function(
    dom
) {
    "use strict";
    /*global console, XMLHttpRequest*/

    function CollectionController(container) {
        this.container = container;
        this._getReportLinks();
    }
    var _p = CollectionController.prototype;

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
            item.date = new Date(item.date);
        });
        items.sort(function(a, b) {
            return a.date - b.date;
        });
        items.reverse();

        marker = dom.getMarkerComment(this.container, 'insert: link');
        for(i=0,l=items.length;i<l;i++) {
            item = items[i];
            a = dom.createElement('a', {href: item.href}, item.collection_id);
            li = dom.createElement('li', {}, [a, ' ', item.date]);
            dom.insert(marker, 'after', li);
        }
    };

    _p._getReportLinks = function() {
        var xhr = new XMLHttpRequest();
        xhr.open('GET', '/collection-reports');
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.responseType = 'json';
        _sendXHR(xhr, null, this._insertReportLinks.bind(this));
    };

    return CollectionController;
});
