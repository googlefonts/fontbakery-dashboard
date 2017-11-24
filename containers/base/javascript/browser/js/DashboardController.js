define([
    'dom-tool'
  , 'isEqual'
], function(
    dom
  , isEqual
) {
    "use strict";

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
    function ratio (part, total) {
        return total ? part/total : null;
    }
    function identity(value) {
        return value;
    }

    var Row = (function() {

    // highly specialized: better place? document?
    function getOriginValue() {
        //jshint validthis: true
        // thisval is a instance of  `Field`
        return this.row.getOriginData(this.name);
    }
    // new Field(collection, this, name, [], getOriginValue);

    function Row(global, collection, slot, domMarker) {
        this.global = global;
        this.collection = collection;
        this.slot = slot;
        this.domMarker = domMarker;

        this._data = {
            collectiontest: null
          , familytest: null
        };

        // cell name => Cell instance
        this._cells = new Map();
        // cell name => Representation instance
        this._representations = new Map();

        // make this configurable?
        // how to fill a field with content
        // always, if one dependency is null, the dependant is also
        // null. For the all passing case, this is inapplicable
        // unless there's a way to

        this._initFields({
                    // when it starts with data I'll look in here
                    // name.split('.') => go digging
            'FAIL': ['*origin.familytest.results.FAIL', identity]
          , 'results': ['*origin.familytest.results', identity]
          , 'reported': ['results', function(results) {
                return arraySum(Object.values(results));
            }]
          , 'passing': ['*origin.familytest.results', function(results) {
                var failing = new Set(['ERROR', 'FAIL'])
                  , results_ = results || {}
                  , values = Object.keys(results_)
                      .filter(function(key){ return !failing.has(key); })
                      .map(function(key){ return this[key]; }, results)
                  ;
                return arraySum(values);

            }]
          , 'total': ['*origin.familytest.total', identity]
          // FAIL and total here are actually:
          // [this.collection, this, 'FAIL']
          // [this.collection, this, 'total']
          , 'FAIL-ratio': ['FAIL', 'total', ratio]
          , 'passing-ratio': ['passing', 'total', ratio]
          , custom: [function(){ return 'Hello!'; }]
        });

        function renderRatio(ratio, part, total) {
            return [
                (Math.round(ratio * 10000)/100), '%',
                , ' (' , part , ' of ' , total , ')'
            ].join('');
        }

        this._initRepresentations({
            fail: ['FAIL-ratio', 'FAIL', 'total', renderRatio ]
          , pass: ['passing-ratio', 'passing', 'total', renderRatio]
          // this can also read directly from this._data
          , total: ['*origin.familytest.total', identity]
          , fr: ['FAIL-ratio', identity]
          , FAIL: ['FAIL', identity]
          , custom: ['custom', identity]
        });
    }
    var _p = Row.prototype;

    // interfaces used by the controller (just the setters to be precise)
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

    _p._getField = function(name) {
        // we don't explicitly define origin fields!
        // they are implicitly created in here.
        if(name.indexOf('*origin') === 0)
            this._initField(name, [getOriginValue]);
        // NOTE how this explicitly injects the location information
        // for collection and row.
        return this.global.getRegisteredField(this.collection, this, name);
    };

    _p._getFields = function(names) {
        return names.map(this._getField, this);
    };

    _p._initField = function(name, definition) {
        var valueFunc = definition[definition.length-1]
          , dependencies = this._getFields(definition.slice(0, -1))
          ;
        this.global.initField(this.collection, this, name, dependencies, valueFunc);
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

    // This is used to control which fields of the collection are
    // displayed, handles dom element creation and deletion.
    // The collection calls this for all of its rows;
    _p.setCells = function(namesInOrder) {
        var namesSet = new Set(namesInOrder)
          , existing = Array.from(this._cells.keys())
          , i, l, name, last, cell, domNode
          ;

        for(i=0,l=existing.length;i<l;i++) {
            name = existing[i];
            if(namesSet.has(name))
                continue;
            cell = this._cells.get(name);
            this._cells.delete(name);
            dom.removeNode(cell.container);
            this.global.deleteCell(cell);
        }

        for(i=0,l=namesInOrder.length;i<l;i++) {
            name = namesInOrder[i];
            if(!this._cells.has(name)) {
                cell = new Cell(
                    dom.createElement('td', {'class': 'field-' + name})
                  , this._representations.get(name)
                );
                this._cells.set(name, cell);
                this.global.setCell(cell);
            }
        }

        last = null;
        for(i=0,l=namesInOrder.length;i<l;i++) {
            domNode = this._cells.get(namesInOrder[i]).container;
            dom.insertAfter(domNode, last || this.domMarker);
            last = domNode;
        }
    };

    return Row;
    })()


  , Representation = (function() {
    function Representation(dependencies, renderFunc) {
        Object.defineProperty(this, 'dependencies', {value: dependencies});
        this._renderFunc = renderFunc;
    }

    var _p = Representation.prototype;
    _p.render = function(field) {
        var args = this.dependencies.map(function(d){ return d.value; });
        return this._renderFunc.apply(field, args);
    };
    return Representation;
    })()


  , Cell = (function(){
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
            content = 'N/A';
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

  , Collection = (function() {
    function Collection(id) {
        this.id = id;
        this.rowMarkerStr = 'collection: ' + id;
        this._rows = new Map(); // slotValue => row
    }

    var _p = Collection.prototype;

    _p.setRow = function(slot, row) {
        this._rows.set(slot, row);
    };

    _p.getRow = function(slot) {
        return this._rows.get(slot);
    };

    // after this, we should also update the fields contents
    // as some may be new/empty
    // not sure if this is controlled by each collection OR rather by
    // the controller. BUT we must also call this whenever a new row
    // is added!
    // this depends on `_initCollectionRow` as that inserts the
    // domMarker of the row into the DOM
    _p.setCells = function(slot) {
        // for new rows, collection should remember these fields, once
        // they are set. but also, generally, they may just be
        // best managed within collection.

        // FIXME: if there's at least one ERROR in the collection
        // add the error field [this, *, error].length ? || sumAll != 0
        var fieldsInOrder = ['fail', 'total', 'fr', 'FAIL', 'notdef','pass', 'custom']
            // all rows if row is undefined
          , rows = slot ? [this.getRow(slot)] : this._rows
          ;
        rows.forEach(function(row) {
            // jshint unused:vars
            row.setCells(fieldsInOrder);
        });
    };

    return Collection;
    })()


  , Field = (function() {


    // IMPORTANT: see DashboardController.fieldFactory
    // which defines the `value` getter of the field
    function Field(collection, row, name, dependencies, valueFunc) {
        this.collection = collection;
        this.row = row;
        this.name = name;
        this.dependencies = dependencies; // [instances of Field in order]
        this._valueFunc = valueFunc;
    }

    var _p = Field.prototype;

    // FIXME: a thought of maybe pre-initializing fields without
    // an actual definition, just to make it possible to pre-fill
    // the this.dependencies array with the correct instances.
    // or leave them as a placeholder.
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
        });
    }
    _p = Global.prototype;

    function getKey(collection, row, name) {
        var c = collection === null ? '*null' : collection.id
          , r = row === null ? '*null' : row.slot
          ;
        return [c, r, name].join(':::');
    }

    _p.getRegisteredField = function(collection, row, name) {
        var key = getKey(collection, row, name)
          , field = this._fields.get(key)
          ;
        if(!field) {
            field = Object.create(Field.prototype);

            field.key = key; // FIXME: only for debugging, should not be needed later
            this._fields.set(key, field);
        }
        return field;
    };

    _p._initField = function(field, collection, row, name, dependencies, valueFunc) {
        if(field.hasOwnProperty('value'))
            // has already been initialized
            return;
        Object.defineProperty(field, 'value', {
            get: this.valuesCache.get.bind(this.valuesCache, field)
        });
        Field.call(field, collection, row, name, dependencies, valueFunc);
    };

    _p.initField = function(collection, row, name, dependencies, valueFunc) {
        var field = this.getRegisteredField(collection, row, name);
        this._initField(field, collection, row, name, dependencies, valueFunc);
        return field;
    };

    _p.setCell = function(cell){
        this.activeCells.add(cell);
    };

    _p.deleteCell = function(cell){
        this.activeCells.delete(cell);
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
        this._rowElements = new Map(); // slot => rowElement

        this._global = new Global();

        this._collectionOrder = [
              'GoogleFontsAPI/production'
            , 'GoogleFontsAPI/sandbox'
        ];
        this._thead = dom.createElement('thead', []);
        this._tbody = dom.createElement('tbody', []);
        this._tfoot = dom.createElement('tfoot', []);

        this._table = dom.createElement('table', []
                                , [this._thead, this._tbody, this._tfoot]);
        dom.insertAtMarkerComment(this.container, 'insert: dashboard', this._table);
        this._collectionOrder.forEach(this._initCollection.bind(this));
    }

    var _p = DashboardController.prototype;

    function singleSelect(selector, field) {
        var collection = selector[0]
          , row = selector[1]
          , name = selector[2]
          ;
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
    _p._update = function(changedSelectors) {
        // traverse the dependency graph depth first
        // and update cells if needed
        function visit(subject) {
            var i,l,field;
            //jshint validthis:true
            if(this.visited.has(subject))
                    // we have seen this before, state is stored
                return;

            if(this.visiting.has(subject))
                throw new Error('recursion in "' + subject + '" '
                            + 'currently visiting:' + this.visiting);
            this.visiting.add(subject);

            // has no dependencies => may be an origin field
            // also, all change originates from fields like this.
            var needsReEvaluate = (
                        !subject.dependencies.length
                        // is part of the row that got updated
                        // could also just ask: subject.row === row
                        // but I may add other fields as well ->
                        // though currently all change originates
                        // from changed rows!
                        && selects(changedSelectors, subject)
                    );

            // has dependencies
            for(i=0,l=subject.dependencies.length;i<l;i++){
                field = subject.dependencies[i];
                this.visit(field);
                if(this.changed.has(field))
                    needsReEvaluate = true;
            }

            if(needsReEvaluate && this.reEvaluate(subject))
                this.changed.add(subject);

            this.visiting.delete(subject);
            this.visited.add(subject);
        }

        var state = {
            visited:  new Set()
            , visiting: new Set() // detect recursion
            , changed: new Set()
            , visit: visit
            , reEvaluate: this._reEvaluate.bind(this)
        };

        this._global.activeCells.forEach(function(cell) {
            var changed = false
              , i, l, dependeny
              ;
            for(i=0,l=cell.dependencies.length;i<l;i++) {
                dependeny = cell.dependencies[i];
                state.visit(dependeny);
                if(state.changed.has(dependeny))
                    changed = true;
            }
            if(changed)
               cell.render();
        });
    };

    _p._initCollection = function(collectionId) {
        var collection;
        if(this._collections.has(collectionId))
            throw new Error('Collection "'+collectionId+'" already exists.');

        if(this._collectionOrder.indexOf(collectionId) === -1)
            this._collectionOrder.push(collectionId);

        // init collection
        collection = new Collection(collectionId);
        this._collections.set(collectionId, collection);
        this._rowElements.forEach(function(rowElement, slot) {
            //jshint unused:vars
            // NOTE: initialy there are now rows at all
            // BUT! the thead will eventually have lables for each collection!
            // and the columns
            // so that head must be build here.
            this._initCollectionRow(collection, slot);
        }.bind(this));
        collection.setCells(/*all*/);
        return collection;
    };

    _p._rowFabric = function(collection, slot) {
        var domMarker = dom.createComment(collection.rowMarkerStr)
          , row = new Row(this._global, collection, slot, domMarker)
          ;
        collection.setRow(slot, row);
        return row;
    };

    _p._insertRowAtRightPosition = function(slot, rowElement) {
        // TODO: at the right position!
        dom.appendChildren(this._tbody, rowElement, false);
    };

    // must run when a new collection is added
    // AND when a new slot is added!
    _p._initCollectionRow = function(collection, slot) {
        // insert the marker comment at the right position.
        var row = collection.getRow(slot)
          , rowElement = this._rowElements.get(slot, rowElement)
          ;
        if(!row)
            row = this._rowFabric(collection, slot);
        // TODO: insert it "at the right position" => either we give
        // collections a weight via the backend or we hardcode it into
        // the frontend ... (it's in the frontend now, but not applied
        // see _collectionOrder
        dom.insert(rowElement, 'prepend', row.domMarker);

        // TODO: markers are in place: fill with new empty <td>s for
        // the collection, See: collection.setCells(fieldsInOrder)
        // where is "fieldsInOrder" coming from?
    };

    _p._initSlot = function(slot) {
        if(this._rowElements.has(slot))
            throw new Error('Slot "' + slot + '" already exists.');

        var rowElement = dom.createElement('tr');
        this._rowElements.set(slot, rowElement);

        this._collections.forEach(function(collection) {
            // creates a row instance for each collection
            this._rowFabric(collection, slot);
        }.bind(this));

        this._insertRowAtRightPosition(slot, rowElement);

        // insert the domMarker comments in order and ad the td's
        this._collectionOrder.forEach(function(collectionId) {
            // jshint validthis:true
            var collection = this._collections.get(collectionId);
            this._initCollectionRow(collection, slot);
            collection.setCells(slot);
        }.bind(this));
    };

    _p.onChange = function(data) {
        console.log('received', data.type, data);
        // data.type = collectiontest || familytest
        switch(data.type) {
            case('collectiontest'):
                this._changeCollectiontest(data);
            break;
            case('familytest'):
                this._changeFamilytest(data);
            break;
        }
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
            changedSelectors.push([row.collection, row, '*']);
        });
        this._update(changedSelectors);
    };

    _p._changeCollectiontest = function(data) {
        var collectionId = data.collection_id
          , collection = this._collections.get(collectionId)
          , slot = data[this._slotKey] // family_name
          , row, old, familytest
          ;

        // if the collection does not exist: create it
        if(!collection)
            collection = this._initCollection(collectionId);


        if(!this._rowElements.has(slot))
            this._initSlot(slot);

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
                        .delete([old.collection_id, old[this._slotKey]].join(':::'));
        }
        this._updateRows([row]);
    };

    return DashboardController;
});
