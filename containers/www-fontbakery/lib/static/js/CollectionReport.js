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
      , PrimitiveValueBlock = reporterBlocks.PrimitiveValueBlock
      , FlexibleDocumentBlock = reporterBlocks.FlexibleDocumentBlock
      , GenericDictionaryBlock = reporterBlocks.GenericDictionaryBlock
      , DictionaryBlock = reporterBlocks.DictionaryBlock
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

    //<row>s in the reports table
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


        this._order =  spec[''].resultVals.slice();
        this._labels = Object.create(null);
        this._updateLabels();
        this._unsubscribeResultsKey = this.supreme.pubSub.subscribe(
                          'results-new-key' , this._updateOrder.bind(this));
        this.supreme.pubSub.publish('results-order', this._order.slice());
        Parent.call(this, supreme, container, key, spec, data);

    }
    var _p = ReportsDictBlock.prototype = Object.create(Parent.prototype);
    _p.constructor = ReportsDictBlock;

    _p.destroy = function() {
        Parent.prototype.destroy.call(this);
        this._unsubscribeResultsKey();
    };

    _p._updateLabels = function() {
        this._order.forEach(function(key) {
            //jshint validthis: true
            var label = this._labels[key];
            if(!label)
                this._labels[key] = label = dom.createElement('th', null, key);
            // Interesting: this way the inital first-child <th> stays
            // where it is no further action required
            dom.appendChildren(this._head, this._labels[key]);
        }, this);
    };

    _p._updateOrder = function(key) {
        if(this._order.indexOf(key) !== -1)
            return;
        // just append, we have a known order via spec[''].resultVals
        // everything else is undefined an just goes to the end
        this._order.push(key);
        this._updateLabels();

        // The children store a reference to order, thus always
        // publish a copy.
        this.supreme.pubSub.publish('results-order', this._order.slice());
    };

    _p._makeChildContainer = function(key) {
        // jshint unused:vars
        var elem = this._spec[''].getElementFromTemplate(this._spec[''].childClass, true);
        return elem;
    };

    _p._insertChildContainer = GenericDictionaryBlock.prototype._insertChildContainer;

    return ReportsDictBlock;
    })();

    // TODO:
    // colored table headers
    // results as percentages (better for sorting!) and in parenthesis the actual number
    // plus columns:
    //      `Total` amount of tests
    //      `Result` by order (=weight) worsed result, colored cell + word, order by weight
    // Family: with link to full report
    //      clean up how the header and possibly other keys are inserted
    //      no more generic items or such. synthetic columns need a place
    //      after th as well
    // Make
    // indicator if a test isFinished (maybe result has a spinner when not finished ...)
    // OR Total has a percentage, like 100% of {total}
    var ReportDictBlock = (function() {
    var Parent = FlexibleDocumentBlock;
    function ReportDictBlock(supreme, container, key, spec, data) {

        this._genericItemsContainer = dom.getChildElementForSelector(
                                    container, '.generic-items', true);
        Parent.call(this, supreme, container, key, spec, data);
    }

    var _p = ReportDictBlock.prototype = Object.create(Parent.prototype);
    _p.constructor = ReportDictBlock;

    /**
     * Returns a DOM-Element, that is not yet in the document
     */
    _p._makeChildContainer = function(key) {
        var insertionMarker;
        if(key === 'results') {
            insertionMarker = this._spec[''].insertionMarkerPrefix + key;
            return dom.getMarkerComment(this.container, insertionMarker);
        }
        return Parent.prototype._makeChildContainer.call(this, key);
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
        this._childContainers = Object.create(null);
        this._order = [];
        this.supreme = supreme;
        this._unsubscribeOrder = this.supreme.pubSub.subscribe('results-order'
                                  , this._updateOrder.bind(this));
        Parent.call(this, supreme, container, key, spec, data);
    }
    var _p = ResultsDictionaryBlock.prototype = Object.create(Parent.prototype);
    _p.constructor = ResultsDictionaryBlock;

    _p.destroy = function() {
        Parent.prototype.destroy.call(this);
        this._unsubscribeOrder();
    };

    _p._updateOrder = function(newOrder) {
        console.log('_updateOrder',newOrder.join(','));
        if(this._order.join(',') === newOrder.join(','))
            return;

        this._order = newOrder;

        this._order.forEach(function(key) {
            // jshint validthis:true
            // create the children of not present yet
            var container = this._makeChildContainer(key);
            // (re-)insert the children in the new order
            this._insertChildAtMark(container);
        }, this);
        // Todo: remove containers from DOM if not in this._order.
        //       However, does not happen atm.
        // maybe we could use jiff for this. It should make the dom
        // manipulation minimal and also deal with removals.
    };

    _p._makeChildContainer = function(key) {
        // jshint unused: vars
        var container = this._childContainers[key];
        if(!container) {
            this._childContainers[key] = container = dom.createElement('td');
            // will call this function to create a container, but we have
            // it alreadt cached.

            this.supreme.pubSub.publish('results-new-key', key);
        }
        return container;
    };

    _p._deleteChild = function(key) {
        delete this._childContainers[key];
        Parent.prototype._deleteChild.call(this, key);
    };

    _p._insertChildAtMark = function(container) {
        dom.insert(this.container, 'before', container);
    };

    _p._insertChildContainer = function(key, container) {
        if(container.parentNode)
            // if it has a parentNode, we assume it is alreadt where it should
            // be, see _p._updateOrder
            return;
        console.log('child', key, 'has no parent');
        // basically, in this case we should almost never get to this
        // position, because _updateOrder would in all cases execute
        // before, as long as this.supreme.publish('results-new-key', key);
        // in _p._makeChildContainer is executed synchronously.
        this._insertChildAtMark(container);
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
                          , skipData: true
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
