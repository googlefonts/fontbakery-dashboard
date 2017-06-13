define([
], function(
) {
    "use strict";
    var setup = {
        baseUrl: '/static/js'
      , paths: {
            'marked': 'bower_components/marked/marked.min'
          , 'socket.io': '/socket.io/socket.io'
          , 'jsonpatch': 'bower_components/jsonpatch/jsonpatch.min'
          , 'jiff': 'bower_components/jiff/jiff.umd'
          , 'jsonPointer':  'bower_components/jiff/jsonPointer.umd'
        }
    };
    require.config(setup);
    return require;
});
