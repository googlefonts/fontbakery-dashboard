define([
    'dom-tool'
  , 'protocolbuffers/shared_pb'
], function(
    dom
  , shared_pb
) {
    "use strict";
    /*global window, console, XMLHttpRequest, Uint8Array*/

    var File = (function() {

    var Parent = shared_pb.File;
    function File(parentElement, filename, arrBuff) {
        Parent.call(this);
        this.setName(filename);
        this.setData(arrBuff);

        this._parentElement = parentElement;
        this._controlsElement = this._makeControlsElement();
        this._parentElement.appendChild(this._controlsElement);
    }

    var _p = File.prototype = Object.create(Parent.prototype);

    _p._makeControlsElement = function() {
        return dom.createTextNode(this.getName());
    };

    return File;
    })();

    function Controller(filesControlsContainer, generalControlsContainer) {
        this._files = new shared_pb.Files();
        this.fileOnLoad = this._fileOnLoad.bind(this);
        this._filesControlsContainer = filesControlsContainer;
        this.generalControls = generalControlsContainer;
        this._onResponseCallbacks = [];
        this._initControls();
    }
    var _p = Controller.prototype;

    _p._fileOnLoad = function(file, e) {
        var reader = e.target;
        this._addFile(file.name, reader.result);
    };

    _p._addFile = function(filename, arrBuff) {
        var itemContainer = this._filesControlsContainer.ownerDocument.createElement('li')
          , file
          ;
        file = new File(itemContainer, filename, new Uint8Array(arrBuff));
        this._filesControlsContainer.appendChild(itemContainer);
        this._files.addFiles(file);
    };

    _p._send = function() {
        var i,l, job = [], data, xhr;

        for(i=0,l=this._files.length;i<l;i++)
            Array.prototype.push.apply(job, this._files[i].getJobData());
        data = this._files.serializeBinary().buffer;// UInt8Array

        console.log('this._files', this._files);
        console.info('Sending', data.byteLength ,'Bytes');

        xhr = new XMLHttpRequest();
        xhr.open('POST', '/runchecks');
        xhr.setRequestHeader('Content-Type', 'application/octet-stream');
        xhr.send(data);
        xhr.responseType = 'json';

        var onResponse = this._onResponse.bind(this);

        xhr.onreadystatechange = function () {
            if(xhr.readyState !== XMLHttpRequest.DONE)
                return;
            if(xhr.status !== 200)
                console.warn(xhr.status, xhr.statusText );
            else {
                console.info('Received:', xhr.responseType, xhr.response);
                onResponse( xhr.response );
            }
        };
    };

    _p.onResponse = function(callback) {
        this._onResponseCallbacks.push(callback);
    };


    _p._onResponse = function(response) {
        var i, l;
        window.history.pushState(null, null, response.url);
        for(i=0,l=this._onResponseCallbacks.length;i<l;i++)
            this._onResponseCallbacks[i](response);
    };

    _p._initControls = function() {
        var send = dom.createChildElement(this.generalControls, 'button'
                                            , null, 'Run the Checks!');

        send.addEventListener('click', this._send.bind(this));
    };

    return Controller;
});
