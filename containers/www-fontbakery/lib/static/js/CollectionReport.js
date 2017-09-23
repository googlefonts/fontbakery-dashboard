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
        dom.appendChildren(container,
            [dom.createElement('a', {href: spec[''].url}, data)]);
        Parent.call(this, supreme, container, key, spec, data);
    }
    HrefDocumentBlock.prototype = Object.create(Parent.prototype);
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

    // TODO:
    // results as percentages (better for sorting!) and in parenthesis the actual number
    // plus columns:
    //      `Result` by order (=weight) worse result, colored cell + word, order by weight
    //               arguably very useful, will probably never be green since we'll always
    //               have INFO/SKIP/WARN. We could reduce it to ERROR/FAIL/PASS though
    //               INFO/SKIP/WARN are considered a PASS then. Could be color plus total
    //               percentage and if finished (== 100%) ERROR|FAIL|PASS
    // Family: with link to full report
    //      clean up how the header and possibly other keys are inserted
    //      no more generic items or such. synthetic columns need a place
    //      after th as well
    // Make
    // indicator if a test isFinished (maybe result has a spinner when not finished ...)
    // OR Total has a percentage, like 100% of {total}
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

        Parent.call(this, this.supreme, container, key, spec, data);
        this._unsubscribeOrder = this.supreme.pubSub.subscribe('order'
                                            , this._updateOrder.bind(this));
    }

    var _p = ReportDictBlock.prototype = Object.create(Parent.prototype);
    _p.constructor = ReportDictBlock;

    _p._updateLabels = function() {
        var type, order
          , i, l, j, ll, key
          , lastLabel = null
          ;
        for(i=0,l=this._orderSections.length;i<l;i++) {
            type = this._orderSections[i];
            order = this._orders[type];
            for(j=0, ll=order.length;j<ll;j++) {
                key = order[j];
                lastLabel = this._insertLabel(lastLabel, type, key);
            }
        }
    };

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
        var i, l, fullKey, dot, type, key, lastItem;
        if(this._order.join(',') === newOrder.join(','))
            return;

        this._order = newOrder;

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

    _p._insertChild = function(key, child) {
        Parent.prototype._insertChild.call(this, key, child);
        // TODO: maybe only send this if the row is interesting
        // makes up a lot less calls!
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
        if(key === 'results')
            return;
        if(this._spec[''].containerless.has(key))
            return;
        return this._getChildContainer('pre', key);
    };

    _p._insertChildContainer = function(key, container) {
        // jshint unused:vars
        // pass, done by _updateOrder
        return;
    };


    return ReportDictBlock;
    })();


    // To make all the patching work here, we need the full Tree structure
    // as Generic Types. The GenericBlockType may be just a dispatcher?
    // So we need GenericDictBlock, GenericArrayBlock, GenericPrimitiveValueBlock

    var ResultsDictionaryBlock = (function() {
    var Parent = DictionaryBlock;
    function ResultsDictionaryBlock(supreme, container, key, spec, data) {
        this.container = container;
        this.supreme = supreme;
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
        this.supreme.pubSub.publish('changed-row', 'results', key);
    };

    return ResultsDictionaryBlock;
    })();

    function CollectionReport(container, templatesContainer, data) {
        this.container = container;
        this._docid = data.docid;
        this._data = null;
        function getElementFromTemplate(klass, deep) {
            var template = getTemplateForSelector('.' + klass, deep);
            return template ? template.cloneNode(true) : null;
        }

        // Here are the definitions for our current document format.
        var getTemplateForSelector = dom.getChildElementForSelector.bind(dom, templatesContainer)
            // this is to define the order of check result values
            // in the interfaces aggregating these.
          , resultVals = ['ERROR', 'FAIL', 'WARN', 'SKIP', 'INFO', 'PASS']
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
          , justGenericValueSpec = {
                // is a genericBlockFactory
                Type: genericBlockFactory
              , spec: {
                    '': {
                        skipKey: true
                      , dataUnescaped: true
                    }
                }
            }
          , resultsSpec = {
                Type: ResultsDictionaryBlock
              , spec: {
                    '': {
                        genericSpec: {
                            // this spec renders the actual children
                            '': {
                                  skipKey: true
                                , dataUnescaped:true
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
                  , containerless: new Set(['created', 'id'])
                  , classPrefix: 'collection-report_'
                  , insertionMarkerPrefix: 'insert: '
                  , getElementFromTemplate: getElementFromTemplate
                  , resultVals: resultVals
                  , childTag: 'span'
                }
              , results: resultsSpec
              , family_dir: justGenericValueSpec
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
              , exception: preformatedTextSpec
              , created: datesSpec
              , started: datesSpec
              , finished: datesSpec
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
    }
    var _p = CollectionReport.prototype;

    _p.onChange = function (data) {

        // FIXME: this all scales bad, make reports as separate
        // roots somehow. Then, calculating  diffs will be much faster!

        console.log(new Date(), 'got change data:', data);
        var oldVal, patches;
        if(this._data === null) {
            // it's possible that a report comes first, this prepares the
            // document.
            this._data = {reports: {}};
            patches = jiff.diff({}, this._data);
            this.supreme.applyPatches(patches);
        }

        // if data.oldVal is null this is the initial change.
        oldVal = Object.assign({}, this._data);

        if(data.new_val && data.new_val.id === this._docid) {
            // this is the collection wide document
            this._data = data.new_val;
            this._data.reports = oldVal.reports || {};
        }
        else if(data.new_val) {
            // this is a report
            if(!this._data) this._data = {reports: {}};
            oldVal.reports = Object.assign({}, this._data.reports);
            this._data.reports[data.new_val.id] = data.new_val;
        }
        else if(!this._data.new_val && oldVal.id in this._data.reports) {
            // a report was deleted
            oldVal.reports = Object.assign({}, this._data.reports);
            delete this._data.reports[oldVal.id];
        }
        else {
            // !data.new_val && this._docid === oldVal.id
            // kind of the minimum that we expect
            this._data = {};
        }

        patches = jiff.diff(oldVal, this._data);

        // The api understands full JSONPAtch
        // there are generic renderers for unspecified data
        console.log('patches', patches);
        this.supreme.applyPatches(patches);
    };

    return CollectionReport;
});
