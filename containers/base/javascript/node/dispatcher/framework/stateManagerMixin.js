"use strict";
/* jshint esnext:true, node:true*/

/**
 * Providing some helper methods to normalize how state that is going to
 * be persisted in the DB is handled.
 */
const stateDef = Symbol('stateDefinition');
function stateManagerMixin(_p, stateDefinition) {
    var isFirstMixing = !(stateDef in _p);
    if(isFirstMixing) {
        // truly new, stateDef is not in the prototype chain
         _p[stateDef] = Object.create(null);
    }
    else if(Object.getOwnPropertySymbols(_p).indexOf(stateDef) === -1) {
        // Inherited, because stateDef is in the prototype chain,
        // but not in getOwnPropertySymbols.
        // Inherit from _p[stateDef], instead of changing the
        // inherited version:
        _p[stateDef] = Object.create(_p[stateDef]);
    }

    for(let [key, definition] of Object.entries(stateDefinition))
        // should we log a `info` or `debug` when overriding?
        // NOTE: at this point log levels etc. are not available
        // since this is Class definition meta programming not
        // initialization.
        _p[stateDef][key] = definition;

    // no need to extend prototype again
    if(!isFirstMixing)
        return;

    _p._stateDefEntries = function* () {
        // this uses a for ... in loop, so we get the keys from the
        // prototype chain.
        for(let k in this[stateDef])
            yield [k, this[stateDef][k]];
    };

    _p._isExpectedState = function(key) {
        var definition;
        if(!(key in this[stateDef]))
            return false;
        definition = this[stateDef][key];
        if(!('isExpected' in definition))
            return true;
        return definition.isExpected.call(this);
    };

    /**
     * Called on a fresh initialization in the constructor, when there's
     * no state available yet.
     */
    _p._initState = function() {
        this._state = {};
        for(let [key, definition] of this._stateDefEntries()) {
            if(!this._isExpectedState(key))
                continue;
            this._state[key] = definition.init.call(this);
        }
    };

    _p.serialize = function(options) {
        var state = {};
        for(let [key, definition] of this._stateDefEntries()) {
            if(!this._isExpectedState(key))
                // we could iterate just over the keys of this._state
                // instead and only expected keys would appear, see
                // _initState and _loadState, but this way is working
                // as well, and maybe more explixit.
                continue;
            if(options && options.filterKeys && options.filterKeys.has(key))
                continue;
            state[key] = definition.serialize.call(this, this._state[key], options);
        }
        return state;
    };

    /**
     * Validation on construction is to figure if we received a valid state
     * to begin with.
     * After changing state, if it is still valid, we can commit the changes
     * to the database.
     *
     * FIXME: This implies state can go bad after the process was created,
     * from within. Not sure we need this and not sure how to implement...
     * A self-health test would be nice to have though.
     *
     * TODO: this is not used anywhere! do we need it?
     */
    _p.validateState = function() {
        throw new Error('Not implemented!');
    };

    _p._callAndCatch = function(func, ...args) {
        try {
            return [true, func.call(this, ...args)];
        }
        catch(error) {
            // I don't want the original error stack trace to be lost completely.
            // Make this a `this.log.debug(error);`?
            this.log.warning(error);
            return [false, error.message];
        }
    };

    /**
     * Called in the constructor on an initialization that loads existing
     * state from the database i.e. like a resurrection of the object from
     * persistence.
     */
    _p._loadState = function(state) {
        this._state = {};
        var errorMessages = []
          , stateDefKeys = new Set()
          , indent = str=>str.split('\n').map(line=>'    '+line).join('\n')
          ;
        for(let [key, definition] of this._stateDefEntries()) {
            stateDefKeys.add(key);
            // some simple validation
            if(!this._isExpectedState(key)) {
                // if there's a state now for this key it's not compatible
                if(key in state)
                    errorMessages.push('* ' + key + ' (key): '
                                           + 'State is incompatible, key "'
                                           + key +'" is NOT EXPECTED but present.');
                // else: all good: not expected and not in state
                continue;
            }
            else if(!(key in state)) {
                errorMessages.push('* ' + key + ' (key): '
                                       +'State is incompatible, key "'
                                       + key +'" is expected but NOT PRESENT.');
                continue;
            }
            // expected and in state

            // In this case validate ensures the data for key can be loaded,
            // but not, that the result is valid. So maybe we need a single
            // point of failure which is where the state is actually used?
            // Thus `validate` is optional and also `load` can just raise an
            // error. `validate` is useful for simple data types, such as dates
            // or booleans, but more complex types like steps would fail when
            // loading bad state instead, doing internal validation.
            // If we never use `validate` remove it again!
            if('validate' in definition && !definition.validate)
                // this is likely a programming error
                this.log.warning('"validate" is falsy in', key, 'of', this.constructor.name);
            if(definition.validate) {
                let [result, message] = definition.validate.call(this, state[key]);
                if(!result) {
                    errorMessages.push('* ' + key + ' (validate): ' + message);
                    continue;
                }
            }
            // try/catch and collect these as well, as in valiation.
            // because e.g. in load of a 'tasks' key of Step this validation
            // will happen as well, but in this case,
            let [result, valueOrMessage] = this._callAndCatch(definition.load, state[key]);
            if(!result) {
                errorMessages.push('* ' + key + ' (load): ' + valueOrMessage);
                continue;
            }
            else
                this._state[key] = valueOrMessage;
        }

        let notDefKeys = [];
        for(let key in state)
            if(!(stateDefKeys.has(key)))
                notDefKeys.push(key);
        if(notDefKeys.length)
            errorMessages.push('* State defines unspecified keys: '
                                                + notDefKeys.join(', '));

        if(errorMessages.length)
            throw new Error('State to load had the following issues:\n'
                            + '===============\n'
                            + errorMessages.map(indent).join('\n')
                            + '\n==============='
                            );
    };
}

exports.mixin = stateManagerMixin;

