define([
], function(
) {
    "use strict";
    var setup = {
        baseUrl: '/static/js'
      , paths: {
            'marked': 'bower_components/marked/marked.min',
            'socket.io': '/socket.io/socket.io'
        }
    };
    require.config(setup);
    return require;
});
