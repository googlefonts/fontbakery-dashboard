define([
    'dom-tool'
  , 'socket.io'
  , 'Controller'
  , 'Report'
  , 'CollectionController'
  , 'StatusController'
  , 'CollectionReport'
  , 'DashboardController'
], function(
    dom
  , socketio
  , Controller
  , Report
  , CollectionController
  , StatusController
  , CollectionReport
  , DashboardController
) {
    "use strict";
    /*global document, window, FileReader*/
    // jshint browser:true

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

        for(var i=0,l=target.children.length;i<l;i++)
            // children can listen for the event and cleanup if needed
            // activatedElement.addEventListener('destroy', function (e) { //... }, false);
            target.children[i].dispatchEvent(new Event('destroy'));
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

        socket.on('changes-report', report.onChange.bind(report));
        socket.emit('subscribe-report', { id: data.id });
    }

    function _initCollectionsInterface() {
        var container = activateTemplate('collection-landing-page')
          , ctrl = new CollectionController(container)
          ;
          return ctrl;
    }

    function _initStatusInterface() {
        var container = activateTemplate('status-landing-page')
          , ctrl = new StatusController(container)
          ;
        return ctrl;
    }

    function initCollectionReportInterface(data) {
        var container = activateTemplate('collection-report-interface')
          , templatesContainer = getTemplatesContainer('collection-report-templates')
          , socket = socketio('/')
          , report = new CollectionReport(container, templatesContainer, data)
          ;

        socket.on('changes-collection', report.onChange.bind(report));
        socket.emit('subscribe-collection', { id: data.id });
    }


    // also used on the server, but useful in the client as well
    function _dashboarNormalizeFilter(userInputfilter) {
        return userInputfilter
            ? userInputfilter.split(',')
                  .map(function(s){return s.trim();})
                  .filter(function(s){return !!s;})
                  .sort()
                  .join(',')
            : ''
            ;
    }

    function initDashboard(data) {
        var socket = socketio('/')
         , lastQuery = null
         , socketChangeHandler = null
         ;
        function onQueryFilterChange() {
            ignoreNextPopState = true;
            var hash = decodeURIComponent(window.location.hash) // it's a firefox bug apparently
              , marker = '#filter:'
              , userInputFilter = ''
              , queryFilter
              ;
            if(hash.indexOf( marker) === 0)
                userInputFilter = hash.slice(marker.length);


            queryFilter = _dashboarNormalizeFilter(userInputFilter);
            // set the normalized value
            window.location.hash = queryFilter ? marker.slice(1) + queryFilter : '';

            // did it really change?
            if(lastQuery === queryFilter)
                return;
            lastQuery = queryFilter;

            if(socketChangeHandler) {
                socket.off('changes-dashboard', socketChangeHandler);
                socketChangeHandler = null;
            }
            // replace the whole thing!
            var container = activateTemplate('dashboard-interface')
              , templatesContainer = getTemplatesContainer('dashboard-templates')
              , dashboard = new DashboardController(container, templatesContainer, data)
              ;

            window.addEventListener('hashchange', onQueryFilterChange, false);
            container.addEventListener('destroy', function(){
                window.removeEventListener('hashchange', onQueryFilterChange, false);
            }, false);

            console.log('subscribe-dashboard, filter:' + queryFilter);
            socketChangeHandler = dashboard.onChange.bind(dashboard);
            socket.on('changes-dashboard', socketChangeHandler);
            socket.emit('subscribe-dashboard', {filter: queryFilter});
        }

        // init
        onQueryFilterChange();
    }

    function DispatcherController(container, templatesContainer, data) {
        //jshint unused:vars

        var l = null, p = null;

        this.onChange = function(...data) {
            if(data[0][0] === 'p')
                p = '<ol>' + data.map(item=>'<li><pre>'+JSON.stringify(item, null, 2)+'</pre></li>').join('\n') + '</ul>';
            else l = data;
            container.innerHTML = [l,p].join('<br />');
        };
    }
    function initDispatcher(data) {
        var container = activateTemplate('dispatcher-interface')
         , templatesContainer = getTemplatesContainer('dispatcher-templates')
         , socket = socketio('/')
         , dispatcher = new DispatcherController(container, templatesContainer, data)
         ;
        socket.on('changes-dispatcher-list', dispatcher.onChange.bind(dispatcher));
        socket.on('changes-dispatcher-process', dispatcher.onChange.bind(dispatcher));
        socket.emit('subscribe-dispatcher-list', {});
        socket.emit('subscribe-dispatcher-process', {
                    processId: '892fd622-acc2-41c7-b3cb-a9e60f889b09'
        });
    }

    function getInterfaceMode() {
        var data = null
          , defaultMode = 'drag-and-drop'
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
              , status: _initStatusInterface
              , 'status-report': function(){} // No action, is server side rendered.
              , 'collection-report': initCollectionReportInterface
              , 'drag-and-drop': initDNDSendingInterface
              , 'dashboard': initDashboard
              , 'dispatcher': initDispatcher
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

    var ignoreNextPopState = false;// bad hack;
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
        window.onpopstate = function(event) {
            // jshint unused:vars
            if(ignoreNextPopState) {
                ignoreNextPopState = false;
                event.preventDefault();
                return;
            }
            window.location.reload();
        };
    };
});
