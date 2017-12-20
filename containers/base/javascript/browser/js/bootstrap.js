define([
], function(
) {
    "use strict";
    var setup = {
        baseUrl: '/browser/js'
      , paths: {
            'marked': 'bower_components/marked/marked.min'
          , 'socket.io': '/socket.io/socket.io'
          , 'jiff': 'bower_components/jiff/jiff.umd'
          , 'jsonPointer':  'bower_components/jiff/jsonPointer.umd'
          , 'ansiUp': 'bower_components/ansi_up/ansi_up'
          , 'protocolbuffers': 'bower_components/protocolbuffers'
        }
    };
    require.config(setup);
    return require;
});
