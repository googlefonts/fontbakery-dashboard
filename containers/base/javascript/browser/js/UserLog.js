define([
    'dom-tool'
], function(
    dom
) {
    "use strict";

var LogItem = (function(){

    function LogItem(items, options) {
        // Note that Object.assign() does not throw on null or undefined source values.
        // I.e. if no options are defined.
        this._options = Object.assign({
                            tagName: 'li'
                          , str2md: false
                          , class: ''
                        }, options || null);
        this.container = dom.createElement(options.tagName || 'li'
                                                , {class: options.class});
        this._fill(items);
    }

    _p = LogItem.prototype;

    _p._fill = function(contents) {
        var i,l,content,element;
        for(i=0,l=contents.length;i<l;i++) {
            content = contents[i];
            if(dom.isDOMElement(content)) {
                element = content;
            }
            else if(typeof content === 'object') {
                // make this inline block via css
                element = dom.createElement('div'
                            , {class: 'preformated'}
                            , JSON.stringify(content, null, 2));
            }
            else if(typeof content === 'string') {
                // is it markdown or plain text???
                element =  this._options.str2md
                    ? dom.createElementfromMarkdown('div'
                                    , {class: 'markdown'}
                                    , content)
                    : dom.createTextNode(content)
                    ;
            }

            this.container.appendChild(element);
            if(i !== l-1) // not for the last node
                this.container.appendChild(dom.createTextNode(' '));
        }
    };

    return LogItem;
})();

    function UserLog(container) {
        this.container = container;
        this._logItems = [];
    }

    UserLog.LogItem = LogItem;

    var _p = UserLog.prototype;

    _p._log = function(priority, contents, options) {
        var priorityClass = 'priority-' + priority
          , _options = Object.assign({class: priorityClass}, options)
          , logItem = new LogItem(contents, _options)
          , elem = this.container
          , scrolledDown = elem.scrollTop === elem.scrollHeight - elem.clientHeight
          ;
        this._logItems.push(logItem);
        this.container.appendChild(logItem.container);

        if(scrolledDown)
            // stick to the bottom only if it was scrolled down completely
            this._scrollToBottom();
    };

    _p._scrollToBottom = function() {
        var elem = this.container;
        elem.scrollTop = elem.scrollHeight - elem.clientHeight;
    };

    /**
     * the UserLog container may be remocved from the DOM and reattached
     * later. This is hard to "listen" to, so we call this manually.
     */
    _p.reatached = function() {
        // scroll to bottom to show latest entries and then stick at
        // the bottom for subsequent entries.
        this._scrollToBottom();
    }

    _p._logMd = function(priority, contents) {
        this._log(priority, contents, {str2md:true});
    };

    _p.log = _p.info = function(/* ...contents */) {
        var args = [], i, l;
        for(i=0,l=arguments.length;i<l;i++) args.push(arguments[i]);
        this._log('info', args);
    };

    _p.infoMd = function(/* ...contents */) {
        var args = [], i, l;
        for(i=0,l=arguments.length;i<l;i++) args.push(arguments[i]);
        this._logMd('info', args);
    };

    _p.warning = function(/* ...contents */) {
        var args = [], i, l;
        for(i=0,l=arguments.length;i<l;i++) args.push(arguments[i]);
        this._log('warning', args);
    };

    _p.warningMd = function(/* ...contents */) {
        var args = [], i, l;
        for(i=0,l=arguments.length;i<l;i++) args.push(arguments[i]);
        this._logMd('warning', args);
    };

    _p.error = function(/* ...contents */) {
        var args = [], i, l;
        for(i=0,l=arguments.length;i<l;i++) args.push(arguments[i]);
        this._log('error', args);
    };

    _p.errorMd = function(/* ...contents */) {
        var args = [], i, l;
        for(i=0,l=arguments.length;i<l;i++) args.push(arguments[i]);
        this._logMd('error', args);
    };

    return UserLog;
});
