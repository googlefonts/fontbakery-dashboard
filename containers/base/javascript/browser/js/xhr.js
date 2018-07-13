define([], function() {
    "use strict";
    /*global XMLHttpRequest, Promise*/

    function _sendXHR(xhr, data) {
        return new Promise(function(resolve, reject){
            xhr.send(data);
            xhr.onreadystatechange = function () {
                if(xhr.readyState !== XMLHttpRequest.DONE)
                    return;
                if(xhr.status !== 200)
                    reject(new Error('XHR not OK; code ' + xhr.status
                                            + '; ' +  xhr.statusText));
                else
                    resolve(xhr.response);
            };
        });
    }

    function getJSON(adress, data) {
        var xhr = new XMLHttpRequest();
        xhr.open('GET', adress);
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.responseType = 'json';
        return _sendXHR(xhr, data);
    }

    return {
        getJSON: getJSON
    };
});
