define([
    'dom-tool'
  , 'xhr'
], function(
    dom
  , xhr
) {
    "use strict";
    /*global console*/

    function CollectionController(container) {
        this.container = container;
        this._getReportLinks();
    }
    var _p = CollectionController.prototype;

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
        return xhr.getJSON('/collection-reports', null)
            .then(this._insertReportLinks.bind(this))
            .then(null, function(error) {
                console.error(error);
                throw error;
            })
            ;
    };

    return CollectionController;
});
