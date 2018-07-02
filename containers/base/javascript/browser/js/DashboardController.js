define([
    'dom-tool'
  , 'isEqual'
  , 'reporterBlocks'
], function(
    dom
  , isEqual
  , reporterBlocks
) {
    "use strict";
    /*global setTimeout, clearTimeout, Set, Map, console*/
    // TODO: make this extra instead of part of reporterBlocks?
    var binInsert = reporterBlocks.binInsert;
/**
    This manages a big table of collections.
    Collections are displayed next to each other.

    We use "family_name" to align the rows of the collections
    "family_name" is the "slotKey", the value of the "family_name" field
    is a "slot."
    A slot *must* be unique per source. I.e. One source can't
    have two or more entries with the same value for "family_name"
    Bad: [{family_name: "Roboto"},{family_name: "Roboto"},{family_name: "NotRoboto"}]

    Cells are organized within Rows which are organized within Collections.
    The DOM content of a Cell is rendered by its Representation.
    The values used by a Representation are Fields. A field can depend on
    any other field in the dashboard and use these values to define its
    own value. All fields are organized globally, to make updating centralized
    via a dependency graph.
    When the dashboard receives new data, this data is propagated to the
    rows that represent the data. If fields are dependent on this original
    data, they are updated and the updates are propagated until they
    arrive at the representations, through all involved fields.

    This works very much like a spreadsheet. No events are used, change
    propagates automatically.

    Collections and slots are added on runtime.
    Currently, we don't expect that rows or collections are deleted
    and there is also no way to detect this. May happen seldom,
    but the dashboard won't react live to this, instead hit reload.
*/

    function arraySum(values) {
        return values.reduce(function(sum, a) { return sum + a; }, 0);
    }
    function ratio (absolute, total) {
        return total && absolute !== null ? absolute/total : null;
    }
    function identity(value) {
        return value;
    }

    function resultIdentity(hasResults, value) {
        if (hasResults)
            return value === null ? 0 : value;
        return value; // may be null in this case
    }

    function percentIndicator(percent) {
        var elem = dom.createElement('div', {class:'percent-indicator'});
        elem.style.width = percent;
        return elem;
    }

    function percent(ratio) {
        if(!ratio && ratio !== 0)
            return null;
        var percentStr = Math.round(ratio * 10000)/100 + '%';
        return [percentStr, percentIndicator(percentStr)];
    }

    function collectArgs(/* args */) {
        var i, l, args = [];
        for(i=0,l=arguments.length;i<l;i++)
            args.push(arguments[i]);
        return args;
    }

    var _BaseRow = (function() {
    function _BaseRow(global, collection, slot, domMarker) {
        // jshint validthis: true
        this.global = global;
        this.collection = collection;
        this.slot = slot;
        this.domMarker = domMarker;

        // override for <th> either in the row or by the collection
        // LabelsCollection does so.
        this.cellTag = 'td';
        // cell name => Cell instance
        this._cells = new Map();
        // cell name => Representation instance
        this._representations = new Map();

        // needed only for the headers to identify click events
        this._setLocationDataAttributes = false;
    }

    var _p = _BaseRow.prototype;

    Object.defineProperty(_p, 'cells', {
       get: function(){
           return this._cells;
        }
    });
    // This is used to control which fields of the collection are
    // displayed, handles dom element creation and deletion.
    // The collection calls this for all of its rows;
    _p.setCells = function(namesInOrder) {
        var namesSet = new Set(namesInOrder)
          , existing = Array.from(this._cells.keys())
          , i, l, name, last, cell, domNode
          , newCells = []
          ;

        // remove no longer needed cells
        for(i=0,l=existing.length;i<l;i++) {
            name = existing[i];
            if(namesSet.has(name))
                continue;
            cell = this._cells.get(name);
            this._cells.delete(name);
            dom.removeNode(cell.container);
            this.global.deleteCell(cell);
        }

        // create new additions
        for(i=0,l=namesInOrder.length;i<l;i++) {
            name = namesInOrder[i];
            if(!this._cells.has(name)) {
                cell = new Cell(
                    dom.createElement(this.cellTag, {'class': 'row_field-' + name.replace(' ', '_')})
                  , this._representations.get(name)
                );

                if(this._setLocationDataAttributes) {
                    cell.container.setAttribute('data-collection', this.collection.id);
                    cell.container.setAttribute('data-name', name);
                }
                this._cells.set(name, cell);
                this.global.setCell(cell);
                cell.render();
                newCells.push(cell);
            }
        }

        // insert cells in order. dom.insertAfter is smart enough
        // to not re-insert if the cell is already in the right place,
        // to keep the amount of dom-manipulations low. Though, the
        // DOM-engine could be doing this kind of optimization as well.
        last = null;
        for(i=0,l=namesInOrder.length;i<l;i++) {
            domNode = this._cells.get(namesInOrder[i]).container;
            dom.insertAfter(domNode, last || this.domMarker);
            last = domNode;
        }
        return newCells;
    };

    _p._getField = function(selector) {
        // NOTE how this injects the location information
        // for collection and row.
        var selector_ = (typeof selector === 'string')
                                    ? [this.collection, this, selector]
                                    : selector
            ;
        return this.global.getField(selector_);
    };

    _p._getFields = function(selectors) {
        return selectors.map(this._getField, this);
    };

    _p._initField = function(name, definition) {
        var valueFunc = definition[definition.length-1]
          , dependencies = this._getFields(definition.slice(0, -1))
          , selector = [this.collection, this, name]
          ;
        this.global.initField(selector, dependencies, valueFunc);
    };

    _p._initRepresentation = function(name, definition) {
        var renderFunc = definition[definition.length-1]
          , dependencies = this._getFields(definition.slice(0, -1))
          ;
        this._representations.set(name,
                            new Representation(dependencies, renderFunc));
    };

    _p._initFields = function(definitions) {
        for(var name in definitions)
            this._initField(name, definitions[name]);
    };

    _p._initRepresentations = function(definitions) {
        for(var name in definitions)
            this._initRepresentation(name, definitions[name]);
    };
    return _BaseRow;
    })()

  , DataRow = (function() {

    // highly specialized: better place? document?
    function getOriginValue() {
        //jshint validthis: true
        // thisval is a instance of  `Field`
        return this.row.getOriginData(this.name);
    }
    // new Field(collection, this, name, [], getOriginValue);

    function DataRow(global, collection, slot, domMarker) {
        _BaseRow.call(this, global, collection, slot, domMarker);

        this._data = {
            collectiontest: null
          , familytest: null
        };

        var showPercentagesSelector = [null, null, 'show-percentages'];
        function percentagesSort(showPercentages, ratio, absolute) {
            return showPercentages ? ratio : absolute;
        }
        // make this configurable?
        // how to fill a field with content
        // always, if one dependency is null, the dependant is also
        // null. For the all passing case, this is inapplicable
        // unless there's a way to

        this._initFields({
                    // when it starts with data I'll look in here
                    // name.split('.') => go digging
            ERROR: ['hasResults', '*origin.familytest.results.ERROR', resultIdentity]
          , FAIL: ['hasResults', '*origin.familytest.results.FAIL', resultIdentity]
          , WARN: ['hasResults', '*origin.familytest.results.WARN', resultIdentity]
          , SKIP: ['hasResults', '*origin.familytest.results.SKIP', resultIdentity]
          , INFO: ['hasResults', '*origin.familytest.results.INFO', resultIdentity]
          , PASS: ['hasResults', '*origin.familytest.results.PASS', resultIdentity]
          , results: ['*origin.familytest.results', identity]
          , hasResults: ['results', function(results) {
                var key;
                if(!results)
                    return false;
                for(key in results)
                    // true if there is at least one key
                    return true;
                return false;
            }]
          , '#fonts': ['*origin.familytest.#fonts', identity]
          , reported: ['results', function(results) {
                return results === null ? null : arraySum(Object.values(results));
            }]
          , passing: ['results', function(results) {
                var failing = new Set(['ERROR', 'FAIL'])
                  , results_ = results || {}
                  , values = Object.keys(results_)
                      .filter(function(key){ return !failing.has(key); })
                      .map(function(key){ return this[key]; }, results_)
                  ;
                return values.length ? arraySum(values) : null;

            }]
          , progress: ['reported', 'total', ratio]
          , total: ['*origin.familytest.total', identity]
          // FAIL and total here are actually:
          // [this.collection, this, 'FAIL']
          // [this.collection, this, 'total']
          , 'ERROR-ratio': ['ERROR', 'total', ratio]
          , 'FAIL-ratio': ['FAIL', 'total', ratio]
          , 'WARN-ratio': ['WARN', 'total', ratio]
          , 'SKIP-ratio': ['SKIP', 'total', ratio]
          , 'INFO-ratio': ['INFO', 'total', ratio]
          , 'PASS-ratio': ['PASS', 'total', ratio]
          , 'passing-ratio': ['passing', 'total', ratio]
          , 'ERROR-sort': [showPercentagesSelector, 'ERROR-ratio', 'ERROR', percentagesSort]
          , 'FAIL-sort': [showPercentagesSelector, 'FAIL-ratio', 'FAIL', percentagesSort]
          , 'WARN-sort': [showPercentagesSelector, 'WARN-ratio', 'WARN', percentagesSort]
          , 'SKIP-sort': [showPercentagesSelector, 'SKIP-ratio', 'SKIP', percentagesSort]
          , 'INFO-sort': [showPercentagesSelector, 'INFO-ratio', 'INFO', percentagesSort]
          , 'PASS-sort': [showPercentagesSelector, 'PASS-ratio', 'FAIL', percentagesSort]
          , 'passing-sort': [showPercentagesSelector, 'passing-ratio', 'passing', percentagesSort]
          , slot: [function(slot){ return slot;}.bind(null, this.slot)]
        });

        function renderRatio(showPercentages, ratio, absolute) {
            var percentStr, major, minor;

            if(isNaN(ratio) || ratio === null || absolute === null)
                return null;

            percentStr = (Math.round(ratio * 10000)/100) + '%';
            major = showPercentages ? percentStr : absolute;
            minor = showPercentages ? absolute : percentStr;
                         // \xa0 == nbsp


            return [
                [major, '\xa0', '(' , minor , ')'].join('')
              , percentIndicator(percentStr)
            ];
        }

        function renderRatioAndLink(showPercentages, ratio, part, familytests_id) {
            var result = []
              , ratioRendered = renderRatio(showPercentages, ratio, part)
              , link
              ;
            if(ratioRendered !== null)
                Array.prototype.push.apply(result, ratioRendered);

            if(familytests_id !== null) {
                link = dom.createElement('a', {
                    href: 'report/' + encodeURIComponent(familytests_id)
                  , target: '_blank'
                  , title: 'Open font family report.'
                }, '🔗');
                if(result.length) result.unshift('\xa0');
                result.unshift(link);
            }

            return result.length ? result : null;
        }

        this._initRepresentations({
            'Font Family': ['slot', identity]
          , ERROR: [showPercentagesSelector, 'ERROR-ratio', 'ERROR', renderRatio]
          , FAIL: [showPercentagesSelector, 'FAIL-ratio', 'FAIL', '*origin.familytest.id', renderRatioAndLink]
          , WARN: [showPercentagesSelector, 'WARN-ratio', 'WARN', renderRatio]
          , SKIP: [showPercentagesSelector, 'SKIP-ratio', 'SKIP', renderRatio]
          , INFO: [showPercentagesSelector, 'INFO-ratio', 'INFO', renderRatio]
          , PASS: [showPercentagesSelector, 'PASS-ratio', 'PASS', renderRatio]
          , 'all passing': [showPercentagesSelector, 'passing-ratio', 'passing', renderRatio]
          , progress: [showPercentagesSelector, 'progress', 'reported', renderRatio]
          , total: ['total', identity]
          , '# fonts': ['#fonts', identity]
        });
    }
    var _p = DataRow.prototype = Object.create(_BaseRow.prototype);

    Object.defineProperties(_p, {
        collectiontest: {
            get: function(){return this._data.collectiontest;}
          , set: function(data){ this._data.collectiontest = data;}
        }
      , familytest: {
            get: function(){return this._data.familytest;}
          , set: function(data){ this._data.familytest = data;}
        }
    });

    _p.getOriginData = function(key) {
        var parts = key.split('.')
          , data = this._data
          , k
          ;
        if(parts[0] !== '*origin')
            throw new Error('key is expected to start with "*origin" '
                                          + 'but is: "' + key + '"');
        parts.reverse().pop();// remove 'data';
        while( (k = parts.pop()) !== undefined  ) {
            if(k in data) {
                data = data[k];
                if(data)
                    continue;
            }
            // if we can't find an entry, the result is null
            data = null;
            break;
        }
        return data;
    };

    _p._getField = function(selector) {
        // we don't explicitly define origin fields!
        // they are implicitly created in here.
        if(typeof selector === 'string' && selector.indexOf('*origin') === 0)
            this._initField(selector, [getOriginValue]);
        return _BaseRow.prototype._getField.call(this, selector);
    };

    return DataRow;
    })()


  , CollectionNamesRow = (function() {
    function CollectionNamesRow(global, collection, slot, domMarker) {
        _BaseRow.call(this, global, collection, slot, domMarker);
        this.cellTag = 'th';
        this._setLocationDataAttributes = true;
    }

    var _p = CollectionNamesRow.prototype = Object.create(_BaseRow.prototype);


    _p._renderCollectionidCell = function() {
        var link = dom.createElement('a', {
                href: 'collection-report/' + encodeURIComponent(this.collection.id)
              , target: '_blank'
              , title: 'Open collection report.'
            }, '🔗');

        link.addEventListener('click', function(event){
            event.stopPropagation();
        });

        return [this.collection.id, '\xa0', link];
    };

    _p.setCells = function(namesInOrder) {
        var name =  'collectionid'
          , cell = this._cells.get(name)
          , newCells = []
          ;
        if(!cell) {
            if(!this._representations.has(name))
                this._initRepresentation(name, [this._renderCollectionidCell.bind(this)]);
            cell = new Cell(
                    dom.createElement(this.cellTag, {'class': 'row_field-' +  name.replace(' ', '_')})
                  , this._representations.get(name)
                );
            if(this._setLocationDataAttributes) {
                cell.container.setAttribute('data-collection', this.collection.id);
                // unused: cell.container.setAttribute('data-name', name);
            }
            this._cells.set(name, cell);
            this.global.setCell(cell);
            cell.render();
            newCells.push(cell);
        }
        cell.container.setAttribute('colspan', namesInOrder.length);
        dom.insertAfter( cell.container, this.domMarker);
        return newCells;
    };

    return CollectionNamesRow;
    })()


  , ColumnNamesRow = (function() {
    function ColumnNamesRow(global, collection, slot, domMarker) {
        _BaseRow.call(this, global, collection, slot, domMarker);
        this.cellTag = 'th';
        this._setLocationDataAttributes = true;
    }

    var _p = ColumnNamesRow.prototype = Object.create(_BaseRow.prototype);

    _p.setCells = function(namesInOrder) {
        // create fields/representations on demand!
        var i, l , name;

        function noBreakingSpaces(val) {
            if(val === null)
                return null;
            return (val + '').replace(/ /g, '\xa0');
        }

        for(i=0,l=namesInOrder.length;i<l;i++) {
            name = namesInOrder[i];
            if(!this._representations.has(name))
                this._initRepresentation(name, [noBreakingSpaces.bind(null, name)]);
        }
        return _BaseRow.prototype.setCells.call(this, namesInOrder);
    };

    return ColumnNamesRow;
    })()

  , SummaryRow = (function() {
    function SummaryRow(global, collection, slot, domMarker) {
        _BaseRow.call(this, global, collection, slot, domMarker);

         // don't call these field like their conterparts in the
         // data-rows, or a '*' selector for rows will also include
         // the fields of this row.

        function average(values) {
            var values_ = values || []
              , vals = values_.filter(function(value) {
                    return value !== null;
                })
              , sum = arraySum(vals)
              , result = sum / vals.length
              ;
            return vals.length ? result : null;
        }

         this._initFields({
            'total-ERROR-ratio': [[this.collection, '*', 'ERROR-ratio'], average]
          , 'total-FAIL-ratio': [[this.collection, '*', 'FAIL-ratio'], average]
          , 'total-WARN-ratio': [[this.collection, '*', 'WARN-ratio'], average]
          , 'total-SKIP-ratio': [[this.collection, '*', 'SKIP-ratio'], average]
          , 'total-INFO-ratio': [[this.collection, '*', 'INFO-ratio'], average]
          , 'total-PASS-ratio': [[this.collection, '*', 'PASS-ratio'], average]
          , 'total-passing-ratio': [[this.collection, '*', 'passing-ratio'], average]
          , '# total-fonts': [[this.collection, '*', '#fonts'], arraySum]
          , '# total-tests': [[this.collection, '*', 'total'], arraySum]
          , 'total-progress': [[this.collection, '*', 'progress'], average]

        });

        this._initRepresentations({
            'ERROR': ['total-ERROR-ratio', percent]
          , 'FAIL': ['total-FAIL-ratio', percent]
          , 'WARN': ['total-WARN-ratio', percent]
          , 'SKIP': ['total-SKIP-ratio', percent]
          , 'INFO': ['total-INFO-ratio', percent]
          , 'PASS': ['total-PASS-ratio', percent]
          , 'all passing': ['total-passing-ratio', percent]
          , '# fonts': ['# total-fonts', identity]
          , 'total': ['# total-tests', identity]
          , 'Font Family': [function(){ return 'Summaries'; }]
          , 'progress': ['total-progress', percent]
        });
    }

    SummaryRow.prototype = Object.create(_BaseRow.prototype);

    return SummaryRow;
    })()

  , Representation = (function() {
    function Representation(dependencies, renderFunc) {
        Object.defineProperty(this, 'dependencies', {value: dependencies});
        this._renderFunc = renderFunc;
    }

    var _p = Representation.prototype;
    _p.render = function(cell) {
        var args = this.dependencies.map(function(d){ return d.value; });
        return this._renderFunc.apply(cell, args);
    };
    return Representation;
    })()


  , Cell = (function() {
    function Cell(container, representation) {
        Object.defineProperty(this, 'container', {value: container});
        this._representation = representation;
    }

    var _p = Cell.prototype;

    _p.render = function() {
        var content;
        dom.clear(this.container);

        if(!this._representation)
            return;
        content = this._representation.render(this);
        if(content === null)
            content = '—'; // 'N/A';
        dom.appendChildren(this.container, content);
    };

    Object.defineProperty(_p, 'dependencies', {
       get: function(){
            return this._representation
                    ? this._representation.dependencies
                    : []
                    ;
        }
      , enumerable: true
    });

    return Cell;
    })()


  , _BaseCollection = (function() {
    function _BaseCollection(global, id) {
        // jshint validthis:true
        this.global = global;
        this.id = id;
        this.rowMarkerStr = 'collection: ' + id;
        this._rows = new Map(); // slotValue => row
    }

    var _p = _BaseCollection.prototype;

    // return true if this changed anything and needs update
    _p.toggleExpand = function() {
        return false;
    };

    _p.setRow = function(slot, row) {
        this._rows.set(slot, row);
    };

    _p.getRow = function(slot) {
        return this._rows.get(slot);
    };

    _p.getSortField = function(cellName) {
        // jshint unused: vars
        // IMPORTANT: the rows must define this field
        throw new Error('Not Implemented!');
    };

    _p.setCells = function(slot) {
        // jshint unused:vars
        throw new Error('Not Implemented');
        //rows.forEach(function(row) {
        //    // jshint unused:vars
        //    row.setCells(fieldsInOrder);
        //});
    };

    return _BaseCollection;
    })()


  , Collection = (function() {
    function Collection(global, id) {
        _BaseCollection.call(this, global, id);
        this._cellName2SortField = {
            slot: 'slot'
          , ERROR: 'ERROR-sort'
          , FAIL: 'FAIL-sort'
          , WARN: 'WARN-sort'
          , SKIP: 'SKIP-sort'
          , INFO: 'INFO-sort'
          , PASS: 'PASS-sort'
          , 'all passing': 'passing-sort'
          , '# fonts': '#fonts'
          , total: 'total'
          , progress: 'progress'
        };

        // TODO: if there's at least one ERROR in the collection
        // add the error field [this, *, error].length ? || sumAll != 0
        // otherwise, the error column should not be used, as ERROR
        // will be very uncommon eventually. It has a very deep red color
        // so, showing it only when something is really wrong makes it
        // really stand out. Could also be an "optional" in the reduced
        // fields
                // make a mechanism for an on-demand-field
        // depending on the value of one or more fields
        // (that must be updated when needed watched)
        // so, that "cells" render() would probably have to call setCells()
        // and then this._update(undefined, newCells);
        // thus, the change action can't happen within this._update, but
        // must be scheduled after OR be included.
        // a field could be like:

        this._blacklistedFields = new Set(['ERROR']);
        this._fieldOrders = {
            reduced:  ['ERROR', 'FAIL', 'progress']
          , expanded: ['ERROR', 'FAIL', 'WARN', 'SKIP', 'INFO', 'PASS'
                     , 'all passing', 'progress', 'total', '# fonts']
        };
        this._expanded = false;
        this._fieldsInOrder = null;
        this._setFieldsInOrder();
        this._initNotifications();
    }

    var _p = Collection.prototype = Object.create(_BaseCollection.prototype);

    function sumHasAny(values){ return !!arraySum(values);}

    _p._initNotifications = function() {
        // right now: only has-ERRORS
        // that's the field:
        var selectorAllErrors = [this, '*', 'ERROR']
          , selectorHasErrors = [this, null, 'has-ERRORS']
          ,  hasErrorsField = this.global.initField(
                  selectorHasErrors
                  //dependenc(y)ies
                  // could also reference the summary row field
                  // total-ERROR. On the other hand, both have this
                  // field defined
                , [this.global.getField(selectorAllErrors)]
                , sumHasAny
            )
          , repr = new Representation(
                  [hasErrorsField]
                , this._hasErrorChanged.bind(this)
            );
        this.global.setListener(repr);
    };

    _p.getSortField = function(cellName) {
        if(cellName in this._cellName2SortField)
            return this._cellName2SortField[cellName];
        return null;
    };

    Object.defineProperty(_p, 'isExpanded', {
        get: function() {
            return this._expanded;
        }
      , enumerable: true
    });

    Object.defineProperty(_p, 'defaultSortColumnName', {
        get: function() {
            return this._fieldsInOrder.length
                                        ? this._fieldsInOrder[0]
                                        : null
                                        ;
        }
      , enumerable: true
    });

    _p._setFieldsInOrder = function() {
        var old = this._fieldsInOrder
          , key = this._expanded ? 'expanded' : 'reduced'
          ;

        this._fieldsInOrder = this._fieldOrders[key]
                                  .filter(this._isAllowedField, this);
        return !isEqual(old, this._fieldsInOrder);
    };

    _p.toggleExpand = function() {
        this._expanded = !this._expanded;
        return this._setFieldsInOrder();
    };

    _p.hasCell = function(cellName) {
        return this._fieldsInOrder.indexOf(cellName) !== -1;
    };

    _p._hasErrorChanged = function(displayError) {
        var size = this._blacklistedFields.size;

        if(displayError)
            this._blacklistedFields.delete('ERROR');
        else
            this._blacklistedFields.add('ERROR');

        if(size === this._blacklistedFields.size)
            // no change
            return;

        if(this._setFieldsInOrder())
            this.setCells();
    };

    _p._isAllowedField = function(field) {
        return !this._blacklistedFields.has(field);
    };

    // after this, we must also update the fields contents
    // as some may be new/empty
    // this depends on `_initCollectionRow` as that inserts the
    // domMarker of the row into the DOM
    _p.setCells = function(slot) {
            // all rows if row is undefined
        var rows = slot ? [this.getRow(slot)] : this._rows
          , newCells = []
          ;
        rows.forEach(function(row) {
            // jshint validthis:true
            Array.prototype.push.apply(newCells
                                    , row.setCells(this._fieldsInOrder));
        }, this);
        return newCells;
    };

    return Collection;
    })()

  , LabelsCollection = (function(){
    function LabelsCollection(global, id) {
        _BaseCollection.call(this, global, id);
        // IMPORTANT: the rows must define this field
        // FIXME: make a central field definiton for data fields
        // hardcoding this will not suffice.
        this._cellName2SortField = {
            'Font Family': 'slot'
        };
    }
    var _p = LabelsCollection.prototype = Object.create(_BaseCollection.prototype);

    _p.getSortField = function(cellName) {
        if(cellName in this._cellName2SortField)
            return this._cellName2SortField[cellName];
        return null;
    };

    _p.setRow = function(slot, row) {
        row.cellTag = 'th';
        _BaseCollection.prototype.setRow.call(this, slot, row);
    };

    _p.setCells = function(slot) {
        var fieldsInOrder = ['Font Family']
          , rows = slot ? [this.getRow(slot)] : this._rows
          , newCells = []
          ;
        rows.forEach(function(row) {
            Array.prototype.push.apply(newCells, row.setCells(fieldsInOrder));
        });
        return newCells;
    };


    return LabelsCollection;
    })()

  , Field = (function() {


    // IMPORTANT: see DashboardController.fieldFactory
    // which defines the `value` getter of the field
    function Field(selector, dependencies, valueFunc) {
        this.collection = selector[0];
        this.row = selector[1];
        this.name = selector[2];
        this.selector = selector;
        this.hasBeenEvaluated = false;

        var depsDescriptor = {enumerable: true};
        if(typeof dependencies !== 'function')
            depsDescriptor.value = dependencies;
        else
            depsDescriptor.get = dependencies.bind(this);
        Object.defineProperty(this, 'dependencies', depsDescriptor);

        //this.dependencies = dependencies;
        this._valueFunc = valueFunc;
    }

    var _p = Field.prototype;

    // We do pre-initialization of fields without actually running the
    // constructor to make it possible to pre-fill the this.dependencies
    // array with the correct instances.
    _p._valueFunc = function() {
        console.error('evaluating  uninitialzied field', this);
        throw new Error('Not Implemented');
    };

    /**
     * evaluate is called when change on any dependency was detected
     * the dependencies are not re-evaluated at this point, the cached
     * value is used.
     */
    _p.evaluate = function() {
        var deps = this.dependencies || []
          , args=deps.map(function(d){ return d.value; })
          ;
        this.hasBeenEvaluated = true;
        return this._valueFunc.apply(this, args);
    };

    return Field;
    })()


  , Global = (function(){
    function Global() {
        this._fields = new Map();

        Object.defineProperties(this, {
            valuesCache: {
                value: new Map()
              , enumerable: true
            }
          , activeCells: {
                value: new Set()
              , enumerable: true
            }
            // listeners have the same interface as cells and representations:
            // a getter: `dependencies` returns an array of Fields
            // a method: render()
          , listeners: {
                value: new Set()
              , enumerable: true
            }
        });
    }
    _p = Global.prototype;

    function getKey(selector) {
        var collection = selector[0]
          , row = selector[1]
          , name = selector[2]
          , c = collection === null ? '*null' : collection.id
          , r = row === null ? '*null' : row.slot
          ;
        return [c, r, name].join(':::');
    }

    _p.selectAll = function(selector) {
        var result = [];
        this._fields.forEach(function(field) {
            if(singleSelect(selector, field))
                result.push(field);
        });

        return result;

    };

    _p.hasRegisteredField = function(selector) {
        var key = getKey(selector);
        return this._fields.has(key);
    };

    _p.getRegisteredField = function(selector) {
        var key = getKey(selector)
          , field = this._fields.get(key)
          ;
        if(!field) {
            field = Object.create(Field.prototype);

            field.key = key; // FIXME: only for debugging, should not be needed later
            this._fields.set(key, field);
        }
        return field;
    };

    _p._initField = function(field, selector, dependencies, valueFunc) {
        if(field.hasOwnProperty('value'))
            // has already been initialized
            return;
        Object.defineProperty(field, 'value', {
            get: this.valuesCache.get.bind(this.valuesCache, field)
        });
        Field.call(field, selector, dependencies, valueFunc);
    };

    _p.initField = function(selector, dependencies, valueFunc) {
        var field = this.getRegisteredField(selector);
        this._initField(field, selector, dependencies, valueFunc);
        return field;
    };

    _p.getField = function(selector) {
        var dependencies;
        // Collection fields:
        // Lija a [this.collection, '*', 'FAIL-ratio']
        // description, but: the asterisk could be used in all of
        // the selector fields. We need to init the field in here
        // because it is not a directly named field anywhere (can't
        // be, because directly named fields are not capable of bearing
        // a custom selector, just a name.
        if(selector.indexOf('*') !== -1) {
            // dependencies are collected dynamically, so this is
            // more expensive than the pre-collected dependencies
            // of normal fields.
            dependencies = this.selectAll.bind(this, selector);
                // ends like: new Field(collection, row, name, dependencies, valueFunc);
            this.initField(selector, dependencies, collectArgs);
        }
        return this.getRegisteredField(selector);
    };

    _p.setCell = function(cell){
        this.activeCells.add(cell);
    };

    _p.deleteCell = function(cell){
        this.activeCells.delete(cell);
    };

    _p.setListener = function(representation) {
        this.listeners.add(representation);
    };

    return Global;

    })()
      ;

    function DashboardController(container, templatesContainer, data) {
        // jshint unused:vars
        this.container = container;
        this._slotKey = 'family_name';
        // we never delete this during runtime, even though it
        // some familytests might outdate during runtime and may never
        // be accessed again, because we don't know, and we expect runtime
        // not to be "forever", just a session of a user
        this._familytests = new Map(); // familytests_id => familytest.data

        this._familytest2collectiontests = new Map(); // familytests_id => Set(collection_id)

        this._collections = new Map(); // collection_id => collection

        // order will be detemined differently
        this._rowElements = {}; // type: Map(slot => rowElements)

        this._global = new Global();

        this._collectionOrder = [
              'GoogleFontsAPI/production'
            //, 'GoogleFontsAPI/sandbox'
            , 'GitHub-GoogleFonts/master'
            , 'GitHub-GoogleFonts/pulls'
            , 'CSVSpreadsheet/upstream'
            , 'fontnames' // TODO: make sure this is always the first column!
        ];
        this._collectionTypes = {
            fontnames: LabelsCollection
        };

        this._updateWaitingSelectors = [];
        this._updateBreak = null;
        this._updateWaiting = true; // initially true

        this._reorderRowsScheduling = null;
        this._sortField = null;
        this._sortCollection = null;
        this._sortColumnName = 'Font Family';
        this._sortReversed = false;

        this._thead = dom.createElement('thead', []);
        this._tbody = dom.createElement('tbody', []);
        this._tfoot = dom.createElement('tfoot', []);

        this._table = dom.createElement('table', {class: 'dashboard-table'}
                                , [this._thead, this._tbody, this._tfoot]);
        dom.insertAtMarkerComment(this.container, 'insert: dashboard'
                                                            , this._table);
        this._collectionOrder.forEach(this._initCollection.bind(this));

        this._showPercentages = true;
        var showPercentagesButton = this._initTogglePercentages();
        dom.insertAtMarkerComment(this.container, 'insert: toggle-percentages'
                                                , showPercentagesButton);

        // sort by slot name initially!
        this._tBodySlotOrder = [];
        this._sortCollection = this._collections.get('fontnames');
        // falls back to the default secondary sort value, which is
        // 'slot'
        this._sortField = this._sortCollection.getSortField(this._sortColumnName);

        this._slotTypes = {
            collectionNames: [this._thead, CollectionNamesRow]
          , columnNames: [this._thead, ColumnNamesRow]
          , data: [this._tbody, DataRow]
          , summary: [this._tfoot, SummaryRow]
        };
        this._initSlot('collectionNames', 'collection-names'
                            , ['click', this._collectionExpandHandler]);
        this._initSlot('columnNames', 'column-names'
                            , ['click', this._slotOrderChangeHandler]);
        this._initSlot('summary', 'column-summary');

        this._updateSortIndicators();
    }

    var _p = DashboardController.prototype;

    Object.defineProperty(_p, '_dataRowElements', {
        get: function(){ return this._rowElements.data; }
      , enumerable: true
    });

    _p._initTogglePercentages = function() {
        // right now: only has-ERRORS
        // that's the field:
        var button = dom.createElement('button')
          , selectorShowPercentages = [null, null, 'show-percentages']
          , showPercentagesField = this._global.initField(
                  selectorShowPercentages
                , []
                , function(){ return this._showPercentages; }.bind(this)
            )
          , repr = new Representation(
                  [showPercentagesField]
                , function(showPercentages) {
                        button.textContent = showPercentages
                                ? 'Show Absolute Numbers'
                                : 'Show Percentages'
                                ;
                }
            )
          ;
        repr.render();
        button.addEventListener('click', function() {
            this._showPercentages = !this._showPercentages;
            this._update(true, [selectorShowPercentages]);
        }.bind(this));
        this._global.setCell(repr);
        return button;
    };

    _p._updateSortIndicators = function() {
        function markCell(collection, cell, name) {
            //jshint validthis:true
            var action = (collection === this._sortCollection
                                    && name === this._sortColumnName)
                        ? 'add'
                        : 'remove'
                        ;
            cell.container.classList[action]('sort-active');
        }

        function markCells(collection) {
            //jshint validthis:true
            var row = collection.getRow('column-names');
            row.cells.forEach(markCell.bind(this, collection));
        }

        this._collections.forEach(markCells, this);

        var rowElement = this._rowElements.columnNames.get('column-names');
        rowElement.classList[this._sortReversed ? 'remove' : 'add']('sort-asc');
        rowElement.classList[this._sortReversed ? 'add' : 'remove']('sort-desc');
    };

    function singleSelect(selector, field) {
        var collection = selector[0]
          , row = selector[1]
          , name = selector[2]
          ;

        // the field itself is a "collection field"
        if(field.collection === '*' || field.row === '*' || field.name === '*')
            // Don't allow it for now to select fields that represent
            // collections of fields. It's easier to implement and this
            // would make it very easy to do recursvive selecting etc.
            // and we don't need that kind of thing right now anyways.
            return false;

        // collection AND/OR row are possibly null
        // meaning that the field is outside of either
        return (
                (collection === '*' || collection === field.collection)
             && (row === '*' || row === field.row)
             && (name === '*' || name === field.name)
            );
    }
    function selects(selectors, field) {
        for(var i=0,l=selectors.length;i<l;i++)
            if(singleSelect(selectors[i], field))
                return true;
        return false;
    }

    // also re-sets the cache!
    _p._reEvaluate = function (field) {
        var changed = true
          , oldVal
          , newVal = field.evaluate() // <= not cached in field
          ;
        if(this._global.valuesCache.has(field)) {
            oldVal = this._global.valuesCache.get(field);
            // can only not-change if a value was cached before
            changed = !isEqual(newVal, oldVal);
        }

        if(changed)
            this._global.valuesCache.set(field, newVal);

        return changed;
    };


    // changedSelector = [ [collection, row, '*'], ... ]
    _p._update = function(now, changedSelectors, checkCells) {
    // FIXME: this is a mess, sorry!

        if(changedSelectors)
            Array.prototype.push.apply(this._updateWaitingSelectors, changedSelectors);
        var update = (function() {
            //jshint validthis: true
            this._updateBreak = null;
            if(this._updateWaiting || this._updateWaitingSelectors.length) {
                this.__update(this._updateWaitingSelectors);
                this._updateBreak = setTimeout(update, 200);
            }
            this._updateWaitingSelectors = [];
            this._updateWaiting = false;
        }).bind(this);

        if(now || checkCells) {
            // force into sync execution
            // check cells is enough if this is a check cells call and
            // no this._updateBreak has been scheduled
            if(!checkCells || this._updateWaiting || this._updateWaitingSelectors.length) {
                clearTimeout(this._updateBreak);
                this._updateWaiting = true;
                update();
            }

            if(checkCells)
                this.__update(null, checkCells);
            return;
        }

        this._updateWaiting = true;
        if(!this._updateBreak)
            update();
    };

    _p.__update = function(changedSelectors, checkCells) {
        // traverse the dependency graph depth first
        // and update cells if needed
        function visit(subject) {
            var i,l,field, dependencies
              , hasChanged = false
              ;
            //jshint validthis:true
            if(this.visited.has(subject))
                    // we have seen this before, state is stored
                return this.changed.has(subject);

            if(this.visiting.has(subject))
                throw new Error('recursion in "' + subject.key + '" '
                            + 'currently visiting: '
                            + Array.from(this.visiting)
                                   .map(function(field){ return field.key;})
                                   .join(', '));
            this.visiting.add(subject);

            dependencies = subject.dependencies;
            // has no dependencies => may be an origin field
            // also, all change originates from fields like this.
            var needsReEvaluate = (
                           !subject.hasBeenEvaluated
                        || (!dependencies.length
                            // maybe we can remove this optimization
                            // pulling these values shouldn't be so
                            // expensive and running `selects` is also
                            // not for free.
                            && changedSelectors
                            && selects(changedSelectors, subject)
                        )
                    );

            // has dependencies
            for(i=0,l=dependencies.length;i<l;i++){
                field = dependencies[i];
                this.visit(field);
                if(this.changed.has(field))
                    needsReEvaluate = true;
            }

            if(needsReEvaluate && this.reEvaluate(subject)){
                this.changed.add(subject);
                hasChanged = true;
            }

            this.visiting.delete(subject);
            this.visited.add(subject);
            return hasChanged;
        }

        function or (a, b){ return a || b; }

        var state = {
                  visited: new Set()
                , visiting: new Set() // detect recursion
                , changed: new Set()
                , visit: visit
                , reEvaluate: this._reEvaluate.bind(this)
                , visitAll: function visitAll(fields) {
                    return fields.map(this.visit, this)
                        // returns true if at least one field has changed
                        .reduce(or, false)
                        ;
                }
                , check: function(representation) {
                    var changed = this.visitAll(representation.dependencies);
                    if(changed)
                        representation.render();
                    return changed;
                }
            }
          , cells
          ;

        if(checkCells)
            // checkCells is used when new cells is added, but no data
            // was changed. I.E. when a collection was expanded
            cells = checkCells;
        else if(changedSelectors && changedSelectors.length) {
            // these listeners can change this._global.activeCells
            this._global.listeners.forEach(state.check, state);
            cells = this._global.activeCells;
        }

        if(cells)
            cells.forEach(state.check, state);

        // if(checkCells) ? => if checkCells is set, this shouldn't change
        // at all, so why run it?
        var sortDependencies = this._global.selectAll(
                            [this._sortCollection, '*', this._sortField]);
        if(state.visitAll(sortDependencies))
            // since we do cell.render in here, to schedule a reorder
            // seem OK here too. BUT: if _sortCollection or _sortField
            // itself changed, but not the field values, we still need to
            // _scheduleReorderRows but outside of this function.
            // good thing that _scheduleReorderRows is timeout throttled.
            this._scheduleReorderRows();
    };

    _p._initCollection = function(collectionId) {
        var collection
          , CollectionCtor = this._collectionTypes[collectionId] || Collection
          ;
        if(this._collections.has(collectionId))
            throw new Error('Collection "'+collectionId+'" already exists.');

        if(this._collectionOrder.indexOf(collectionId) === -1)
            this._collectionOrder.push(collectionId);

        // init collection
        collection = new CollectionCtor(this._global, collectionId);
        this._collections.set(collectionId, collection);

        function init(type, rowElement, slot) {
            //jshint unused:vars, validthis:true
            // NOTE: initialy there are now rows at all
            // BUT! the thead will eventually have lables for each collection!
            // and the columns
            // so that head must be build here.
            this._initCollectionRow(collection, type, slot);
        }
        for(var type in this._rowElements)
            this._rowElements[type].forEach(init.bind(this, type));
        collection.setCells(/*all*/);
        return collection;
    };

    _p._rowFabric = function(collection, type, slot) {
        var domMarker = dom.createComment(collection.rowMarkerStr)
          , Row = this._slotTypes[type][1]
          , row = new Row(this._global, collection, slot, domMarker)
          ;
        collection.setRow(slot, row);
        return row;
    };

    _p._collectionExpandHandler = function(rowElement, event) {
        var collectionId = dom.validateChildEvent(event, rowElement
                                                , 'data-collection');
        if(!collectionId)
            return;
        this._toggleCollectionExpand(collectionId);
    };

    _p._toggleCollectionExpand = function(collectionId) {
        var collection = this._collections.get(collectionId)
          , newCells
          ;
        // collection.isExpanded can be used to set a css
        // class to the row-cell that toggles this
        if(collection.toggleExpand()) {
            newCells = collection.setCells();
            // if(collection === this._sortCollection
            //                 && !collection.hasCell(this._sortColumnName))
            //     this._setSortCollumn(collectionId, collection.defaultSortColumnName);
            // instead of changing the current sorting, keeping it may
            // be a useful feature:
            this._updateSortIndicators();
            // I dislike that I need an selector for this!
            this._update(true, undefined, newCells);
        }

        var action = collection.isExpanded ? 'add' : 'remove';
        collection.getRow('collection-names')
            .cells.forEach(function(cell){
                cell.container.classList[action]('collection-expanded');
            })
            ;
    };

    _p._slotOrderChangeHandler = function(rowElement, event) {
        var collectionKey = 'data-collection'
          , nameKey = 'data-name'
          , results = dom.validateChildEvent(event, rowElement
                                            , collectionKey, nameKey)
          , collectionId, name
          ;
        if(!results) return;

        collectionId = results[collectionKey];
        name = results[nameKey];

        this._setSortCollumn(collectionId, name);
    };


    _p._scheduleReorderRows = function(now) {
        if(now) {
            clearTimeout(this._reorderRowsScheduling);
            this._reorderRows();
        }
        else if(!this._reorderRowsScheduling)
            this._reorderRowsScheduling = setTimeout(this._reorderRows.bind(this));
    };

    _p._setSortCollumn = function(collectionId, columnName) {
        var newCollection = this._collections.get(collectionId)
          , newSortField = newCollection.getSortField(columnName)
          ;
        if(newSortField === null)
            // this is not a sortable column
            return;

        this._sortColumnName = columnName;

        if(newCollection === this._sortCollection
                                && newSortField === this._sortField) {
            // setting the same collumn toggles reverse sorting
            this._sortReversed = !this._sortReversed;
        }
        else {
            this._sortCollection = newCollection;
            this._sortField = newSortField;
        }

        this._updateSortIndicators();
        // we may need to evaluate the sort fields
        this._update(true);
        // _update schedules this only if the field values have actually
        // changed
        this._scheduleReorderRows(true);
    };

    _p._getFieldValue = function(collection, slot, name) {
        // hmm, these fields need to be freshly evaluated at this point
        // which means:
        //      a) _update must visit these fields
        //      b) _update must run before this (but _update triggers
        //         re-ordering so I think we are good here);
        var row = collection.getRow(slot)
          , value
          , selector = [collection, row, name]
          ;
        if(!this._global.hasRegisteredField(selector))
            throw new Error('Missing field: ['
                        + [collection.id,  slot, name].join(',') + ']');

        value = this._global.getRegisteredField([collection, row, name]).value;
        if(value === undefined)
            value = null;
        return value;
    };

    _p._getSlotSortItem = function(slot) {
          var primarySortValue =  this._sortCollection && this._sortField
                ? this._getFieldValue(this._sortCollection, slot, this._sortField)
                : null
          ;
        return [primarySortValue, slot];
    };

    _p._insertRowAtRightPosition = function(type, slot, rowElement) {
        var parent = this._slotTypes[type][0]
          , sortItem, target, referenceSlot, referenceElement, orderIndex
          ;

        if(parent !== this._tbody) {
            parent.appendChild(rowElement);
            return;
        }

        // Is getting values from the row ready yet?
        // rather not! but probably, an update that triggered an insert
        // will also have to trigger an reordering.
        // But that also means that this effort is maybe not so important,
        // because its not seen at all...?
        sortItem = this._getSlotSortItem(slot);

        if(!this._tBodySlotOrder.length) {
            target = {index: 0, pos: 'prepend'};
            referenceElement = this._tbody;
            orderIndex = 0;
        }
        else {
            target = binInsert(sortItem, this._tBodySlotOrder
                    , this._sortReversed ? compare_reversed : compare);
            referenceSlot = this._tBodySlotOrder[target.index].slice(-1)[0];
            referenceElement = this._dataRowElements.get(referenceSlot);
            orderIndex = target.index + (target.pos === 'after' ? 1 : 0);
        }

        this._tBodySlotOrder.splice(orderIndex, 0, sortItem);
        dom.insert(referenceElement, target.pos, rowElement);
    };

    _p._getSortSlots = function() {
        var slotSortItems = [];

        this._dataRowElements.forEach(function(rowElement, slot) {
            // jshint: validthis:true
            // must be siblings in this._tbody
            // but this._dataRowElements implies that
            // if(rowElement.parentElement !== this._tbody)
            // return;
            slotSortItems.push(this._getSlotSortItem(slot));
        }.bind(this));
        return slotSortItems;
    };

    function compare(a, b, reverseNull, reversedCompareIndexes) {
        var i, l, reversed;
        // we'll always feed same length a and b arrays
        for(i=0,l=a.length;i<l;i++) {
            if(a[i] === b[i]) continue;

            // Put null at the bottom.
            // this are slots that are not filled by the current
            // collection so instead of having to scroll past them,
            // we put them directly the bottom.
            if(a[i] === null) return reverseNull ? -1 :  1;
            if(b[i] === null) return reverseNull ?  1 : -1;

            // we use this currently for i===1 (slot name) in compare_reversed
            // because, we want to have the null values of i===0
            // sorted in descending alphabetical order again.
            // This depends on _getSlotSortItem
            reversed = reversedCompareIndexes && reversedCompareIndexes.has(i);

            if(a[i] < b[i]) return reversed ?  1 : -1;
            if(a[i] > b[i]) return reversed ? -1 : 1;
        }
        return 0;
    }

    function compare_reversed (a, b) {
        return -compare(a, b, true, new Set([1]));
    }

    _p._reorderRows = function() {
        var slotOrder = this._getSortSlots(this._sortCollection, this._sortField)
                        .sort(this._sortReversed ? compare_reversed : compare)
          , last = null
          , i, l, slot, domNode
          ;
        last = null;
        for(i=0,l=slotOrder.length;i<l;i++) {
            // last item
            slot = slotOrder[i].slice(-1)[0];
            domNode = this._dataRowElements.get(slot);
            if(!last)
                dom.insert(this._tbody, 'prepend', domNode);
            else
                dom.insert(last, 'after', domNode);
            last = domNode;
        }
        this._tBodySlotOrder = slotOrder;
        this._reorderRowsScheduling = null;
    };

    // must run when a new collection is added
    // AND when a new slot is added!
    _p._initCollectionRow = function(collection, type, slot) {
        // insert the marker comment at the right position.
        var row = collection.getRow(slot)
          , rowElement = this._rowElements[type].get(slot, rowElement)
          ;
        if(!row)
            row = this._rowFabric(collection, type, slot);
        // TODO: insert it "at the right position" => either we give
        // collections a weight via the backend or we hardcode it into
        // the frontend ... (it's in the frontend now, but not applied
        // see _collectionOrder
        dom.insert(rowElement, 'prepend', row.domMarker);

        // TODO: markers are in place: fill with new empty <td>s for
        // the collection, See: collection.setCells(fieldsInOrder)
        // where is "fieldsInOrder" coming from?
    };

    _p._initSlot = function(type, slot, eventDescription) {
        if(!(type in this._rowElements))
            this._rowElements[type] = new Map();

        if(this._rowElements[type].has(slot))
            throw new Error('Slot "' + slot + '" already exists.');

        var rowElement = dom.createElement('tr', {class: 'slot_' + slot});
        if(eventDescription)
            rowElement.addEventListener(eventDescription[0],
                            eventDescription[1].bind(this, rowElement));
        this._rowElements[type].set(slot, rowElement);

        this._collections.forEach(function(collection) {
            // creates a row instance for each collection
            this._rowFabric(collection, type, slot);
        }.bind(this));

        this._insertRowAtRightPosition(type, slot, rowElement);

        // insert the domMarker comments in order and ad the td's
        this._collectionOrder.forEach(function(collectionId) {
            // jshint validthis:true
            var collection = this._collections.get(collectionId);
            this._initCollectionRow(collection, type, slot);
            collection.setCells(slot);
        }.bind(this));
    };

    _p.onChange = function(data) {
        console.log('received', data.type, data);
        var func;
        // data.type = collectiontest || familytest
        switch(data.type) {
            case('collectiontest'):
                func = this._changeCollectiontest;
            break;
            case('familytest'):
                func = this._changeFamilytest;
            break;
            default:
                throw new Error('Unknown data.type: "' + data.type + '".');
        }
        func.call(this, data);
    };

    _p._changeFamilytest = function(data) {
        // data.type === 'familytest'
        var changedRows = new Set()
          // , old = this._familytests.get(data.id)
          ;

        this._familytests.set(data.id, data);

        if(!this._familytest2collectiontests.has(data.id))
            this._familytest2collectiontests.set(data.id, new Set());

        this._familytest2collectiontests.get(data.id)
            .forEach(function(collectiontId_slot) {
                var parts = collectiontId_slot.split(':::')
                  , collectiontId = parts[0]
                  , slot = parts[1], row
                  ;
                // collectiontest_slot => collection_id + slot PATH
                row = this._collections.get(collectiontId).getRow(slot);
                row.familytest = data;
                // needs update now!
                changedRows.add(row);
            }.bind(this));
        this._updateRows(changedRows);
    };

    _p._updateRows = function(changedRows) {
        var changedSelectors = [];
        changedRows.forEach(function(row) {
            return changedSelectors.push([row.collection, row, '*']);
        });
        this._update(false, changedSelectors);
    };

    _p._changeCollectiontest = function(data) {
        var collectionId = data.collection_id
          , collection = this._collections.get(collectionId)
          , slot = data[this._slotKey] // family_name
          , row, old, familytest
          , type = 'data'
          ;

        // if the collection does not exist: create it
        if(!collection)
            collection = this._initCollection(collectionId);

        if(!(type in this._rowElements) || !this._rowElements[type].has(slot))
            this._initSlot(type, slot);

        row = collection.getRow(slot);
        old = row.collectiontest;
        row.collectiontest = data;

        if(!this._familytest2collectiontests.has(data.familytests_id))
            this._familytest2collectiontests.set(data.familytests_id, new Set());

        this._familytest2collectiontests.get(data.familytests_id)
                        .add([collectionId, slot].join(':::'));

        familytest = this._familytests.get(data.familytests_id);
        // set or unset
        row.familytest = familytest || null;

        if(old && old.familytests_id !== data.familytests_id) {
            this._familytest2collectiontests.get(old.familytests_id)
                        .delete([collectionId, slot].join(':::'));
        }
        this._updateRows([row]);
    };

    return DashboardController;
});
