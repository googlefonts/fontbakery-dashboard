"use strict";
/* jshint esnext:true, node:true*/

const crypto = require('crypto');

/**
 * Providing some helper methods to unify how to work with expected answers.
 */
function expectedAnswersMixin(_p) {

    Object.defineProperties(_p, {
        secret: {
            get: function() {
                throw new Error('Not implemented "secret".');
            }
        }
      , _callbackTicket: {
            get: function() {
                if(!this._hasExpectedAnswer())
                    return null;
                return this._state.expectedAnswer.slice(0,2);
            }
        }
      , requestedUserInteraction: {
            get: function() {
                if(!this._hasRequestedUserInteraction())
                    return null;
                // => [requestedUserInteractionName, callbackTicket]
                // === [requestedUserInteractionName, [callbackName, ticket]]
                return [
                    this._state.expectedAnswer[2]
                  , this._callbackTicket
                ];
            }
        }
    });

    _p._hash = function(...data) {
        var hash = crypto.createHash('sha256');
        for(let str of data)
            hash.update(str);
        return hash.digest('hex');
    };

    /**
     * A hash for ticket only makes sense if it includes the callbackName,
     * a unique/random number or maybe the date, a secret
     * The secret should not accessible with database access,
     * so, "unauthorized" database access cannot enable to make any callback
     * expected.
     * The secret must not be in the git repo, otherwise it's not a secret!
     */
    _p._getTicket = function (callbackName, dateString/*don't use for new tickets*/) {
        var date = dateString || new Date().toISOString()
          , hash
          ;
        hash = this._hash(date, callbackName, this.secret);
        return [date, hash].join(';');
    };

    /**
     * As a convention, uiName and thus the method name
     * must start with "ui"
     */
    _p._hasUserInteraction = function(uiName) {
        return !!(uiName.indexOf('ui') === 0 && this[uiName]);
    };

    /**
     * As a convention, callbackName and thus the method name
     * must start with "callback"
     */
    _p._hasCallbackMethod = function(callbackName) {
        return !!(callbackName.indexOf('callback') === 0 && this[callbackName]);
    };

    _p._getCallbackMethod = function(callbackName) {
        return this._hasCallbackMethod(callbackName)
                ? this[callbackName]
                : null
                ;
    };

    /**
     * Must be either null or an 3 item array:
     *          [callbackName, ticket, requestedUserInteractionName]
     * If an array the second entry is the ticket, if somehow
     * "signed"/"salted" with a "secret" could be validated as well.
     * I.e. if the secret changes, the loaded state would then then be invalid …
     */
    _p._validateExpectedAnswer = function(expectedAnswer) {
        if(expectedAnswer === null)
            return [true, null];
        var [callbackName, ticket, requestedUserInteractionName] = expectedAnswer;

        if(!this._hasCallbackMethod(callbackName))
            return [false, 'Callback "' + callbackName + '" is not defined.'];

        let dateString = ticket.split(';')[0];
        if(ticket !== this._getTicket(callbackName, dateString))
            return [false, 'Ticket is invalid.'];

        if(requestedUserInteractionName !== null
                    && !this._hasUserInteraction(requestedUserInteractionName))
            return [false, 'Requested user Interaction "'
                        + requestedUserInteractionName + '" is not defined.'];

        return [true, null];
    };

    _p._hasExpectedAnswer = function() {
        return this._state.expectedAnswer !== null;
    };

    _p._unsetExpectedAnswer = function() {
        this._state.expectedAnswer = null;
    };

    /**
     * A task can only expect one answer at any time, to keep it simple.
     * We may change this if there's a good use case.
     *
     * This needs to be put into _state, so we can serialize it!
     */
    _p.__setExpectedAnswer = function(waitingFor
                                   , callbackName
                                   , requestedUserInteractionName
                                   ) {
        var ticket = this._getTicket(callbackName)
          , expectedAnswer = [callbackName, ticket
                                    , requestedUserInteractionName || null]
          , [result, message] = this._validateExpectedAnswer(expectedAnswer)
          ;
        if(!result)
            throw new Error('expectedAnswer is invalid: ' + message);
        this._state.expectedAnswer = expectedAnswer;
        return this._callbackTicket;
    };

    /**
     * This name will actually be called, but __setExpectedAnswer
     * can be used for a kind of sub-classing if needed.
     * See Task.prototype._setExpectedAnswer as an example for such a
     * "sub-classing".
     */
    _p._setExpectedAnswer = _p.__setExpectedAnswer;

    /**
     * ticket would be a unique string stored in here
     */
    _p._isExpectedAnswer = function(callbackName, ticket) {
        return this._hasExpectedAnswer()
                        && this._state.expectedAnswer[0] === callbackName
                        && this._state.expectedAnswer[1] === ticket
                        ;
    };

    _p._hasRequestedUserInteraction = function() {
        return this._hasExpectedAnswer() && this._state.expectedAnswer[2] !== null;
    };

    _p._callPromisified = function(method, ...args) {
        try {
            // may return a promise but is not necessary
            // Promise.resolve will also fail if method returns a failing promise.
            return Promise.resolve(method.call(this, ...args));
        }
        catch(error) {
            return Promise.reject(error);
        }
    };

    _p._handleStateChange = function(methodName, stateChangePromise) {
        //jshint unused: vars
        throw new Error('Not implemented "_handleStateChange"');
    };

    _p._runStateChangingMethod = function(method, methodName, ...args) {
        var stateChangePromise = this._callPromisified(method, ...args)
          , methodName_ = methodName || method.name
          ;
        return this._handleStateChange(methodName_, stateChangePromise);
    };

    /**
     * commandMessage.callbackTicket: To verify a answer comes from the actual
     * request that was dispatched, ticket is a unique, "signed" string stored
     * here We're round tripping it  from dispatched request back to here.
     * A ticket is only valid once. If we need more answers for the same
     * callback, it would be good to make the this._state.expectedAnswer[1]
     * value a set of allowed tickets and have _setExpectedAnswer be called
     * with a number indicating the count of expected answers. But we need a
     * good use case for it first, because it's more complicated to get it right.
     * I.e. we may run into race conditions or otherwise conflicting states
     * when there are parallel expected answers. It's much better to
     * implement concurrency using the step-task model.
     *
     * A requested user interaction callbackMethod must be able to reject
     * an answer and provide hints to the user abut what went wrong,
     * i.e. if there's some validation
     * issue. In that case, we **don't** keep expected answer and
     * request user interaction around for re-use. Instead, the callbackMethod
     * should be like a "monkey form" implementation, calling itself explicitly
     * (via _setExpectedAnswer) until all requirements are met. Then, also,
     * only one client can answer to one expected answer, resolving the
     * race directly here, even before the `callbackMethod` could go async
     * or so.
     */
    _p._executeExpectedAnswer = function(commandMessage) {
        var callbackName = commandMessage.getCallbackName()
          , ticket = commandMessage.getTicket()
          , payload = commandMessage.getPayload()
          , data, callbackMethod
          , expected = this._isExpectedAnswer(callbackName, ticket)
          ;
        if(!expected)
            throw new Error('Action for "' + callbackName + '" with ticket "'
                                        + ticket + '" is not expected.');
        data = JSON.parse(payload);
        callbackMethod = this._getCallbackMethod(callbackName);

        TODO;// we need to establish a back channel here, that goes directly to
        // the user interacting, if present! ...
        // Everything else will be communicated via the changes-feed of
        // the process. Back channel likely means there's an answer message
        // for the execute function.
        this._unsetExpectedAnswer();
        return this._runStateChangingMethod(callbackMethod, callbackName, data);
    };
}
exports.mixin = expectedAnswersMixin;
