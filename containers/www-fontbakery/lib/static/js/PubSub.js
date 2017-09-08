define([
], function(
){
    "use strict";
    /* global setTimeout */
    function PubSub() {
        this._topics = new Map();
    }

    var _p = PubSub.prototype;


    _p._getTopic = function(topic) {
        if(this._topics.has(topic))
            return this._topics.get(topic);

        var topicData = {
            last: null // array if there was a message
          , subscribers: []
        };
        this._topics.set(topic, topicData);
        return topicData;
    };

    function _publish(async, subscription, message) {
        var callback = subscription[0]
          , args = subscription[1].slice()
          ;
        Array.prototype.push.apply(args, message);
        if(async)
            setTimeout(callback.apply.bind(callback, null, args), 0);
        else
            return callback.apply(null, args);
    }

    function Marker(){}
    _p.subscribe = function(topic, callback /* callback args ... */) {
        var topicData = this._getTopic(topic)
          , args = [], i, l, subscription
          , marker = new Marker()
          ;
        for(i=2,l=arguments.length;i<l;i++)
            args.push(arguments[i]);
        subscription = [callback, args, marker];
        topicData.subscribers.push(subscription);
        if(topicData.last !== null)
            // This is the real feature, receive an initial message!
            //
            // In the initial case an async _publish may be what one
            // expects. However, I currently prefer a sync initial
            // publish (subscribe could have an Async and Sync version)
            _publish(false, subscription, topicData.last);
        // return unsubscribe function
        return this._unsubscribe.bind(this, topic, marker);
    };

    _p._unsubscribe = function(topic, marker) {
        var topicData = this._getTopic(topic)
          , subscribers = topicData.subscribers
          , i
          ;
        // From back to front cleanup; i stays valid all the loop.
        for(i=subscribers.length-1;i>=0;i--) {
            if(subscribers[i][2] === marker)
                subscribers.splice(i, 1);
        }
    };

    // Just a thought: using promises as a return of _publish could
    // establish a nice back channel here! for whatever it's worth ;-)
    // In general, though, I would expect publish to be  **sync**.
    _p.publish = function(topic) {
        var message = [], i, l
          , topicData = this._getTopic(topic)
          , subscribers = topicData.subscribers
          ;
        for(i=1,l=arguments.length;i<l;i++)
            message.push(arguments[i]);
        topicData.last = message;
        for(i=0,l=subscribers.length;i<l;i++)
            _publish(false, subscribers[i], message);
    };

    return PubSub;
});
