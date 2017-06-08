define([
    'dom-tool'
  , 'socket.io'
  , 'Controller'
  , 'Report'

], function(
    dom
  , socketio
  , Controller
  , Report
) {
    "use strict";
    /*global document, window, FileReader*/

    function makeFileInput(fileOnLoad, element) {
        var hiddenFileInput = dom.createChildElement(element, 'input'
                                , {type: 'file', 'multiple': 'multiple'});
        hiddenFileInput.style.display = 'none'; // can be hidden!

        function handleFiles(files) {
            var i, l, reader, file;
            for(i=0,l=files.length;i<l;i++) {
                file = files[i];
                reader = new FileReader();
                reader.onload = fileOnLoad.bind(null, file);
                reader.readAsArrayBuffer(file);
            }
        }

        // for the file dialogue
        function fileInputChange(e) {
            /*jshint validthis:true, unused:vars*/
            handleFiles(this.files);
        }
        function forwardClick(e) {
            /*jshint unused:vars*/
            // forward the click => opens the file dialogue
            hiddenFileInput.click();
        }

        // for drag and drop
        function noAction(e) {
            e.stopPropagation();
            e.preventDefault();
        }
        function drop(e) {
            e.stopPropagation();
            e.preventDefault();
            handleFiles(e.dataTransfer.files);
        }

        hiddenFileInput.addEventListener('change', fileInputChange);
        element.addEventListener('click', forwardClick);
        element.addEventListener("dragenter", noAction);
        element.addEventListener("dragover", noAction);
        element.addEventListener("drop", drop);
    }

    function initFileInputs(fileOnLoad, container, klass) {
        var _makefileInput =  makeFileInput.bind(null, fileOnLoad);
        Array.from(container.getElementsByClassName(klass)).forEach(_makefileInput);
    }


    function getTemplatesContainer(klass) {
        return document.querySelector('body > .' + klass);
    }

    function activateTemplate(klass) {
        var templatesContainer = getTemplatesContainer('templates')
          , template = templatesContainer.getElementsByClassName(klass)[0]
          , target = document.getElementsByClassName('active-interface')[0]
          , activatedElement
          ;

        while(target.lastChild)
            target.removeChild(target.lastChild);
        activatedElement = template.cloneNode(true);
        target.appendChild(activatedElement);
        return activatedElement;
    }

    function initSendingInterface() {
        var container = activateTemplate('sending-interface')
          , ctrl = new Controller(
                  container.getElementsByClassName('files-controls')[0]
                , container.getElementsByClassName('general-controls')[0]
            )
          ;
        initFileInputs(ctrl.fileOnLoad, container, 'drop-fonts');
        ctrl.onResponse(initReportingInterface);
    }


    function initReportingInterface(data) {
        var container = activateTemplate('reporting-interface')
          , templatesContainer = getTemplatesContainer('report-templates')
          , socket = socketio('/')
          , report = new Report(container, templatesContainer, data)
          ;

        socket.on('changes', report.onChange.bind(report));
        socket.emit('subscribe-changes', { docid: data.docid });
    }

    function getInterfaceMode() {
        // if 'reporting/' in url
        // docid is at reporting/{id}
        var data = null
          , mode = 'sending'
          , pathparts = window.location.pathname.split('/')
          , i, l
          , reportMarker = 'report' // yes, hard coded for now.
          ;

        for(i=0,l=pathparts.length;i<l;i++) {
            if(pathparts[i] === reportMarker) {
                mode = 'reporting';
                data = {
                    docid: pathparts[i+1]
                  , url:  window.location.pathname
                };
                break;
            }
        }
        return [mode, data];
    }

    return function main() {
        // here's a early difference:
        // either we want to bootstrap the sending interface OR the
        // reporting interface.
        // The sending interface will also transform into the reporting interface.

        var interfaceMode = getInterfaceMode();
        if(interfaceMode[0] === 'sending')
            initSendingInterface();
        else if(interfaceMode[0] === 'reporting')
            initReportingInterface(interfaceMode[1]);

        // Using pushstate changes the behavior of the browser back-button.
        // This is intended to make it behave as if pushstate was not used.
        window.onpopstate = function(e) {
            // jshint unused:vars
            window.location.reload();
        };
    };
});
