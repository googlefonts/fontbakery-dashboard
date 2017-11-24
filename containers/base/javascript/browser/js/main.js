define([
    'dom-tool'
  , 'socket.io'
  , 'Controller'
  , 'Report'
  , 'CollectionController'
  , 'CollectionReport'
  , 'DashboardController'
], function(
    dom
  , socketio
  , Controller
  , Report
  , CollectionController
  , CollectionReport
  , DashboardController
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
        dom.clear(target);
        activatedElement = template.cloneNode(true);
        target.appendChild(activatedElement);
        return activatedElement;
    }

    function initDNDSendingInterface() {
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
        socket.emit('subscribe-report', { id: data.id });
    }

    function _initCollectionsInterface() {
        var container = activateTemplate('collection-landing-page')
          , ctrl = new CollectionController(container)
          ;
    }

    function initCollectionReportInterface(data) {
        var container = activateTemplate('collection-report-interface')
          , templatesContainer = getTemplatesContainer('collection-report-templates')
          , socket = socketio('/')
          , report = new CollectionReport(container, templatesContainer, data)
          ;

        socket.on('changes', report.onChange.bind(report));
        socket.emit('subscribe-collection', { id: data.id });
    }

    function initDashboard(data) {
        var container = activateTemplate('dashboard-interface')
         , templatesContainer = getTemplatesContainer('dashboard-templates')
         , socket = socketio('/')
         , dashboard = new DashboardController(container, templatesContainer, data)
         ;
        socket.on('changes', dashboard.onChange.bind(dashboard));
        console.log('subscribe-dashboard');
        socket.emit('subscribe-dashboard', {});
    }

    function getInterfaceMode() {
        var data = null
          , defaultMode = 'collections'
          , defaultData = null
          , mode, init
          , pathparts = window.location.pathname.split('/')
          , i, l
          , modes = {
                // path-marker: "mode"
                // We use a mapping here for historical reasons.
                // Could maybe get rid of it.
                report:  initReportingInterface
              , collections: _initCollectionsInterface
              , 'collection-report': initCollectionReportInterface
              , 'drag-and-drop': initDNDSendingInterface
              , 'dashboard': initDashboard
            }
          ;
        mode = defaultMode;
        // change mode?
        for(i=0,l=pathparts.length;i<l;i++) {
            if(pathparts[i] in modes) {
                mode = pathparts[i];
                break;
            }
        }
        init = modes[mode];
        // extra data for mode?
        switch(mode) {
            case('collection-report'):
            // falls through
            // behaves exactly like report, but `id` is for collection_id
            case('report'):
                // if 'reporting/' in url
                // familytests_id is at reporting/{id}
                data = {
                    id: decodeURIComponent(pathparts[i+1])
                  , url:  window.location.pathname
                };
                break;
            //case('collection'):
            //case('drag-and-drop'):
            //case('dashboard'):
            default:
                data = defaultData;
            break;
        }
        return [data, init];
    }

    return function main() {
        // here's a early difference:
        // either we want to bootstrap the sending interface OR the
        // reporting interface.
        // The sending interface will also transform into the reporting interface.

        var interfaceMode = getInterfaceMode()
          , data = interfaceMode[0]
          , init = interfaceMode[1]
          ;
        init(data);
        // Using pushstate changes the behavior of the browser back-button.
        // This is intended to make it behave as if pushstate was not used.
        window.onpopstate = function(e) {
            // jshint unused:vars
            window.location.reload();
        };
    };
});
