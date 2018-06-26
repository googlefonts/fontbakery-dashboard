define([
    'dom-tool'
  , 'xhr'
], function(
    dom
  , xhr
) {
    "use strict";
    /*global console*/

    function StatusController(container) {
        this.container = container;
        this._pageItems = [];
        this._lastItem = null;
        this._receivedLastPage = false;
        this._requestedUrls = new Set();

        // this can be broken with CSS easily
        // but at the moment the window is the element with the scrollbar.
        // that's also why we use the custom destroy event, to unregister
        // the listener.
        var scrollingElement = this.container.ownerDocument
          , onViewportChange = this._onViewportChange.bind(this)
          ;

        scrollingElement.addEventListener('scroll', onViewportChange);
        scrollingElement.addEventListener('resize', onViewportChange);

        this.container.addEventListener('destroy', function(e) {
            //jshint unused:vars
            scrollingElement.removeEventListener('scroll', onViewportChange);
            scrollingElement.removeEventListener('resize', onViewportChange);
        });

        // init
        this._getReportLinks('/status-reports');
    }

    var _p = StatusController.prototype;
    // I was very lazy and took this from
    // https://stackoverflow.com/questions/123999/how-to-tell-if-a-dom-element-is-visible-in-the-current-viewport/7557433
    function isElementInViewport (el) {
        var rect = el.getBoundingClientRect();
        return (
            rect.top >= 0 &&
            rect.left >= 0 &&
            rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) && /*or $(window).height() */
            rect.right <= (window.innerWidth || document.documentElement.clientWidth) /*or $(window).width() */
        );
    }

    _p._onViewportChange = function(e) {
        // jshint unused: vars
        var lastItem = this._lastItem
          , lastItemElement = this._pageItems[this._pageItems.length-1]
          , url
          ;
        if(!lastItemElement)
            return;
        if(!isElementInViewport(lastItemElement))
            return;
        if(this._receivedLastPage)
            return;
        // The url for a previous page, e.g. could be used to poll
        // if there are newer reports. We don't do this now.
        // ['/status-reports', firstItem.reported, firstItem.id, 'true'].join('/')]
        url = ['/status-reports', lastItem.reported, lastItem.id, 'false'].join('/');
        if(this._requestedUrls.has(url))
            return;
        this._requestedUrls.add(url);
        this._getReportLinks(url);
    };

    _p._receiveReportLinks = function(items) {
        var i, l, item, a, li, marker;
        if(!items.length) {
            // CAUTION: this only works when we use this function fpr
            // next-pages, when receiving previous pages/polling for newer
            // we'll often get empty items and this needs to change,
            this._receivedLastPage = true;
            return;
        }
        this._lastItem = items[items.length-1];
        marker = dom.getMarkerComment(this.container, 'insert: status-report-link');
        // Items are sorted descending, from new to old, thus the first
        // pages shows the latest entries.
        for(i=0,l=items.length;i<l;i++) {
            item = items[i];
            // TODO: create item.href server side and use it
            a = dom.createElement('a', {href: 'status-report/' + item.id}, [item.type, ':', item.typeId, ':', item.method]);
            li = dom.createElement('li', {}, [a, ' ', new Date(item.reported)]);
            dom.insert(marker, 'before', li);
            this._pageItems.push(li);
        }
        // maybe we need to fetch another page already!
        this._onViewportChange();
    };

    _p._getReportLinks = function(url) {
        return xhr.getJSON(url, null)
            .then(this._receiveReportLinks.bind(this))
            .then(null, function(error) {
                console.error(error);
                throw error;
            })
            ;
    };

    return StatusController;
});
