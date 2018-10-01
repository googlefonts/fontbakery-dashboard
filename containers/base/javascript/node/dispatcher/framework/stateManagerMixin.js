"use strict";
/* jshint esnext:true, node:true*/

/**
 * Providing some helper methods to normalize how state that is going to
 * be persisted in the DB is handled.
 */
function stateManagerMixin(_p, stateDefinition) {
    _p._isExpectedState = function(key) {
        var definition;
        if(!(key in stateDefinition))
            return false;
        definition = stateDefinition[key];
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
        for(let [key, definition] of Object.entries(stateDefinition)) {
            if(!this._isExpectedState(key))
                continue;
            this._state[key] = definition.init.call(this);
        }
    };

    _p.serialize = function() {
        var state = {};
        for(let [key, definition] of Object.entries(stateDefinition)) {
            if(!this._isExpectedState(key))
                // we could iterate just over the keys of this._state
                // instead and only expected keys would appear, see
                // _initState and _loadState, but this way is working
                // as well, and maybe more explixit.
                continue;
            state[key] = definition.serialize.call(this, this._state[key]);
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
     */
    _p.validateState = function() {
        throw new Error('Not implemented!');
    };

    /**
     * Called in the constructor on an initialization that loads existing
     * state from the database i.e. like a resurrection of the object from
     * persistence.
     */
    _p._loadState = function(state) {
        this._state = {};
        for(let [key, definition] of Object.entries(stateDefinition)) {
            // some simple validation
            if(!this._isExpectedState(key)) {
                // if there's a state now for this key it's not compatible
                if(key in state)
                    throw new Error('State is incompatible, key "'
                                        + key +'" is NOT EXPECTED but present.');
                else
                    continue;
            }
            else if(!(key in state)) {
                throw new Error('State is incompatible, key "'
                                        + key +'" is expected but NOT PRESENT.');
            }

            // In this case validate ensures the data for key can be loaded,
            // but not, that the result is valid. So maybe we need a single
            // point of failure which is where the state is actually used?
            // Thus `validate` is optional and also `load` can just raise an
            // error. `validate` is useful for simple data types, such as dates
            // or booleans, but more complex types like steps would fail when
            // loading bad state instead, doing internal validation.
            // If we never use `validate` remove it again!
            if('validate' in definition) {
                let [result, message] = definition.validate.call(this, state[key]);
                if(!result)
                    throw new Error('State for key"' + key + '" did not validate '
                                    +' with message: ' + message);
            }
            this._state[key] = definition.load.call(this, state[key]);
        }
    };
}

exports.mixin = stateManagerMixin;

