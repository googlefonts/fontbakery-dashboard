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
    /* global setTimeout */

    var genericBlockFactory = reporterBlocks.genericBlockFactory
      , Supreme = reporterBlocks.Supreme
      , PrimitiveValueBlock = reporterBlocks.PrimitiveValueBlock
      , FlexibleDocumentBlock = reporterBlocks.FlexibleDocumentBlock
      , DictionaryBlock = reporterBlocks.DictionaryBlock
      , binInsert = reporterBlocks.binInsert
      ;

    var CollectionReportDocumentBlock = FlexibleDocumentBlock;

    var HrefDocumentBlock = (function() {
    var Parent = PrimitiveValueBlock;
    function HrefDocumentBlock(supreme, container, key, spec, data) {
        this._anchor = dom.createElement('a', {}, data);
        if(typeof spec[''].url === 'string')
            this.url = spec[''].url;
        else if(typeof spec[''].url === 'function')
            this.url = spec[''].url(data);

        dom.appendChildren(container,this._anchor);
        Parent.call(this, supreme, container, key, spec, data);
    }
    var _p = HrefDocumentBlock.prototype = Object.create(Parent.prototype);

    Object.defineProperty(_p, 'url', {
        set: function(url) {
            this._anchor.setAttribute('href', url);
        }
    });

    return HrefDocumentBlock;
    })();

    function insertOrdered(parent, lastItem, item) {
        var pos, elem;
        if(lastItem && lastItem.parentNode !== parent)
            throw new Error('lastItem.parentNode !== parent but it must be!');
        if(!lastItem) {
            pos = 'prepend';
            elem = parent;
            if(elem.firstChild === item)
                return;
        }
        else {
            pos = 'after';
            elem = lastItem;
            if(elem.nextSibling === item)
                return;
        }
        dom.insert(elem, pos, item);
    }

    // The table controller
    var ReportsDictBlock = (function() {
    var Parent = DictionaryBlock;
    function ReportsDictBlock(supreme, container, key, spec, data) {
        this.supreme = supreme;
        var headMarker = spec[''].insertionMarkerPrefix + 'head-row'
          , childMarker =  spec[''].insertionMarkerPrefix + 'body'
          , getElementFromTemplate = spec[''].getElementFromTemplate.bind(spec[''])
          ;

        this._head = getElementFromTemplate(spec[''].headClass, true);
        this._childrenContainer = getElementFromTemplate(spec[''].childrenContainerClass, true);

        dom.insertAtMarkerComment(container, headMarker, this._head, false);
        dom.insertAtMarkerComment(container, childMarker, this._childrenContainer, false);

        this._childrenInsertMarker = dom.getMarkerComment(this._childrenContainer
                            , spec[''].insertionMarkerPrefix +'children');

        this._colOrderSections = [];
        this._colOrders = Object.create(null);
        this._labels = Object.create(null);

        this._rowOrderColumn = 'results.FAIL'; //type.key
        this._rowOrderReversed = true;
        this._childrenOrder = [];
        this._head.addEventListener('click'
                                    , this._setRowOrderHandler.bind(this));
        this._updateLabelsOrderUI();

        // shadows the prototype with a bound version
        this._compareChildren = this._compareChildren.bind(this);

        ['pre', 'results', 'after'].forEach(this._addOrderSection, this);
        Array.prototype.push.apply(this._colOrders['results'], spec[''].resultVals);

        this._updateLabelsColOrder();
        this._unsubscribeNewKey = this.supreme.pubSub.subscribe(
                                'new-key', this._updateOrder.bind(this));
        this._publishOrder('results');

        this._reorderRowsScheduling = null;
        this.supreme.pubSub.subscribe('changed-row', this._onChangedRow.bind(this));

        Parent.call(this, supreme, container, key, spec, data);
    }

    var _p = ReportsDictBlock.prototype = Object.create(Parent.prototype);
    _p.constructor = ReportsDictBlock;

    _p._updateLabel = function(label) {
        var key = label.getAttribute('data-column-key')
          , isOrdering = key === this._rowOrderColumn
          ;
        label.classList[isOrdering ? 'add' : 'remove']('ordering-column');
    };

    _p._updateLabelsOrderUI = function() {
        var k
          , toggle = this._rowOrderReversed ? 'add' : 'remove'
          ;
        this._head.classList[toggle]('ordering-reversed');
        for(k in this._labels)
           this._updateLabel(this._labels[k]);
    };

    _p._setRowOrderHandler = function (event) {
        var searchAttribute = 'data-column-key'
          , stopElement = this._head
          , key = dom.validateChildEvent(event, stopElement, searchAttribute)
          ;
        if(key === undefined)
            return;
        if(key !== this._rowOrderColumn)
            this._rowOrderColumn = key;
        else
            // when the column was already selected, reverse the ordering.
            this._rowOrderReversed = !this._rowOrderReversed;
        this._updateLabelsOrderUI();
        this._scheduleReorderRows();
    };

    _p._reorderRows = function() {
        var ordered = this._childrenOrder = Object.values(this._children)
                        .sort(this._compareChildren)
          , lastItem = null
          , i, l, item
          ;
        for(i=0,l=ordered.length;i<l;i++) {
            item = ordered[i].container;
            insertOrdered(this._childrenContainer, lastItem, item);
            lastItem = item;
        }

        this._reorderRowsScheduling = null;
    };

    // Table live reordering
    _p._scheduleReorderRows = function() {
        if(this._reorderRowsScheduling)
            return;
        this._reorderRowsScheduling = setTimeout(this._reorderRows.bind(this));
    };

    _p._onChangedRow = function(type, key) {
        if(this._rowOrderColumn.indexOf(type) !== 0)
            // a bit quicker than the test below
            return;
        if(this._rowOrderColumn !== [type, key].join('.'))
            return;
        this._scheduleReorderRows();
    };

    _p._compareChildren = function(a, b) {
        var result
          , valA = this._rowOrderColumn
                        ? a.getValueFor(this._rowOrderColumn)
                        : a.key
          , valB = this._rowOrderColumn
                        ? b.getValueFor(this._rowOrderColumn)
                        : b.key
          ;

        if(valA === valB)
            return 0;

        // mot defined: always at bottom
        if(valA === null)
            return 1;
        if(valB === null)
            return -1;

        // normal ordering
        result = (valA > valB) ? 1 : -1;
        if(this._rowOrderReversed)
            result = -result;
        return result;
    };

    _p._publishOrder = function() {
        var fullOrder = [], i, l, j, ll, type, order, key;
        for(i=0,l=this._colOrderSections.length;i<l;i++) {
            type = this._colOrderSections[i];
            order = this._colOrders[type];
            for(j=0,ll=order.length;j<ll;j++) {
                key = order[j];
                fullOrder.push([type, key].join('.'));
            }
        }
        this.supreme.pubSub.publish('order', fullOrder);
    };

    _p._addOrderSection = function(key) {
        if(key in this._colOrders)
            return;
        this._colOrderSections.push(key);
        this._colOrders[key] = [];
    };

    _p.destroy = function() {
        Parent.prototype.destroy.call(this);
        this._unsubscribeNewKey();
    };

    _p._getLabel = function(type, key) {
        var labelKey = [type, key].join('.')
          , labelText = key
          , label = this._labels[labelKey]
          , attr
          ;
        if(!label) {
            attr = {'data-column-key': labelKey};
            // hardcoded yet, needs improvement at some point
            if(type === 'results')
                attr['class'] = 'fontbakery_status-' + key;
            this._labels[labelKey] = label = dom.createElement(
                                                    'th', attr, labelText);
            this._updateLabel(label);
        }
        return label;
    };

    _p._insertLabel = function(lastLabel, type, key) {
        var label = this._getLabel(type, key);
        insertOrdered(this._head, lastLabel, label);
        return label;
    };

    _p._updateLabelsColOrder = function() {
        var type, order
          , i, l, j, ll, key
          , lastLabel = null
          ;
        for(i=0,l=this._colOrderSections.length;i<l;i++) {
            type = this._colOrderSections[i];
            order = this._colOrders[type];
            for(j=0, ll=order.length;j<ll;j++) {
                key = order[j];
                lastLabel = this._insertLabel(lastLabel, type, key);
            }
        }
    };

    _p._updateOrder = function(type, key) {
        var order = this._colOrders[type];
        if(order.indexOf(key) !== -1)
            return;
        // just append, we have a known order via spec[''].resultVals
        // everything else is undefined an just goes to the end
        order.push(key);
        this._updateLabelsColOrder();

        // The children store a reference to order, thus always
        // publish a copy (this is called defensive copying, immutable data is better here)
        this._publishOrder();
    };

    _p._makeChildContainer = function(key) {
        // jshint unused:vars
        // elem should be a <tr>
        var elem = this._spec[''].getElementFromTemplate(this._spec[''].childClass, true);
        return elem;
    };


    _p._insertChildContainer = function(key, container) {
        // jshint unused:vars
        // pass, see _insertChild
    };
    /**
     *  insert into this._container at the right position
     */
    _p._insertChild = function(key, block) {
        var child = block
          , position, reference, target, orderIndex
          ;
        Parent.prototype._insertChild.call(this, key, block);

        if(!this._childrenOrder.length){
            reference = this._childrenContainer;
            position = 'prepend';
            orderIndex = 0;
        }
        else {
            target = binInsert(child, this._childrenOrder, this._compareChildren, true);
            reference = this._childrenOrder[target.index].container;
            position = target.pos;
            orderIndex = target.index + (target.pos === 'after' ? 1 : 0);
        }
        this._childrenOrder.splice(orderIndex, 0, child);
        dom.insert(reference, position, child.container);
    };

    return ReportsDictBlock;
    })();

    // Add link to full report to family_dir
    // Add one result/status derived item displaying % done + result  by order (=weight)
    //     worse result, colored cell + word, order by weight
    //     arguably very useful, will probably never be green since we'll always
    //     have INFO/SKIP/WARN. We could reduce it to ERROR/FAIL/PASS though
    //     INFO/SKIP/WARN are considered a PASS then. Could be color plus total
    //     percentage and if finished (== 100%) ERROR|FAIL|PASS
    var ReportDictBlock = (function() {
    var Parent = DictionaryBlock;
    function ReportDictBlock(supreme, container, key, spec, data) {
        this._genericItemsContainer = dom.getChildElementForSelector(
                                    container, '.generic-items', true);

        this._order = [];
        this._childContainers = Object.create(null);

        // very nasty way to inject into the results block
        this.supreme = Object.create(supreme);
        this.supreme.makeResultsChildContainer = this._getChildContainer
                                                     .bind(this, 'results');

        this._unsubscribeOrder = this.supreme.pubSub.subscribe('order'
                                            , this._updateOrder.bind(this));
        Parent.call(this, this.supreme, container, key, spec, data);
        this._applyOrder(); // needs this.container
    }

    var _p = ReportDictBlock.prototype = Object.create(Parent.prototype);
    _p.constructor = ReportDictBlock;

    _p._insertItem = function(lastItem, type, key) {
        var item = this._getChildContainer(type, key);
        insertOrdered(this.container, lastItem, item);
        return item;
    };

    _p.getValueFor = function(fullKey) {
        var dot = fullKey.indexOf('.')
          , type = fullKey.slice(0, dot)
          , key = fullKey.slice(dot+1)
          , block
          ;
        if(type === 'results') {
            if(!this.hasChild(type))
                return null;
            block = this.getChild(type);
        }
        else
            block = this;

        return block.hasChild(key) ? block.getChild(key).data : null;
    };

    _p._updateOrder = function(newOrder) {

        if(this._order.join(',') === newOrder.join(','))
            return;

        this._order = newOrder;
        this._applyOrder();
    };

    _p._applyOrder =function() {
        var i, l, fullKey, dot, type, key, lastItem;
        if(!this.container)
            return;
        for(i=0,l=this._order.length;i<l;i++) {
            fullKey = this._order[i];
            dot = fullKey.indexOf('.');
            type = fullKey.slice(0, dot);
            key = fullKey.slice(dot+1);
            lastItem = this._insertItem(lastItem, type, key);
        }
        // Todo: remove containers from DOM if not in this._order.
        //       However, does not happen atm.
        // maybe we could use jiff for this. It should make the dom
        // manipulation minimal and also deal with removals.
    };

    _p._propagateTotal = function() {
        var total, results;
        if(!this.hasChild('total') || !this.hasChild('results'))
            return;
        results = this.getChild('results');
        total =  this.getChild('total');
        results.setTotal(parseInt(total.data, 10));
    };

    _p._insertChild = function(key, child) {
        Parent.prototype._insertChild.call(this, key, child);
        // TODO: maybe only send this if the row is interesting
        // makes up a lot less calls!

        if(key === 'total' || key === 'results')
            this._propagateTotal();
        if(key === 'familytests_id' || key === 'family_name' &&
                (this._children.family_name && this._children.familytests_id))
            this._children.family_name.url = '/report/' + this._children.familytests_id.data;

        this.supreme.pubSub.publish('changed-row', 'pre', key);
    };

    _p._getChildContainer = function(type, key) {
        var fullKey = [type, key].join('.')
          , elem = this._childContainers[fullKey]
          ;
        if(!elem) {
            this._childContainers[fullKey] = elem = dom.createElement('td');
            // register new-key ...
            this.supreme.pubSub.publish('new-key', type, key);
        }
        return elem;
    };

    /**
     * Returns a DOM-Element, that is not yet in the document
     */
    _p._makeChildContainer = function(key) {
        var elem;
        if(key === 'results')
            return;
        if(this._spec[''].containerless.has(key))
            return;
        elem = this._getChildContainer('pre', key);
        dom.clear(elem);
        return elem;
    };

    _p._insertChildContainer = function(key, container) {
        // jshint unused:vars
        // pass, done by _updateOrder
        return;
    };
    return ReportDictBlock;

    })();

    var ResultsDictionaryBlock = (function() {
    var Parent = DictionaryBlock;
    function ResultsDictionaryBlock(supreme, container, key, spec, data) {
        this.container = container;
        this.supreme = supreme;
        this._total = null;
        Parent.call(this, supreme, container, key, spec, data);
    }

    var _p = ResultsDictionaryBlock.prototype = Object.create(Parent.prototype);
    _p.constructor = ResultsDictionaryBlock;


    _p._makeChildContainer = function(key) {
        // jshint unused: vars
        var container = this.supreme.makeResultsChildContainer(key);
        // we reuse this one ...
        dom.clear(container);
        return container;
    };

    _p._insertChildContainer = function(key, container) {
        // jshint unused:vars
        // pass, parent is responsible for this task now!
        return;
    };

    _p._insertChild = function(key, child) {
        Parent.prototype._insertChild.call(this, key, child);
        // TODO: maybe only send this if the row is interesting
        // makes up a lot less calls!
        if(this._total !== null)
            child.setTotal(this._total);
        this.supreme.pubSub.publish('changed-row', 'results', key);
    };

    _p.setTotal = function(total) {
        this._total = total;
        this._eachChild(function(item){item.setTotal(total);});
    };

    return ResultsDictionaryBlock;
    })();

    var ResultValueBlock = (function() {
    var Parent = PrimitiveValueBlock;
    function ResultValueBlock(supreme, container, key, spec, data) {
        this._value = parseInt(data, 10);
        Parent.call(this, supreme, container, key, spec, data);

        this._total = null;

        this._showPercentages = true;// default
        this._unsubscribesSowPercentages = this.supreme.pubSub.subscribe(
                    'show-percentages', this._setSowPercentages.bind(this));

        this._initialized = true;
        this._render();
    }

    var _p = ResultValueBlock.prototype = Object.create(Parent.prototype);

    /**
     * For simple values this is simply returning the value,
     * but objects and arrays need to query all their children.
     */
    Object.defineProperty(_p, 'data', {
        get: function() {
            if(this._total && this._showPercentages)
                return this._totalRatio();
            return this._value;
        }
    });

    _p.destroy = function() {
        Parent.prototype.destroy.call(this);
        this._unsubscribesSowPercentages();
    };

    _p._totalRatio = function() {
        return this._data / this._total;
    };

    _p._render = function() {
        if(!this._initialized)
            return;
        var percent, main, other;
        if(!this._total)
            percent = 'N/A';
        else
            percent = [Math.round(this._totalRatio() * 10000) / 100
                                                        , '%'].join('');
        if(this._total && this._showPercentages) {
            main = percent;
            other = this._data;
        }
        else {
            main = this._data;
            other = percent;
        }

        dom.clear(this.container);
                                                  // \xa0 == nbsp
        dom.appendChildren(this.container, [main, '\xa0(', other, ')'].join(''));
    };

    _p.setTotal = function(total) {
        var old = this._total;
        this._total = total;
        this._render();
        // did the value change? we need to re-order the table...
        if(old !== this._total)
            this.supreme.pubSub.publish('changed-row', 'results', this.key);

    };
    _p._setSowPercentages = function(bool) {
        var old = this._showPercentages;
        this._showPercentages = bool;
        this._render();
        // did the value change? we need to re-order the table...
        if(old !== this._showPercentages)
            this.supreme.pubSub.publish('changed-row', 'results', this.key);
    };

    return ResultValueBlock;
    })();

    function CollectionReport(container, templatesContainer, data) {
        this.container = container;
        this._docid = data.docid;
        this._reports = new Map();
        this._slots = new Map();

        function getElementFromTemplate(klass, deep) {
            var template = getTemplateForSelector('.' + klass, deep);
            return template ? template.cloneNode(true) : null;
        }

        // Here are the definitions for our current document format.
        var getTemplateForSelector = dom.getChildElementForSelector.bind(dom, templatesContainer)
            // this is to define the order of check result values
            // in the interfaces aggregating these.
          , resultVals = ['FAIL', 'WARN', 'SKIP', 'INFO', 'PASS'] // 'ERROR' will only be shown if errors happen
          , datesSpec = {
                spec: {
                    '': {
                        skipKey: true
                      , dataFormater: function(data){
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
          , resultsSpec = {
                Type: ResultsDictionaryBlock
              , spec: {
                    '': {
                        GenericType: ResultValueBlock
                      , genericSpec: {
                            '': {
                            }
                        }
                    }
                }
            }
          , reportSpec = {
                // is generic ReportDictBlock a FlexibleDocumentBlock
                '': {
                    GenericType: genericBlockFactory
                  , genericSpec: { // the items that currently go into the
                        '': {
                            skipKey: true
                          //, skipData: true
                        }
                    }
                  , containerless: new Set(['created', 'id', 'date'
                                        , 'metadata', 'familytests_id'])
                  , classPrefix: 'collection-report_'
                  , insertionMarkerPrefix: 'insert: '
                  , getElementFromTemplate: getElementFromTemplate
                  , resultVals: resultVals
                  , childTag: 'span'
                }
              , results: resultsSpec
              , family_name: {
                    Type: HrefDocumentBlock
                  , spec: {
                        '': {
                        }
                    }
                }
              , exception: preformatedTextSpec
              , started: datesSpec
              , finished: datesSpec
              , created: datesSpec
              , date: datesSpec
            }
          , reportsSpec = {
                Type: ReportsDictBlock
              , spec: {
                    '': {
                        GenericType: ReportDictBlock
                      , genericSpec: reportSpec
                      , insertionMarkerPrefix: 'insert: '
                      , getElementFromTemplate: getElementFromTemplate
                      , templatesContainer: templatesContainer
                      , headClass: 'collection-report_reports-head'
                      , childClass: 'collection-report_reports-results'
                      , childrenContainerClass: 'collection-report_reports-children'
                      , resultVals: resultVals
                    }
                }
            }
          , spec = { // CollectionReportDocumentBlock is a FlexibleDocumentBlock
                '': {
                    GenericType: genericBlockFactory
                  , classPrefix: 'collection-report-container_'
                  , insertionMarkerPrefix: 'insert: '
                  , getElementFromTemplate: getElementFromTemplate
                  , containerless: new Set([])
                }
              , id: {
                    Type: HrefDocumentBlock
                  , spec: {
                        '': {
                            // kind of unflexible, but it has minimal
                            // knowledge of the url schema
                            url: data.url[0] === '/' ? data.url : '/' + data.url
                        }
                    }
                }
              , reports: reportsSpec
            }
          , rootTemplateElement = getTemplateForSelector('.report-root')
          , rootInsertionMarker = 'insert: report-root'
          ;

        this.supreme = new Supreme(
                                     CollectionReportDocumentBlock
                                   , this.container
                                   , rootTemplateElement
                                   , rootInsertionMarker
                                   , spec
                                   );

        this._switchPercentagesElem = dom.getChildElementForSelector(
                                    container, '.switch-percentages', true);

        this._displayPercentages = true;
        if(this._switchPercentagesElem) {
            this._switchPercentagesElem.addEventListener('click',
                        this._togglePercentagesDisplayHandler.bind(this));
            this._togglePercentagesDisplay(this._displayPercentages);
        }

    }
    var _p = CollectionReport.prototype;

    _p._togglePercentagesDisplayHandler = function(event){
        //jshint unused: vars
        this._togglePercentagesDisplay();
    };
    _p._togglePercentagesDisplay = function(forcedVal) {
        var label;
        this._displayPercentages = arguments.length
                                            ? forcedVal
                                            : !this._displayPercentages
                                            ;
        dom.clear(this._switchPercentagesElem);
        label = this._displayPercentages
                        ? 'Show Absolute Numbers'
                        : 'Show Percentages'
                        ;
        dom.appendChildren(this._switchPercentagesElem, label);
        this.supreme.pubSub.publish('show-percentages', this._displayPercentages);
    };

    _p.onChange = function (data) {
        // ALL `data` represents always a family-report never a `collection-report`
        // Eventually, ReportsDictBlock should be the root block
        // and CollectionReportDocumentBlock should be separated, if we need
        // to display more Collection metadata.
        // But, *maybe*, we can also just do selective updates for the
        // collection-report data (omitting the contents of `reports`
        // and thus not creating any diffs for it. would be bad though
        // if the differ decides to replace the whole doc.

        console.log(new Date(), 'got change data:', data);
        var newReport = data.new_val
          , oldVal, newVal, patches
          , slotKey = 'family_name'
          , idKey = 'id'
          , reportId = newReport[idKey]
          , slot = newReport[slotKey]
          , oldSlotId = this._slots.get(slot)
          ;

        oldVal = {};
        // initially oldVal has no reports
        if(this._reports.size !== 0)
            oldVal.reports = {};

        // replace and update cases should be mutually exclusive!
        // Let's make sure they are.
        if(oldSlotId !== reportId && this._reports.has(oldSlotId)
                                  && this._reports.has(reportId))
            throw new Error('Assertion failed: replace and update cases '
                            + 'should be mutually exclusive! '
                            + 'oldSlotId: "' + oldSlotId + '"'
                            + 'reportId: "' + reportId + '"'
                            );
        // replace case
        // oldSlotId !== newReportID
        if(oldSlotId && oldSlotId !== reportId) {
            oldVal.reports[oldSlotId] = this._reports.get(oldSlotId);
            this._reports.delete(oldSlotId);
        }
        // standard update case
        // slotId === newReportID
        if(this._reports.has(reportId))
             oldVal.reports[reportId] = this._reports.get(reportId);


        // insert case
        // !this._reports.has(newReportID) &&
        newVal = {reports: {}};
        newVal.reports[reportId] = newReport;

        // update store everything for the next patching
        this._reports.set(reportId, newReport);
        this._slots.set(slot, reportId);

        patches = jiff.diff(oldVal, newVal);

        // The api understands full JSONPAtch
        // there are generic renderers for unspecified data
        console.log('patches', patches);
        this.supreme.applyPatches(patches);
    };

    return CollectionReport;
});
