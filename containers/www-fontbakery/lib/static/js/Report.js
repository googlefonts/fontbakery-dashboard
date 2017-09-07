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
      , AnsiUp = ansiUp.default
      ;

    function ValueError(message, stack) {
        this.name = 'ValueError';
        this.message = message || '(No message for ValueError)';
        if(!stack && typeof Error.captureStackTrace === 'function')
            Error.captureStackTrace(this, ValueError);
        else {
            this.stack = stack || (new Error()).stack || '(no stack available)';
        }
    }
    ValueError.prototype = Object.create(Error.prototype);
    ValueError.prototype.constructor = ValueError;


    var FlexibleDocumentBlock = (function(){

    var Parent = DictionaryBlock;
    function FlexibleDocumentBlock(supreme, container, key, spec, data) {
        this._init(container, key, spec, data);
        this._genericItemsContainer = dom.getChildElementForSelector(
                                            container, '.generic-items');
        Parent.call(this, supreme, container, key, spec, data);
        this._init();
    }
    var _p = FlexibleDocumentBlock.prototype = Object.create(Parent.prototype);

    _p._init = function() {
        // Some js maybe for interactions?
        // If so, shutdown on destroy?!
    };

    /**
     * Returns a DOM-Element, that is not yet in the document
     */
    _p._makeChildContainer = function(key) {
        // query the templates for {key} and return a deep copy of the result
        var container = this._spec[''].getElementFromTemplate(key);
        if(!container)
            container = dom.createElement(this._spec[''].childTag || 'div',
                            {'class': this._spec[''].getClassForKey(key)});
        return container;
    };

    /**
     *  insert into this._container at the right position
     */
    _p._insertChildContainer = function(key, container) {
        // custom comment markers would be nice here
        var target, position
          , insertionMarker = this._spec[''].insertionMarkerPrefix + key
          ;

        target = dom.getMarkerComment(this.container, insertionMarker);
        if(target)
            position = 'after';

        if(!target) {
            target = this._genericItemsContainer;
            position = 'append';
        }
        dom.insert(target, position, container);
    };

    return FlexibleDocumentBlock;
    })();

    // we'll have to extend this a bit.
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


    function mixinResultChangeChannel(_p) {
        // target must define _resultChangeSubscriptions as
        // this._resultChangeSubscriptions = [];
        // in the constructor.
        _p._dispatchResultChange = function(report) {
            var i, l, callback, args;
            for(i=0,l=this._resultChangeSubscriptions.length;i<l;i++) {
                callback = this._resultChangeSubscriptions[i][0];
                args = this._resultChangeSubscriptions[i][1].slice();
                args.push(report);
                callback.apply(this, args);
            }
        };

        _p.onResultChange = function (callback) {
            var args = [], i, l, _callback;
            for(i=1,l=arguments.length;i<l;i++)
                args.push(arguments[i]);
            _callback = [callback, args];
            this._resultChangeSubscriptions.push(_callback);
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

        var closureValue = 0
            , display = dom.createTextNode(0)
            , marker
            ;
        Object.defineProperty(this.aggregateResults, '~~total~~', {
            set: function(value) {
                closureValue = value;
                display.data = value;
            }
            , get: function() {
                return closureValue;
            }
            , enumerable: true
        });

        marker = dom.getMarkerComment(this.container
                                , this._resultsTotalIndicatorMarker);
        if(marker)
            dom.insert(marker, 'after', display);

        this._resultVals.forEach(this._initResultValueName, this);
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

    _p._initResultValueName = function(name) {
        var elem, closureValue, display, marker
            , nameNode;
        if(name in this.aggregateResults)
            return;

        // important for closure
        closureValue = 0;
        display = dom.createTextNode(0);

        Object.defineProperty(this.aggregateResults, name, {
            set: function(value) {
                this['~~total~~'] += (value - closureValue);
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

    return AggregatedResults;
    })();

    function _validateEvent(event, stopElement, searchAttribute) {
        var elem = event.target;
        if(event.defaultPrevented) return;
        while(true) {
            if(elem === stopElement.parentElement || !elem)
                return;
            if(elem.hasAttribute(searchAttribute))
                // found!
                break;
            elem = elem.parentElement;
        }
        event.preventDefault();
        return elem.getAttribute(searchAttribute);
    }

    var TestsBlock = (function() {
    var Parent = DictionaryBlock;
    function TestsBlock(supreme, container, key, spec, data) {
        this._tabs = {};
        this._tabsOrder = [];

        var markerPrefix = spec[''].insertionMarkerPrefix;

        // tabs/clustering
        this._tabsMarker = dom.getMarkerComment(container
                                                , markerPrefix + 'tabs');
        this._tabsContainer = this._tabsMarker.parentElement;
        this._tabsContainer.addEventListener('click'
                                    , this._selectTabHandler.bind(this));

        // init
        this._createdResultTypeRules = new Set();
        // will be removed on destroy!
        this._styleElement = dom.createElement('style');
        this._styleElement.ownerDocument.head.appendChild(this._styleElement);
        this._uniqueClass = 'unique-class-' + Math.round(
                                      Math.random() * Math.pow(10, 17));
        this.container = container;
        this.container.classList.add(this._uniqueClass);

        this._resultIndicatorMarker = markerPrefix + 'results-aggregation';
        this.resultChangeHandler = this._resultChangeHandler.bind(this);
        this._results = this._initTotalResults(container, spec);
        Object.keys(this._results.elements).forEach(
                                    this._initAggregateResultHandler, this);
        this._results.container.addEventListener('click'
                                , this._selectResultTypeHandler.bind(this));

        Parent.call(this, supreme, container, key, spec, data);
    }
    var _p = TestsBlock.prototype = Object.create(Parent.prototype);

    _p.destroy = function() {
        Parent.prototype.destroy.call(this);
        dom.removeNode(this._styleElement);
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
          , name = _validateEvent(event, stopElement, searchAttribute)
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

    _p._initTotalResults = function(container, spec) {
        var resultsContainer = spec[''].getElementFromTemplate(spec[''].resultsTemplateClass)
          , target = dom.getMarkerComment(container, this._resultIndicatorMarker)
          ;

        dom.insert(target, 'after', resultsContainer);
        return new AggregatedResults(resultsContainer
            , spec[''].resultIndicatorButtonClass // = 'result-value_indicator-button'
            , spec[''].resultVals
            , spec[''].getElementFromTemplate
        );
    };

    // END RESULTS CONTROL

    _p._makeTab = function(key, label) {
        var markerPrefix = this._spec[''].insertionMarkerPrefix
          , tab = this._spec[''].getElementFromTemplate(this._spec[''].tabTemplateClass)
          , tabTitleMarker = markerPrefix + 'title'
          , tabTitleTarget = dom.getMarkerComment(tab, tabTitleMarker)
          , tabTitle = dom.createElement('span', {}, label)
          , container = this._spec[''].getElementFromTemplate(this._spec[''].containerTemplateClass)
          , items = this._spec[''].getElementFromTemplate(this._spec[''].itemsTemplateClass)
          , itemsMarker = markerPrefix + 'tests'
          , itemsTarget = dom.getMarkerComment(container, itemsMarker)
            // has <!-- insert: result-indicator --> and <!-- insert: results-total -->
          , resultsContainer = container
          , results
          ;

        dom.insert(tabTitleTarget, 'after', tabTitle);
        dom.insert(itemsTarget, 'after', items);
        tab.setAttribute('data-tab-key', key);

        // this._spec[''].resultIndicatorButtonClass // = 'result-value_indicator-button'
        results = new AggregatedResults(resultsContainer
            , this._spec[''].resultIndicatorClass // = 'result-value_indicator'
            , this._spec[''].resultVals
            , this._spec[''].getElementFromTemplate
        );

        return {
            key: key
          , tab: tab
          , container: container
          , items: items
          , label: label
          , results: results
        };
    };

    _p._getTab = function(key, cached) {
        var keyData = _parseTestKey(key)
            // TODO: this will be spec config
          , clusteringKey  = 'font'
          , clusteringIndex = keyData.iterargs[clusteringKey]
          , tabKey = '('+ clusteringKey +': ' + clusteringIndex + ')'
          , tab = this._tabs[tabKey]
          , tabLabel, target, marker, element
          ;
        if(tab)
            // it exists already
            return tab;
        if(cached)
            // the caller is only interested if there's a cached version
            return undefined;
        // create the tab

        // TODO: complex! Maybe have an API to query parent for this?
        // , clusteringLabel = global.iterargs[clusteringKey][clusteringId]
        // in theory, this would have to change when the global value
        // changes (what shouldn't happen in praxis, once the global value
        // has been set,
        tabLabel = tabKey;
        tab = this._makeTab(tabKey, tabLabel);

        target = _binInsert(tab, this._tabsOrder, _compareTabs);
        if(target.pos === 'append') {
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

        // just append where it belongs, it will be switched on and off
        // <!-- insert: containers -->
        marker = this._spec[''].insertionMarkerPrefix + 'containers';
        element = dom.getMarkerComment(this.container, marker);
        dom.insert(element, 'after', tab.container);

        this._tabs[tabKey] = tab;

        // this was the first tab (in time), activate
        if(this._tabsOrder.length === 1)
            this._activateTab(tab.key);

        return tab;
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
          , key = _validateEvent(event, stopElement, searchAttribute)
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
          , marker, target
          ;
        // elem.setAttribute('data-result-key', key); ??
        // This is a bit evil: if data.index would ever change, we'd
        // have to update data-index AND the element position. BUT,
        // that's over-engineering for this use case. data.index never
        // changes in a report!
        elem.setAttribute('data-index', data.index);

        marker = this._spec[''].insertionMarkerPrefix + 'key';
        target = dom.getMarkerComment(elem, marker);
        dom.insert(target, 'after', dom.createTextNode(key));

        return elem;
    };

    function _analyzeFontName(name) {
       if(name.slice(-4) !== '.ttf')
            return false;

        var parts = name.slice(0, -4).split('-')
          , fontName = parts[0]
          , weightName = parts[1].toLowerCase() || ''
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

        if(a.label === notdef)
            return -1;
        if(b.label === notdef)
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

    function _parseTestKey(key) {
        var raw = JSON.parse(key)
          , data = {
              test: raw.test
            , section: raw.section
            , iterargs: {}
           }
         ;
        raw.iterargs.forEach(function(item){this[item[0]] = item[1];}, data.iterargs);
        return data;
    }

    function _getChildIndex(container) {
        return parseInt(container.getAttribute('data-index'), 10);
    }


    function _binInsert(value, others, compare) {
        var length = others.length
          , start, end, middle, cmp
          ;

        if(!length)
            return {index: 0, pos: 'append'};

        cmp = compare || function(a, b) {
              if(a > b) return 1;
              if(a < b) return -1;
              return 0;
        };
        start = 0;
        end = length - 1;
        while(true) {
            // binary insert:
            if(cmp (value, others[end]) > 0)
                return {index: end, pos: 'after'};

            if(cmp(value,  others[start]) < 0)
                return {index: start, pos: 'before'};

            middle = start + Math.floor((end - start) / 2);

            if(cmp(value, others[middle]) < 0)
                end = middle - 1;
            else if(cmp(value, others[middle]) > 0)
                start = middle + 1;
            else
                // This should *NEVER* happen!
                throw new ValueError('An element with value "' + value
                                    + '" is already in the list.');
        }
    }

    _p._insertChildContainer = function(key, container) {
        var tab = this._getTab(key)
          , value = _getChildIndex(container)
          , children = tab.items.children
          , others = Array.prototype.map.call(children, _getChildIndex)
            // get the position, where in tab.items to insert container:
          , target =  _binInsert(value, others)
          , element = (target.pos === 'append')
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

        // one problem is that we miss the initial value like this, thus:
        var resultValue = child.getResult();
        if(resultValue)
            this.resultChangeHandler(key, [[resultValue, 1]]);
    };

    return TestsBlock;
    })();

    var CheckItemDocBlock = (function() {
    var Parent = FlexibleDocumentBlock;

    function CheckItemDocBlock(supreme, container, key, spec, data) {
        this._resultChangeSubscriptions = [];
        this._result = undefined;
        Parent.call(this, supreme, container, key, spec, data);
    }
    var _p = CheckItemDocBlock.prototype = Object.create(Parent.prototype);

    mixinResultChangeChannel(_p);

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


    function Report(container, templatesContainer, data) {
        this._container = container;

        function getElementFromTemplate(klass) {
            var template = getTemplateForSelector('.' + klass);
            return template ? template.cloneNode(true) : null;
        }

        // Here are the definitions for our current document format.
        var getTemplateForSelector = dom.getChildElementForSelector.bind(null, templatesContainer)
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
          , checkItemSpec = {
                // Type: CheckItemDocBlock but via GenericType
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
                  , childTag: 'span'
                  , getClassForKey: function(key) {
                        return this.classPrefix + key;
                    }
                  , getElementFromTemplate: function(key) {
                        var klass = this.getClassForKey(key);
                        return getElementFromTemplate(klass);
                    }
                }
              , check_number: inlineTextSpec
              , description: inlineTextSpec
              , log_messages: {
                    spec: {
                        '': {
                            skipKey: true
                            // for each item, of GenericType
                          , genericSpec: logListSpec.spec[''].genericSpec
                        }
                    }
                }
              , result: {
                    spec: {
                        '': {
                            skipKey: true
                          , dataUnescaped: true
                        }
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
                      , GenericType: CheckItemDocBlock
                      , genericSpec: checkItemSpec
                      // for the aggregate results
                      , resultVals: resultVals
                      , resultIndicatorClass: 'result-value_indicator'
                      , resultsTemplateClass: 'report-container_tests_results-aggregation'
                      , resultIndicatorButtonClass: 'result-value_indicator-button'
                    }
                }
            }
          , spec = {
                '': {
                    GenericType: genericBlockFactory
                  , classPrefix: 'report-container_'
                  , insertionMarkerPrefix: 'insert: '
                  , getClassForKey: function(key) {
                        return this.classPrefix + key;
                    }
                  , getElementFromTemplate: function(key) {
                        var klass = this.getClassForKey(key);
                        return getElementFromTemplate(klass);
                    }
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

        this._supreme = new Supreme(
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
        this._supreme.applyPatches(patches);

    };

    return Report;
});
/**

*/
