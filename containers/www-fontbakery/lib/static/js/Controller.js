define([
    'dom-tool'
], function(
    dom
) {
    "use strict";
    /*global window, console, XMLHttpRequest, TextDecoder, Uint8Array, TextEncoder, Uint32Array*/

    function mergeArrays(arrays) {
        var jobSize = arrays.reduce(function(prev, cur){
                                    return prev + cur.byteLength; }, 0)
          , result, i, l, offset
          ;
        result = new Uint8Array(jobSize);
        for(i=0,l=arrays.length,offset=0; i<l;offset+=arrays[i].byteLength, i++)
            result.set(new Uint8Array(arrays[i]), offset);
        return result.buffer;
    }

    var Font = (function(){

    function Font(parentElement, filename, arrBuff) {
        this._filename = filename;
        this._parentElement = parentElement;
        this._arrBuff = arrBuff;

        this._controlsElement = this._makeControlsElement();
        this._parentElement.appendChild(this._controlsElement);
    }

    var _p = Font.prototype;

    _p._makeControlsElement = function() {
        return dom.createElement('p', null, this._filename);
    };

    _p.getJobData = function() {
        var bytesJson = new TextEncoder('utf-8')
                .encode(JSON.stringify({
                    filename: this._filename
                })).buffer
            // header, json, font
          , job = [null, bytesJson, this._arrBuff]
          , header, i, l
          ;
        header = new Uint32Array(job.length-1);
        job[0] = header.buffer;
        // store at the beginning the length of each element
        console.log(job.length, '~' , job, '!', job[1]);
        for(i=1,l=job.length;i<l;i++) {
            console.log('header[', i,']', job[i].byteLength);
            header[i-1] = job[i].byteLength;
        }
        return job;
    };
    return Font;
    })();

    function Controller(filesControlsContainer, generalControlsContainer) {
        this._files = [];
        this.fileOnLoad = this._fileOnLoad.bind(this);
        this._filesControlsContainer = filesControlsContainer;
        this.generalControls = generalControlsContainer;
        this._onResponseCallbacks = [];
        this._initControls();
    }
    var _p = Controller.prototype;

    _p._fileOnLoad = function(filename, e) {
        var reader = e.target;
        this._addFile(filename, reader.result);
    };

    _p._addFile = function(file, arrBuff) {
        var itemContainer = this._filesControlsContainer.ownerDocument.createElement('li')
          , item
          ;
        item = new Font(itemContainer, file.name, arrBuff);
        this._filesControlsContainer.appendChild(itemContainer);
        this._files.push(item);
    };

    _p.unpack = function(data) {
        var offset = 0, head, json, font
          , result = []
          ;
        while(offset < data.byteLength) {
            head = new Uint32Array(data, offset, 2);
            offset += head.byteLength;

            json = new Uint8Array(data, offset, head[0]);
            offset += json.byteLength;
            json = new TextDecoder('utf-8').decode(json);

            font = new Uint8Array(data, offset, head[1]);
            offset += font.byteLength;

            data = data.slice(offset);
            offset = 0;

            result.push([json, font]);
        }
        return result;
    };

    _p._send = function() {
        var i,l, job = [], data, xhr;

        for(i=0,l=this._files.length;i<l;i++)
            Array.prototype.push.apply(job, this._files[i].getJobData());
        data = mergeArrays(job);

        console.log('unpack', this.unpack(data))

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
        var send = dom.createChildElement(this.generalControls, 'button', null,
                                          [dom.createElement('em', null,'Run'),
                                           ' the ',
                                           dom.createElement('em', null,'Checks!')
                                           ]);

        send.addEventListener('click', this._send.bind(this));
    };

    return Controller;
});
