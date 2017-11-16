define([
    'dom-tool'
  , 'jiff'
  , 'reporterBlocks'
  , 'ansiUp'
], function(
    dom
  , jiff
  , reporterBlocks
  , ansiUp
) {
    "use strict";

    var genericBlockFactory = reporterBlocks.genericBlockFactory
      , Supreme = reporterBlocks.Supreme
      , DictionaryBlock = reporterBlocks.DictionaryBlock
      , PrimitiveValueBlock = reporterBlocks.PrimitiveValueBlock
      , ArrayBlock = reporterBlocks.ArrayBlock
      , FlexibleDocumentBlock = reporterBlocks.FlexibleDocumentBlock
      , FlexibleArrayBlock = reporterBlocks.FlexibleArrayBlock
      , binInsert = reporterBlocks.binInsert
      , AnsiUp = ansiUp.default
      ;

    var ReportDocumentBlock = FlexibleDocumentBlock;

    var HrefDocumentBlock = (function() {
    var Parent = PrimitiveValueBlock;
    function HrefDocumentBlock(supreme, container, key, spec, data) {
        dom.appendChildren(container,
            [dom.createElement('a', {href: spec[''].url}, data)]);
        Parent.call(this, supreme, container, key, spec, data);
    }
    HrefDocumentBlock.prototype = Object.create(Parent.prototype);
    return HrefDocumentBlock;
    })();

    function mixinSubscriberChannel(_p, channelName, initialMessages) {
        // target must define _resultChangeSubscriptions as
        // this._resultChangeSubscriptions = [];
        // in the constructor.
        // initialMessages: if true this stores the last messages and
        // sends it on new subscriptions. This only works if the
        // the last messages always represents the full state of the
        // subscription, i.e. not for more complex use cases.
        var subscriptions = '_' + channelName + 'Subscriptions'
          , _ChannelName = channelName.charAt(0).toUpperCase()
                                                    + channelName.slice(1)
          , dispatch = '_dispatch' + _ChannelName
          , on = 'on' + _ChannelName
          ;

        function _setLastMessage(message) {
            //jshint validthis:true
            if(!this._$lastMessages)
                this._$lastMessages = new Map();
            this._$lastMessages.set('channelName', message);
        }
        function _getLastMessage() {
            //jshint validthis:true
            if(!this._$lastMessages)
                return null;
            return this._$lastMessages.get('channelName') || null;
        }
        _p[dispatch] = function(/* message1, ..., message2 */) {
            var i, l, message = [];
            for(i=0,l=arguments.length;i<l;i++)
                message.push(arguments[i]);
            for(i=0,l=this[subscriptions].length;i<l;i++)
                _publish(false, this[subscriptions][i], message, this);
            if(initialMessages)
                _setLastMessage.call(this, message);
        };

        function _publish(async, subscription, message, thisVal) {
            /* global setTimeout */
            var callback = subscription[0]
              , args = subscription[1].slice()
              , _this = thisVal || null
              ;
            Array.prototype.push.apply(args, message);
            if(async)
                setTimeout(callback.apply.bind(callback, _this, args), 0);
            else
                return callback.apply(_this, args);
        }

        _p[on] = function (callback) {
            var args = [], i, l, subscription, lastMessage;
            for(i=1,l=arguments.length;i<l;i++)
                args.push(arguments[i]);
            subscription = [callback, args];
            this[subscriptions].push(subscription);
            if(initialMessages) {
                lastMessage = _getLastMessage.call(this);
                if(lastMessage)
                    _publish(false, subscription, lastMessage, this);
            }
        };
    }

    var AggregatedResults = (function() {
    function AggregatedResults(container, resultIndicatorClass, resultVals
                                , getElementFromTemplate) {
        this.container = container;
        this._resultIndicatorClass = resultIndicatorClass;
        this._resultVals = resultVals || [];
        this._getElementFromTemplate = getElementFromTemplate || null;

        this._resultsTotalIndicatorMarker = 'insert: results-total';
        this._resultIndicatorMarker = 'insert: result-indicator';

        this.aggregateResults = Object.create(null);
        this.elements = {};

        this._total = 0;
        this._totalDisplay = dom.createTextNode(0);

        var marker = dom.getMarkerComment(this.container
                                , this._resultsTotalIndicatorMarker);
        if(marker)
            dom.insert(marker, 'after', this._totalDisplay);

        this._resultVals.forEach(this._initResultValueName, this);
        this._totalChangeSubscriptions = [];
    }

    var _p = AggregatedResults.prototype;

    _p._getElement = function() {
        var elem;
        if(this._getElementFromTemplate)
            elem = this._getElementFromTemplate(this._resultIndicatorClass);
        if(!elem)
            elem = dom.createElement('div',
                                {'class': this._resultIndicatorClass});
        return elem;
    };

    _p._updateTotal = function(change) {
        this._setTotal(this._total + change);
    };

    _p._setTotal = function(value) {
        var i, l, cb;
        if(this._total === value)
            return;

        this._total = value;
        this._totalDisplay.data = value;

        for(i=0,l=this._totalChangeSubscriptions.length;i<l;i++) {
            cb=this._totalChangeSubscriptions[i];
            cb(value);
        }
    };

    _p.subscribeTotal = function(cb) {
        this._totalChangeSubscriptions.push(cb);
    };

    _p._initResultValueName = function(name) {
        var elem, closureValue, display, marker
            , nameNode, updateTotal;
        if(name in this.aggregateResults)
            return;

        // important for closure
        closureValue = 0;
        display = dom.createTextNode(0);
        updateTotal = this._updateTotal.bind(this);
        Object.defineProperty(this.aggregateResults, name, {
            set: function(value) {
                updateTotal(value - closureValue);
                closureValue = value;
                display.data = value;
            }
            , get: function() {
                return closureValue;
            }
            , enumerable: true
        });
        // end closure stuff

        elem = this._getElement();
        nameNode = dom.createTextNode(name);
        marker = dom.getMarkerComment(elem, 'insert: name');
        if(marker)
            dom.insert(marker, 'after', nameNode);
        else
            elem.appendChild(nameNode);

        marker = dom.getMarkerComment(elem, 'insert: value');
        if(marker)
            dom.insert(marker, 'after', display);
        else
            elem.appendChild(display);

        //always do this, no matter where elem is from
        elem.classList.add('result-value-' + name);
        // default is active
        elem.classList.add('active');

        elem.setAttribute('data-result-type', name);

        marker = dom.getMarkerComment(this.container
                                        , this._resultIndicatorMarker);
        if(marker)
            // insert before, so the order is preserved
            dom.insert(marker, 'before', elem);
        else
            this.container.appendChild(elem);

        this.elements[name] = elem;
    };

    _p.update = function(report) {
        var i, l, change, name;
        for(i=0,l=report.length;i<l;i++) {
            name = report[i][0];
            change = report[i][1];
            if(!(name in this.aggregateResults))
                this._initResultValueName(name);
            this.aggregateResults[name] += change;
        }
    };

    Object.defineProperty(_p, 'total', {
        get: function() {
            return this._total;
        }
    });

    return AggregatedResults;
    })();

    function _parseTestKey(key) {
        var raw = JSON.parse(key)
          , data = {
              test: raw.test
            , section: raw.section
            , iterargs: {}
           }
         ;
        raw.iterargs.forEach(function(item){this[item[0]] = item[1];}
                                                        , data.iterargs);
        return data;
    }

    var TestsBlock = (function() {
    var Parent = DictionaryBlock;
    function TestsBlock(supreme, container, key, spec, data) {
        // we need these earlier than Parent can run
        this.supreme = supreme;
        this.container = container;
        this._spec = spec;

        this._tabs = {};
        this._tabsOrder = [];
        this._testsLength = 0;

        var markerPrefix = spec[''].insertionMarkerPrefix;

        // tabs/clustering
        this._tabsMarker = dom.getMarkerComment(container
                                                , markerPrefix + 'tabs');
        this._tabsContainer = this._tabsMarker.parentElement;
        this._tabsContainer.addEventListener('click'
                                    , this._selectTabHandler.bind(this));
        this._updateTabLabelHandler = this._updateTabLabel.bind(this);

        // init
        this._createdResultTypeRules = new Set();
        // will be removed on destroy!
        this._styleElement = dom.createElement('style');
        this._styleElement.ownerDocument.head.appendChild(this._styleElement);
        this._uniqueClass = 'unique-class-' + Math.round(
                                      Math.random() * Math.pow(10, 17));

        this.container.classList.add(this._uniqueClass);

        this._resultIndicatorMarker = markerPrefix + 'results-aggregation';
        this.resultChangeHandler = this._resultChangeHandler.bind(this);
        this._results = this._initTotalResults(container);
        Object.keys(this._results.elements).forEach(
                                    this._initAggregateResultHandler, this);
        this._results.container.addEventListener('click'
                                , this._selectResultTypeHandler.bind(this));
        this._results.subscribeTotal(this._updateCompletionIndicator.bind(this));
        this._testsTotalLabel = dom.createTextNode();
        this._testsPercentLabel = dom.createTextNode();
        dom.insertAtMarkerComment(this._results.container
                    , markerPrefix + 'tests-total', this._testsTotalLabel);
        dom.insertAtMarkerComment(this._results.container
                    , markerPrefix + 'percent', this._testsPercentLabel);
        // init this
        this._updateCompletionIndicator();
        Parent.call(this, supreme, container, key, spec, data);


    }
    var _p = TestsBlock.prototype = Object.create(Parent.prototype);

    _p._updateCompletionIndicator = function() {
        var total = this._testsLength
          , done = this._results.total
          , percent = 0
          , ratio = 0
          ;
        if (total !== 0) {
            ratio = done/total;
            // leave 2 decimal places
            percent = Math.round(ratio * 10000) / 100;
        }

        this._testsTotalLabel.data = total;
        this._testsPercentLabel.data = percent;

        this.supreme.pubSub.publish('tests/completion'
                                          , ratio, done, total, percent);
    };

    _p.add = function(key, data) {
        Parent.prototype.add.call(this, key, data);
        this._testsLength += 1;
        this._updateCompletionIndicator();
    };

    _p.remove = function(key) {
        Parent.prototype.remove.call(this, key);
        this._testsLength -= 1;
        this._updateCompletionIndicator();
    };

    _p.destroy = function() {
        Parent.prototype.destroy.call(this);
        dom.removeNode(this._styleElement);
        var k, tab;
        for(k in this._tabs) {
            tab = this._tabs[k];
            if(tab.unsubscribeLabel)
                tab.unsubscribeLabel();
        }
    };

    // START RESULTS CONTROL

    _p._getResultTypeToggleClass = function(name) {
        var klass = 'hide-result-type-' + name;
        if(!this._createdResultTypeRules.has(klass)) {
            this._createdResultTypeRules.add(klass);
            var selector = '.' + this._uniqueClass
                         + '.' + klass
                         + ' .test-result-' + name
              , rule = selector + '{display: None;}'
              , sheet = this._styleElement.sheet
              ;
            sheet.insertRule(rule, sheet.cssRules.length);
        }
        return klass;
    };

    _p._toggleResultType = function(name) {
       var klass = this._getResultTypeToggleClass(name);
       this.container.classList.toggle(klass);
       this._results.elements[name].classList.toggle('inactive');
       this._results.elements[name].classList.toggle('active');
    };

    _p._selectResultTypeHandler = function(event) {
        var searchAttribute = 'data-result-type'
          , stopElement = this._results.container
          , name = dom.validateChildEvent(event, stopElement, searchAttribute)
          ;
        if(name !== undefined)
            this._toggleResultType(name);
    };

    _p._initAggregateResultHandler = function(name) {
        // default is active, but we can override this here
        // TODO: make configurable?
        if(name !== 'ERROR' && name !== 'FAIL' && name !== 'WARN')
            this._toggleResultType(name);
    };

    _p._initTotalResults = function(container) {
        var spec = this._spec['']
          , resultsContainer = spec.getElementFromTemplate(spec.resultsTemplateClass)
          , target = dom.getMarkerComment(container, this._resultIndicatorMarker)
          ;

        dom.insert(target, 'after', resultsContainer);
        return new AggregatedResults(resultsContainer
            , spec.resultIndicatorButtonClass // = 'result-value_indicator-button'
            , spec.resultVals
            , spec.getElementFromTemplate
        );
    };

    // END RESULTS CONTROL

    _p._makeTab = function(key, fallbackLabel) {
        var spec = this._spec['']
          , markerPrefix = spec.insertionMarkerPrefix
          , getElementFromTemplate = spec.getElementFromTemplate.bind(spec)
          , tab = getElementFromTemplate(spec.tabTemplateClass)
          , labelNode = dom.createTextNode()
          , tabTitle = dom.createElement('span', {}, labelNode)
          , containerLabelNode = dom.createTextNode()
          , container = getElementFromTemplate(spec.containerTemplateClass)
          , items = getElementFromTemplate(spec.itemsTemplateClass)
            // has <!-- insert: result-indicator --> and <!-- insert: results-total -->
          , resultsContainer = container
          , results
          ;

        dom.insertAtMarkerComment(tab, markerPrefix + 'title'
                                                , tabTitle, false);
        dom.insertAtMarkerComment(container, markerPrefix + 'tests'
                                                , items, false);
        dom.insertAtMarkerComment(container, markerPrefix + 'label'
                                                , containerLabelNode, false);
        tab.setAttribute('data-tab-key', key);

        // spec.resultIndicatorButtonClass // = 'result-value_indicator-button'
        results = new AggregatedResults(resultsContainer
            , spec.resultIndicatorClass // = 'result-value_indicator'
            , spec.resultVals
            , getElementFromTemplate
        );

        return {
            key: key
          , tab: tab
          , fallbackLabel: fallbackLabel || key
          , container: container
          , items: items
          , label: null
          , labelNodes: [labelNode, containerLabelNode]
          , unsubscribeLabel: null
          , results: results
        };
    };

    _p._updateTabLabel = function(tabKey, label) {
        var tab = this._tabs[tabKey]
          , oldIndex, target, element
          , newLabel = label || tab.fallbackLabel
          ;
        if(tab.label === newLabel)
            return;
        tab.label = newLabel;
        tab.labelNodes.forEach(function(n){n.data = newLabel;});

        // remove to find the new index
        oldIndex = this._tabsOrder.indexOf(tab);
        if(oldIndex !== -1)
            // remove tab for binInsert
            this._tabsOrder.splice(oldIndex, 1);
        target = binInsert(tab, this._tabsOrder, _compareTabs);
        if(target.index === oldIndex) {
            // return it and leave
            this._tabsOrder.splice(oldIndex, 0, tab);
            return;
        }

        if(target.pos === 'prepend') {
            // first element
            target.pos = 'after';
            // <!-- insert: tabs -->
            element = this._tabsMarker;
        }
        else
            element = this._tabsOrder[target.index].tab;

        dom.insert(element, target.pos, tab.tab);
        this._tabsOrder.splice(
                target.index + (target.pos === 'after' ? 1 : 0), 0, tab);
    };

    _p._getTab = function(key, cached) {
        var keyData = _parseTestKey(key)
            // TODO: this will be spec config
          , clusteringKey  = 'font'
          , noClusteringLabel = 'Family Checks'
          , clusteringIndex = keyData.iterargs[clusteringKey]
          , tabKey = '('+ clusteringKey +': ' + clusteringIndex + ')'
          , tab = this._tabs[tabKey]
          , fallbackLabel, marker, element, channel
          ;
        if(tab)
            // it exists already
            return tab;
        if(cached)
            // the caller is only interested if there's a cached version
            return undefined;

        // create the tab
        fallbackLabel = clusteringIndex === undefined
                                                ? noClusteringLabel
                                                : tabKey
                                                ;
        this._tabs[tabKey] = tab = this._makeTab(tabKey, fallbackLabel);
        channel = 'change:' +['', 'iterargs', clusteringKey, clusteringIndex].join('/');
        // runs the handler immediately if there is already a message!
        tab.unsubscribeLabel = this.supreme.pubSub.subscribe(channel
                                  , this._updateTabLabelHandler, tabKey);
        if(tab.label === null)
            //There was no label message (we have no label yet)
            this._updateTabLabel(tabKey);

        // just append where it belongs, it will be switched on and off
        // <!-- insert: containers -->
        marker = this._spec[''].insertionMarkerPrefix + 'containers';
        element = dom.getMarkerComment(this.container, marker);
        dom.insert(element, 'after', tab.container);

        // this was the first tab (in time), activate
        if(this._tabsOrder.length === 1)
            this._activateTab(tab.key);

        return tab;
    };

    /**
     * reason to reorder is new/changed names. Really depends on how they
     * are ordered.
     */
    _p._reorderTabs = function() {
        var newOrder = this._tabsOrder.slice().sort(_compareTabs)
          , i = 0
          , l = newOrder.length
          , element = this._tabsMarker
          ;
        if(l)
            do {
                dom.insert(element, 'after', newOrder[i].tab);
                element = newOrder[i].tab;
                i++;
            } while(i<l);
        this._tabsOrder = newOrder;
    };

    // START TABS CONTROL

    _p._activateTab = function(tabKey) {
        var k, func
          , activeClass = 'active-tab'
          ;
        this._activeTab = tabKey;
        for(k in this._tabs) {
            func = (k !== tabKey) ? 'remove' : 'add';
            this._tabs[k].container.classList[func](activeClass);
            this._tabs[k].tab.classList[func](activeClass);
        }
    };

    _p._activateFirstTab = function() {
        if(this._tabsOrder.length)
            this._activateTab(this._tabsOrder[0].key);
        else
            // nothing there
            this._activeResult = null;
    };

    _p._selectTabHandler = function(event) {
        var searchAttribute = 'data-tab-key'
          , stopElement = this._tabsContainer
          , key = dom.validateChildEvent(event, stopElement, searchAttribute)
          ;
        if(key !== undefined)
            this._activateTab(key);
    };

    // END TABS CONTROL

    _p._removeTabIfEmpty = function(tabKey) {
        var tab = this._tabs[tabKey];
        if(tab.items.children.length)
            return;

        dom.removeNode(tab.tab);
        dom.removeNode(tab.container);
        delete this._tabs[tab.key];
        this._tabsOrder.splice(this._tabsOrder.indexOf(tab), 1);
        if(tab.unsubscribeLabel)
            tab.unsubscribeLabel();
    };

    _p.remove = function(key) {
        Parent.prototype.remove.call(this, key);

        var resultValue = this.getChild(key).getResult()
          , tab = this._getTab(key, true)
          ;
        if(resultValue)
            this.resultChangeHandler(key, [[resultValue, -1]]);

        if(!tab)
            return;
        this._removeTab(tab.key);
        // tabs
        if(this._activeTab === tab.key)
            this._activateFirstTab();
    };

    _p.replace = function(key, data) {
        this.remove(key);
        // add must figure out the right insertion position
        this.add(key, data);
    };

    _p._makeChildContainer = function(key, data) {
        // jshint unused:vars
        var klass = this._spec[''].itemTemplateClass
          , elem = this._spec[''].getElementFromTemplate(klass)
          ;
        // This is a bit evil: if data.index would ever change, we'd
        // have to update data-index AND the element position. BUT,
        // that's over-engineering for this use case. data.index never
        // changes in a report!
        elem.setAttribute('data-index', data.index);
        return elem;
    };

    function _analyzeFontName(name) {
       if(name.slice(-4) !== '.ttf')
            return false;

        var parts = name.slice(0, -4).split('-')
          , fontName = parts[0]
          , weightName = parts[1] ? parts[1].toLowerCase() : ''
          , weights = {
                'thin': 100
              , 'hairline': 100
              , 'extralight': 200
              , 'light': 300
              , 'regular': 400
              , '': 400
              , 'medium': 500
              , 'semibold': 600
              , 'bold': 700
              , 'extrabold': 800
              , 'black': 900
            }
          ;
        return {
            name: fontName
          , weight: weights[weightName] || 0
        };
    }

    // we want to sort by tab.label
    function _compareTabs(a, b) {
        var aFont, bFont, notdef = '(font: undefined)';
        if(a === b)
            return 0;

        if(a.key === notdef)
            return -1;
        if(b.key === notdef)
            return 1;

        aFont = _analyzeFontName(a.label);
        bFont = _analyzeFontName(b.label);

        // put fonts before other result keys
        if(aFont && !bFont)
            return -1;
        if(!aFont && bFont)
            return 1;
        if(aFont && bFont) {
            if (aFont.name !== bFont.name)
                return aFont.name < bFont.name ? -1 : 1;
            if (aFont.weight !== bFont.weight)
                return aFont.weight - bFont.weight;
        }
        // It's not equal, we covered that in the first line.
        return a.label < b.label ? -1 : 1;
    }

    function _getChildIndex(container) {
        return parseInt(container.getAttribute('data-index'), 10);
    }

    _p._insertChildContainer = function(key, container) {
        var tab = this._getTab(key)
          , value = _getChildIndex(container)
          , children = tab.items.children
          , others = Array.prototype.map.call(children, _getChildIndex)
            // get the position, where in tab.items to insert container:
          , target =  binInsert(value, others)
          , element = (target.pos === 'prepend')
                                            ? tab.items
                                            : children[target.index]
          ;
        dom.insert(element, target.pos, container);
    };

    _p._resultChangeHandler =function (key, report) {
        var tab = this._getTab(key);
        tab.results.update(report);
        this._results.update(report);
    };

    _p._insertChild = function(key, child) {
        Parent.prototype._insertChild.call(this, key, child);

        // for each child added
        child.onResultChange(this.resultChangeHandler, key);
    };

    return TestsBlock;
    })();

    var CheckItemDocBlock = (function() {
    var Parent = FlexibleDocumentBlock;

    function CheckItemDocBlock(supreme, container, key, spec, data) {
        console.log('Init CheckItemDocBlock');
        this._resultChangeSubscriptions = [];
        this._result = undefined;
        Parent.call(this, supreme, container, key, spec, data);

        this._keyData = _parseTestKey(this.key);

        var channel = 'change:/test_descriptions/' + this._keyData.test
          , markerPrefix = this._spec[''].insertionMarkerPrefix
          ;
        this._descriptionNode = dom.createTextNode();
        dom.insertAtMarkerComment(container, markerPrefix + 'test-key'
                        , dom.createTextNode(this._keyData.test), false);
        dom.insertAtMarkerComment(container, markerPrefix + 'description'
                                        , this._descriptionNode, false);
        this.unsubscribeDesc = this.supreme.pubSub.subscribe(channel
                                    , this._updateDescription.bind(this));
    }
    var _p = CheckItemDocBlock.prototype = Object.create(Parent.prototype);

    mixinSubscriberChannel(_p, 'resultChange', true);

    _p._updateDescription = function(description) {
        this._descriptionNode.data = description;
    };

    _p.destroy = function() {
        Parent.prototype.destroy.call(this);
        this.unsubscribeDesc();
    };

    _p._setResult = function (value) {
        var old = this._result
          , classPrefix = 'test-result-'
          , oldClass = old ? classPrefix + old : null
          , newClass = value ? classPrefix + value : null
          , report = []
          ;

        if(old)
            report.push([old, -1]);
        if(value)
            report.push([value, +1]);

        if(oldClass)
            this.container.classList.remove(oldClass);
        if(newClass)
            this.container.classList.add(newClass);
        this._result = value;

        if(report.length)
            this._dispatchResultChange(report);
    };

    _p.getResult = function() {
        return this._result;
    };

    _p.add = function(key, data) {
        Parent.prototype.add.call(this, key, data);
        if(key === 'result')
            this._setResult(data);
    };

    _p.remove = function(key) {
        Parent.prototype.remove.call(this, key);
        if(key === 'result')
            this._setResult(undefined);
    };

    _p.replace = function(key, data) {
        Parent.prototype.replace.call(this, key, data);
        if(key === 'result')
            this._setResult(data);
    };

    return CheckItemDocBlock;
    })();

    function _mixinChangePublishing(_p, Parent) {
    _p._publishChange = function(key /*, data*/) {
        var channel = 'change:' + this.path + '/' + key
          , args = [channel], i, l
          ;
        for(i=1,l=arguments.length;i<l;i++)
            args.push(arguments[i]);
        this.supreme.pubSub.publish.apply(this.supreme.pubSub, args);
    };

    _p.add = function(key, data) {
        Parent.prototype.add.call(this, key, data);
        if(this._spec[''].publishChanges)
            this._publishChange(key, data);
    };

    _p.remove = function(key) {
        Parent.prototype.remove.call(this, key);
        if(this._spec[''].publishChanges)
            this._publishChange(key);
    };

    _p.replace = function(key, data) {
        Parent.prototype.replace.call(this, key, data);
        if(this._spec[''].publishChanges)
            this._publishChange(key, data);
    };
    }

    var PublishingDictBlock = (function() {
    var Parent = DictionaryBlock;
    function PublishingDictBlock(supreme, container, key, spec, data) {
        Parent.call(this, supreme, container, key, spec, data);
    }

    var _p = PublishingDictBlock.prototype = Object.create(Parent.prototype);
    _p.constructor = PublishingDictBlock;

    _p._makeChildContainer = function(key) {
        // jshint unused:vars
        return;
    };

    _mixinChangePublishing(_p, Parent);

    return PublishingDictBlock;
    })();

    var PublishingArrayBlock = (function() {
    var Parent = ArrayBlock;
    function PublishingArrayBlock(supreme, container, key, spec, data) {
        Parent.call(this, supreme, container, key, spec, data);
    }

    var _p = PublishingArrayBlock.prototype = Object.create(Parent.prototype);
    _p.constructor = PublishingArrayBlock;

    _p._makeChildContainer = function(key) {
        // jshint unused:vars
        return;
    };

    _mixinChangePublishing(_p, Parent);

    return PublishingArrayBlock;
    })();


    function Report(container, templatesContainer, data) {
        this._container = container;

        function getElementFromTemplate(klass) {
            var template = getTemplateForSelector('.' + klass);
            return template ? template.cloneNode(true) : null;
        }

        // Here are the definitions for our current document format.
        var getTemplateForSelector = dom.getChildElementForSelector.bind(dom, templatesContainer)
            // this is to define the order of check result values
            // in the interfaces aggregating these.
          , resultVals = ['ERROR', 'FAIL', 'WARN', 'SKIP', 'INFO', 'PASS']
          , isFinishedSpec = {
                spec: {
                    '': {
                        skipKey: true
                      , dataTag: 'div'
                      , dataFormater: function(data) {
                            var klass = 'status ', message;
                            if(!data) {
                                message = 'in progress';
                                klass += 'in-progress';
                            }
                            else {
                                message = 'DONE!';
                                klass += 'finished';
                            }
                            return dom.createElement('span', {'class': klass}, [
                                dom.createElement('strong', {}, 'Status')
                              , ' '
                              , message]);
                        }
                    }
                }
            }
          , datesSpec = {
                spec: {
                    '': {
                        dataFormater: function(data){
                            return (new Date(data)).toLocaleString();
                        }
                    }
                }
            }
          ,  preformatedTextSpec = {
                spec: {
                    '': {
                        keyTag: 'h3'
                      , dataTag: 'pre'
                      , dataUnescaped: true
                    }
                }
            }
            ,  preformatedAnsicolorSpec = {
                spec: {
                    '': {
                        keyTag: 'h3'
                      , dataTag: 'pre'
                      , dataFormater: function(txt) {
                            var ansi_up = new AnsiUp()
                              , html = ansi_up.ansi_to_html(txt)
                              ;
                            return dom.createFragmentFromHTML(html);
                        }
                    }
                }
            }
            , inlineTextSpec = {
                spec: {
                    '': {
                        skipKey: true
                      , dataTag: 'span'
                      , dataUnescaped: true
                    }
                }
            }
          , logListSpec = {
                spec: {
                    '': {
                        // for each item, of GenericType
                        genericSpec: {
                            '': {
                                skipKey: true
                              , dataUnescaped:true
                            }
                        }
                    }
                }
            }
          , statusIndicatorSpec = {
                spec: {
                    '': {
                        skipKey: true
                      , dataUnescaped: true
                      , addClasses: function(data) {
                            return ['status-value-' + data];
                        }
                    }
                }
            }
          , checkStatusSpec = {
                // Type: FlexibleDocumentBlock but via GenericType (is a FlexibleDocumentBlock)
                '': {
                    GenericType: genericBlockFactory
                  , insertionMarkerPrefix: 'insert: '
                  , classPrefix: 'check-item_status_'
                  , getElementFromTemplate: getElementFromTemplate
                  , skipKey: true
                }
              , status: statusIndicatorSpec
              , traceback: preformatedTextSpec
              , message: inlineTextSpec
              , code: {
                  spec: {
                      '': {
                          keyTag: 'strong'
                        , seperator: ' '
                        , dataTag: 'span'
                        , dataUnescaped: true
                      }
                    }
                }
            }
          , checkStatusesSpec = {
                Type: FlexibleArrayBlock
              , spec: {
                    '': {
                        GenericType: FlexibleDocumentBlock
                      , genericSpec: checkStatusSpec
                      , childClass: 'check-item_status'
                      , getElementFromTemplate: getElementFromTemplate
                    }
                }
            }
          , checkItemSpec = {
                // Type: CheckItemDocBlock but via GenericType (is a FlexibleDocumentBlock)
                '': {
                    GenericType: genericBlockFactory
                  , genericSpec: {
                            '' :{
                                seperator: ' '
                              , GenericType: genericBlockFactory
                            }
                    }
                  , classPrefix: 'check-item-container_'
                  , insertionMarkerPrefix: 'insert: '
                  , childTag: 'div'
                  , getElementFromTemplate: getElementFromTemplate
                }
              , statuses: checkStatusesSpec
              , result: statusIndicatorSpec
            }
          , iterargsSpec = {
                Type: PublishingDictBlock
              , spec: {
                    '': {
                        GenericType: PublishingArrayBlock
                      , genericSpec: {
                            '': {
                                GenericType: PrimitiveValueBlock
                              , genericSpec: {}
                              , publishChanges: true
                            }
                        }
                        , publishChanges: false
                    }
                }
            }
          , testDescriptionsSpec = {
                Type: PublishingDictBlock
              , spec: {
                    '': {
                        GenericType: PrimitiveValueBlock
                      , genericSpec: {}
                      , publishChanges: true
                    }
                }
            }
          , hiddenDictSpec = {
                Type: PublishingDictBlock
              , spec: {
                    '': {
                        GenericType: PrimitiveValueBlock
                      , genericSpec: {}
                      , publishChanges: false
                    }
                }
            }
          , testsSpec = {
                // heavily functional block. provides:
                // Aggregate results (filter buttons and numbers)
                // Tabs: buttons to switch between fonts/family tests
                // ordering of the TestBlocks
                // Results per Tab!
                Type: TestsBlock
              , spec: {
                    '': {
                        tabTemplateClass: 'report-container_tests-tab'
                      , containerTemplateClass: 'report-container_tests-container'
                      , itemsTemplateClass: 'report-container_tests-items'
                      , itemTemplateClass: 'report-container_test-item'
                      , insertionMarkerPrefix: 'insert: '
                      , getElementFromTemplate: getElementFromTemplate
                      , GenericType: CheckItemDocBlock //  is a FlexibleDocumentBlock
                      , genericSpec: checkItemSpec
                      // for the aggregate results
                      , resultVals: resultVals
                      , resultIndicatorClass: 'result-value_indicator'
                      , resultsTemplateClass: 'report-container_tests_results-aggregation'
                      , resultIndicatorButtonClass: 'result-value_indicator-button'
                    }
                }
            }
          , spec = { // ReportDocumentBlock is a FlexibleDocumentBlock
                '': {
                    GenericType: genericBlockFactory
                  , genericSpec: {
                      '': {
                            GenericType: genericBlockFactory
                          , genericSpec: {
                                // the jobs key has these fields as well
                                exception: preformatedTextSpec
                              , created: datesSpec
                              , started: datesSpec
                              , finished: datesSpec
                            }
                        }
                    }
                  , classPrefix: 'report-container_'
                  , insertionMarkerPrefix: 'insert: '
                  , getElementFromTemplate: getElementFromTemplate
                  , containerless: new Set(['iterargs', 'test_descriptions', 'results'])
                }
              , id: {
                    Type: HrefDocumentBlock
                  , spec: {
                        '': {
                            // kind of unflexible, but it has minimal
                            // knowledge of the url schema
                            url: data.url[0] === '/' ? data.url : '/'+data.url
                        }
                    }
                }
              , exception: preformatedTextSpec
              , stderr: preformatedAnsicolorSpec
              , stdout: preformatedAnsicolorSpec
              , created: datesSpec
              , started: datesSpec
              , finished: datesSpec
              , iterargs: iterargsSpec
              , test_descriptions: testDescriptionsSpec
              , results: hiddenDictSpec
              , command: {
                    spec: {
                        '': {
                            // for each item, of GenericType
                            genericSpec: {
                                '': {
                                    skipKey: true
                                  , dataUnescaped:true
                                }
                            }
                        }
                    }
                }
              , preparation_logs: logListSpec
              , tests: testsSpec
            }
          , rootTemplateElement = getTemplateForSelector('.report-root')
          , rootInsertionMarker = 'insert: report-root'
          ;

        this.supreme = new Supreme(
                                     ReportDocumentBlock
                                   , this._container
                                   , rootTemplateElement
                                   , rootInsertionMarker
                                   , spec
                                   );
    }
    var _p = Report.prototype;

    _p.onChange = function (data) {
        console.log(new Date(), 'got change data:', data);
        // if data.oldVal is null this is the initial change.
        var oldVal = data.old_val === null
                    ? {}
                    : data.old_val
          , patches = jiff.diff(oldVal, data.new_val)
          ;
        // The api understands full JSONPAtch
        // there are generic renderers for unspecified data
        console.log('patches', patches);
        this.supreme.applyPatches(patches);
    };

    return Report;
});
