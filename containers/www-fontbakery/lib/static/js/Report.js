define([
    'dom-tool'
  , 'jiff'
  , 'reporterBlocks'
], function(
    dom
  , jiff
  , reporterBlocks
) {
    "use strict";

    var genericBlockFactory = reporterBlocks.genericBlockFactory
      , Supreme = reporterBlocks.Supreme
      , DictionaryBlock = reporterBlocks.DictionaryBlock
      , PrimitiveValueBlock = reporterBlocks.PrimitiveValueBlock
      , GenericDictionaryBlock = reporterBlocks.GenericDictionaryBlock
      ;


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
            var i, l;
            if(!this._resultChangeSubscriptions)
            for(i=0,l=this._resultChangeSubscriptions.length;i<l;i++)
                this._resultChangeSubscriptions[i](report);
        };

        _p.onResultChange = function (callback) {
            this._resultChangeSubscriptions.push(callback);
        };
    }

    function mixinResultDisplay(_p) {
        // target must run:
        // this.aggregateResults = null;
        // this._aggregateResultElements = null;
        // // we need these now
        // this._spec = spec;
        // this.container = container;
        // this._initResultDisplay(container, spec);

        _p._initResultValueName = function(name) {
            var elem, closureValue, display, resultIndicatorClass, marker
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
            resultIndicatorClass = 'resultIndicatorClass' in this._spec['']
                    ? this._spec[''].resultIndicatorClass
                    : 'result-value_indicator'
                    ;

            if('getElementFromTemplate' in this._spec[''])
                elem = this._spec[''].getElementFromTemplate(resultIndicatorClass);


            if(!elem)
                elem = dom.createElement('div',
                                    {'class': resultIndicatorClass});


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

            marker = dom.getMarkerComment(this.container,
                    this._resultIndicatorMarker || 'insert: result-indicator');
            if(marker)
                // insert before, so the order is preserved
                dom.insert(marker, 'before', elem);
            else
                this.container.appendChild(elem);

            this._aggregateResultElements[name] = elem;
            if(this._initAggregateResultHandler)
                this._initAggregateResultHandler(name);

        };

        _p.__resultChangeHandler = function(report) {
            var i, l, change, name;
            for(i=0,l=report.length;i<l;i++) {
                name = report[i][0];
                change = report[i][1];

                if(!(name in this.aggregateResults))
                    this._initResultValueName(name);
                this.aggregateResults[name] += change;
            }
        };

        _p._initResultDisplay = function() {
            this.aggregateResults = Object.create(null);
            this._aggregateResultElements = {};

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

            marker = dom.getMarkerComment(this.container,
                    this._resultsTotalIndicatorMarker || 'insert: results-total');
            if(marker)
                dom.insert(marker, 'after', display);

            if('resultVals' in this._spec[''])
                this._spec[''].resultVals.forEach(
                                this._initResultValueName, this);
        };
    }


    var ResultsBlock = (function() {
    var Parent = DictionaryBlock;
    function ResultsBlock(supreme, container, key, spec, data){
        this._tabs = {};
        var markerPrefix = spec[''].insertionMarkerPrefix;
        this._docsMarker = markerPrefix + 'docs';
        this._tabsMarker = markerPrefix + 'tabs';
        this._resultIndicatorMarker = markerPrefix +'result-indicator';

        this.resultChangeHandler = this.__resultChangeHandler.bind(this);

        this._activeResult = null;
        this. _tabsContainer = dom.getMarkerComment(
                                container, this._tabsMarker).parentElement;

        this._resultAggregationContainer = dom.getMarkerComment(
                                container, this._resultIndicatorMarker).parentElement;

        this._createdResultTypeRules = null;
        this._styleElement = null;
        this._uniqueClass = null;
        // we need these now
        this._spec = spec;
        this.container = container;
        this._init();

        // mixinResultDisplay
        this.aggregateResults = null;
        this._aggregateResultElements = null;
        this._initResultDisplay();

        Parent.call(this, supreme, container, key, spec, data);


    }

    var _p = ResultsBlock.prototype = Object.create(Parent.prototype);

    mixinResultDisplay(_p);

    _p._activateResult = function(key) {
        var k
          , activeClass = 'active-result'
          ;
        this._activeResult = key;
        for(k in this._children) {
            if(k !== key) {
                this._children[k].container.classList.remove(activeClass);
                this._tabs[k].classList.remove(activeClass);
            }
            else {
                this._children[k].container.classList.add(activeClass);
                this._tabs[k].classList.add(activeClass);
            }
        }
    };

    _p._activateFirstResult = function() {
        var i, l, elem
          , childElements= this._tabsContainer.chldren;
         // activate the first element (in order)
        for(i=0,l=childElements.length;i<l;i++) {
            elem = childElements[i];
            if(elem.hasAttribute('data-result-key')) {
                this._activateResult(elem.getAttribute('data-result-key'));
                break;
            }
        }
        // nothing found
        this._activeResult = null;
    };

    _p._validateEvent = function(event, stopElement, searchAttribute) {
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
    };

    _p._selectResultHandler = function(event) {
        var searchAttribute = 'data-result-key'
          , stopElement = this._tabsContainer
          , key = this._validateEvent(event, stopElement, searchAttribute)
          ;
        if(key !== undefined)
            this._activateResult(key);
    };

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
       this._aggregateResultElements[name].classList.toggle('inactive');
       this._aggregateResultElements[name].classList.toggle('active');
    };

    _p._initAggregateResultHandler = function(name) {
        // default is active, but we can override this here
        // TODO: make configurable?
        if(name !== 'ERROR' && name !== 'WARNING')
            this._toggleResultType(name);
    };

    _p._selectResultTypeHandler = function(event) {
        var searchAttribute = 'data-result-type'
          , stopElement = this._resultAggregationContainer
          , name = this._validateEvent(event, stopElement, searchAttribute)
          ;
        if(name !== undefined)
            this._toggleResultType(name);
    };

    _p._init = function() {
        this._tabsContainer.addEventListener('click', this._selectResultHandler.bind(this));

        // init
        this._createdResultTypeRules = new Set();
        this._styleElement = dom.createElement('style');
        // will be removed on destroy!
        this._styleElement.ownerDocument.head.appendChild(this._styleElement);
        this._uniqueClass = 'unique-class-' + Math.round(Math.random() * Math.pow(10, 17));
        this.container.classList.add(this._uniqueClass);

        this._resultAggregationContainer.addEventListener('click', this._selectResultTypeHandler.bind(this));
    };

    _p.destroy = function() {
        Parent.prototype.destroy.call(this);
        dom.removeNode(this._styleElement);
    };

    _p.remove = function(key) {
        if(this._tabs[key]) {
            dom.removeNode(this._tabs[key]);
            delete this._tabs[key];
        }
        Parent.prototype.remove.call(this, key);
    };

    _p._makeChildContainer = function(key) {
        // jshint unused:vars
        var elem = this._spec[''].getElementFromTemplate(this._spec[''].docTemplateClass);
        elem.setAttribute('data-result-key', key);
        return elem;
    };

    _p._createTab = function(key) {
        var tab = this._spec[''].getElementFromTemplate(this._spec[''].tabTemplateClass)
          , tabTitleMarker = this._spec[''].insertionMarkerPrefix + 'title'
          , tabTitleTarget = dom.getMarkerComment(tab, tabTitleMarker)
          , tabTitle = dom.createElement('span', {}, key)
          ;
        dom.insert(tabTitleTarget, 'after', tabTitle);
        tab.setAttribute('data-result-key', key);
        return tab;
    };

    _p._insertChild = function(key, child) {
        var k, count=0, name;
        Parent.prototype._insertChild.call(this, key, child);

        child.onResultChange(this.resultChangeHandler);
        for(name in child.aggregateResults) {
            if(name === '~~total~~')
                continue;
            if(!(name in this.aggregateResults))
                this._initResultValueName(name);
            this.aggregateResults[name] += child.aggregateResults[name];
        }

        // tabs
        for(k in this._children) {
            count++;
            if(count>1) return;
        }
        // this was the first element (in time), activate
        if(count === 1)
            this._activateResult(k);
    };

    _p._deleteChild = function(key) {
        var name, child = this.getChild(key);
        for(name in child.aggregateResults) {
            if(name in this.aggregateResults)
                this.aggregateResults[name] -= child.aggregateResults[name];
        }

        Parent.prototype._deleteChild.call(this. key);

        // tabs
        if(this._activeResult === key)
            this._activateFirstResult();
    };

    _p._insertChildContainer = function(key, container) {
        var tab, keys, index, insertAfterKey, tabTarget, containerTarget;

        function analyzeFontName(name) {
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

        function compare(a, b) {
            var aFont, bFont;
            if(a === b)
                return 0;

            if(a === 'CrossFamilyChecks')
                return -1;
            if(b === 'CrossFamilyChecks')
                return 1;

            aFont = analyzeFontName(a);
            bFont = analyzeFontName(b);

            // put fonts before other result keys
            if(aFont && !bFont)
                return -1;
            else if(!aFont && bFont)
                return 1;
            else { //aFont && bIsFont
                if (aFont.name !== bFont.name)
                    return aFont.name < bFont.name ? -1 : 1;
                if (aFont.weight !== bFont.weight)
                    return aFont.weight - bFont.weight;
            }
            return a < b ? -1 : 1;
        }

        keys = Object.keys(this._children);
        if(keys.length) {
            keys.push(key);
            keys.sort(compare);
            index = keys.indexOf(key);
            if(index > 0)
                insertAfterKey = keys[index-1];
        }

        if(!this._tabs[key]) {
            // create a new tab
            tab = this._createTab(key);
            this._tabs[key] = tab;
        }
        else
            tab =  this._tabs[key];

        if(insertAfterKey) {
            tabTarget = this._tabs[insertAfterKey];
            containerTarget = this._children[insertAfterKey].container;
        }
        else {
            // insert as first item
            tabTarget = dom.getMarkerComment(this.container, this._tabsMarker);
            containerTarget = dom.getMarkerComment(this.container, this._docsMarker);
        }

        dom.insert(tabTarget, 'after', tab);
        dom.insert(containerTarget, 'after', container);
    };

    return ResultsBlock;
    })();

    var ResultDocBlock = (function() {
    var Parent = GenericDictionaryBlock;

    function ResultDocBlock(supreme, container, key, spec, data) {
        // mixinResultChangeChannel
        this._resultChangeSubscriptions = [];

        // mixinResultDisplay
        this.aggregateResults = null;
        this._aggregateResultElements = null;
        // we need these now
        this._spec = spec;
        this.container = container;
        this._initResultDisplay();

        this.resultChangeHandler = this._resultChangeHandler.bind(this);

        Parent.call(this, supreme, container, key, spec, data);
    }
    var _p = ResultDocBlock.prototype = Object.create(Parent.prototype);

    mixinResultChangeChannel(_p);
    mixinResultDisplay(_p);

    _p._insertChild = function(key, child) {
        Parent.prototype._insertChild.call(this, key, child);

        // for each child added
        child.onResultChange(this.resultChangeHandler);
        // one problem is that we miss the initial value like this, thus:
        var initialValue = child.getResult();
        if(initialValue)
            this.resultChangeHandler([[initialValue, 1]]);
    };

    _p._resultChangeHandler =function (report) {
        this.__resultChangeHandler(report);
        this._dispatchResultChange(report);
    };

    return ResultDocBlock;
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


        // Here are the definitions for our current document format.
        var getTemplateForSelector = dom.getChildElementForSelector.bind(null, templatesContainer)
            // this is to define the order of check result values
            // in the interfaces aggregating these.
          , resultVals = ['ERROR', 'WARNING', 'OK', 'SKIP']
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
            ,  inlineTextSpec = {
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
                        var klass = this.getClassForKey(key)
                          , template = getTemplateForSelector('.' + klass)
                          ;
                        return template ? template.cloneNode(true) : null;
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
          , resultsSpec = {
                Type: ResultsBlock
              , spec: {
                    '': {
                        tabTemplateClass: 'report-container_results_result-tab'
                      , docTemplateClass: 'report-container_results_result-doc'
                      , insertionMarkerPrefix: 'insert: '
                      , resultIndicatorClass: 'result-value_indicator-button'
                      , getElementFromTemplate: function(klass) {
                            var template = getTemplateForSelector('.' + klass);
                            return template ? template.cloneNode(true) : null;
                        }
                      , resultVals: resultVals
                      , GenericType: ResultDocBlock
                      , genericSpec: {
                            '' :{
                                GenericType: CheckItemDocBlock
                              , genericSpec: checkItemSpec
                              , getElementFromTemplate: function(klass) {
                                    var template = getTemplateForSelector('.' + klass);
                                    return template ? template.cloneNode(true) : null;
                                }
                              , getElementForKeyFromTemplate: function(key) {
                                    // jshint unused: vars
                                    // in this case this tries to return
                                    // the same Template for all children
                                    // ResultDocBlock is more like an Array
                                    // but it has dictionary keys ...
                                    var template = getTemplateForSelector('.result-doc_check-item');
                                    return template ? template.cloneNode(true) : null;
                                }
                              , resultVals: resultVals
                            }
                        }
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
                        var klass = this.getClassForKey(key)
                          , template = getTemplateForSelector('.' + klass)
                          ;
                        return template ? template.cloneNode(true) : null;
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
              , stderr: preformatedTextSpec
              , stdout: preformatedTextSpec
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
              , results: resultsSpec
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
