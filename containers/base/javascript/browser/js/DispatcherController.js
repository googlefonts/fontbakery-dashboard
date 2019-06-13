define([
    'dom-tool'
  , 'UserLog'
], function(
    dom
  , UserLog
) {
    /* jshint browser:true, esnext:true, devel: true*/ //  esnext:true TEMPORAY ???
    "use strict";
    function DispatcherController(container, templatesContainer, socket, data) {
        //jshint unused:vars
        this._container = container;
        this._templatesContainer = templatesContainer;

        this._session = null;
        this._log = new UserLog(dom.createElement('ol', {class: 'user-log'}));

        // we should also run this when the login status changes, so that
        // forms can be enabled/disabled if the user is authorized to
        // send them. But, the server should probably decide what the
        // user is authorized to do, not the client.
        // It will eventually be a list of roles for each UI and a list
        // of roles for the user (maybe that list is different on a per
        // process base, i.e. a meta-role like: project-owner is only
        // attached to a user, if he is project owner...
        this._currentProcessListener = null;
        this._currentProcessLastData = null;

        this._socket = socket;

        //var countList = 0;
        //this.onChangeList = function(data) {
        //    this._listElem.innerHTML = data;
        //    countList += 1;
        //    if(countList === 3)
        //        socket.emit('unsubscribe-dispatcher-list', {});
        //};
        // socket.on('changes-dispatcher-list', this.onChangeList.bind(this));
        // socket.emit('subscribe-dispatcher-list', {});

        if(data && data.id)
            this._showProcess(data.id);
        else {
            socket.emit('initializing-ui-dispatcher-process', null, (uiDescription, error)=>{
                if(error)
                    this._log.error('error initializing-ui-dispatcher-process:', error);
                else
                    this.onInitializingUI([uiDescription]);
            });
        }

        // To test if it loads (seserializes) well
        //onInitAnswer('b56d226d-8333-41e1-80da-ad973b8ab0c6', null)
        // finished: onInitAnswer('a9963e5b-b3fc-4b2d-9199-1856fa666e6f', null);

        container.addEventListener('destroy', (e)=>{
            this._log.info('OH, Hey!, the destroy event got received by DispatcherController');
            socket.emit('unsubscribe-dispatcher-list');
        }, false);
    }
    var _p = DispatcherController.prototype;


    _p._getElementFromTemplate = function(className) {
        var template = this._templatesContainer.getElementsByClassName(className)[0];
        return template.cloneNode(true);
    };

    _p._clearContainer = function() {
        dom.clear(this._container, 'destroy');
    };

    _p._showProcess = function(processId) {
        var processElem = dom.createElement('div')
          , listener = this._onChangeProcess.bind(this, processElem)
          , subscriptionRequest = 'subscribe-dispatcher-process'
          , subscribe = null
          , reconnectHandler = (attemptNumber) => {
              if(subscribe === null) return;
              console.log('socket on reconnect', '#'+attemptNumber+':', subscriptionRequest);
              subscribe();
            }
          , destructor = (e)=>{
                //jshint unused:vars
                this._currentProcessListener = null;
                this._currentProcessLastData = null;

                this._container.removeEventListener('destroy', destructor, false);
                this._log.info('OH, Hey!, the destroy event got received');

                this._socket.off('changes-dispatcher-process', listener);
                if(processId) {
                    subscribe = null;
                    this._socket.off('reconnect', reconnectHandler);
                    this._socket.emit('unsubscribe-dispatcher-process', {
                        processId: processId
                    });
                }
            }
          ;

        this._clearContainer();
        this._currentProcessListener = listener;
        this._currentProcessLastData = null;

        dom.appendChildren(this._container, [this._log.container, processElem]);
        this._log.reatached();

        this._socket.on('changes-dispatcher-process', listener);
        this._container.addEventListener('destroy', destructor, false);
        processElem.addEventListener('destroy', destructor, false);
        if(processId) {
            this._socket.on('reconnect', reconnectHandler);
            subscribe = ()=>this._socket.emit(subscriptionRequest
                                                , { processId: processId});
            subscribe();
        }
    };

    _p.onInitializingUI = function(...data) {
        var [uiDescriptions] = data;
        this._showProcess(null);
        this._currentProcessListener('N/A', null, uiDescriptions, true);
    };


    _p._showThankYou = function(processId, processUrl) {
        var element = this._getElementFromTemplate('thank-you')
          , linkElement = dom.createElement('input', {
                'class':'link'
              , type: 'text'
              , value: processUrl
              , readonly: 'readonly'
            })
          , closeButton = dom.createElement('button', {}, 'OK')
          ;

        // select all text on click
        linkElement.addEventListener('click', linkElement.select);
        closeButton.addEventListener('click', this._showProcess.bind(this, processId));
        dom.insertAtMarkerComment(element, 'insert link', linkElement, false);
        dom.insertAtMarkerComment(element, 'insert close button', closeButton, false);

        this._clearContainer();
        this._container.appendChild(element);
    };

    _p._onChangeProcess = function(processElem, ...data) {
        this._currentProcessLastData = data;
        this._log.info('onChangeProcess', data[0]);
        console.log('onChangeProcess', ...data);
        var [processId, processState, uiDescriptions, isInit] = data;
        this._renderProcess(processElem, processId, processState, uiDescriptions, isInit);
    };

    _p._createUserInteractions = function(uiDescriptions, isInit, pathParts) {
        var targetPath = pathParts.join('/')
          , processId = pathParts[0]
          , userInterfaces = dom.createFragment()
          , descriptions = uiDescriptions.get(targetPath) || []
          ;
        for(let ui of descriptions)
            userInterfaces.appendChild(this._createUserInteraction(processId, ui, isInit));
        return userInterfaces;
    };

    _p._statusMakeValue = function(value) {
        return typeof value === 'string'
                    ? dom.createElement('span', {}, value)
                    : dom.createElement('span', {class: 'inline-preformated'}, JSON.stringify(value, null, 2))
                    ;
    };

    _p._statusMakeKeyValue = function(key, value) {
        var children = [
                dom.createElement('strong', {}, key)
              , ' '
              , this._statusMakeValue(value)
        ];
        return dom.createFragment(children);
    };

    _p._statusMakeTextNode = function (key, value) {
        //jshint unused: vars
        return dom.createTextNode(value);
    };

    _p._statusMakeStatusEntry = function(tag, key, statusEntry) {
        //jshint unused:vars
        var children = [
            dom.createElement('em', {}, statusEntry.created)
              , '—'
        ];
        if(statusEntry.status !== 'LOG')
            children.push(dom.createElement('strong', {class: 'status-name'}
                                                , [statusEntry.status]), ':');

        if(statusEntry.details)
            children.push(' ', dom.createElementfromMarkdown('div', {class: 'markdown'}, statusEntry.details));

        if(statusEntry.data)
            children.push('with data:', this._statusMakeValue(statusEntry.data));

        return dom.createElement(tag
                  , {
                        class: 'status-code ' + statusEntry.status
                      , title: statusEntry.status  + ' ' + statusEntry.created
                    }, children);
    };

    _p._statusMakeStatusEntries = function(key, statusEntries) {
        // jshint unused: vars
        var children = [];
        for(let statusEntry of statusEntries)
            children.push(this._statusMakeStatusEntry('li', null, statusEntry));
        return dom.createElement('ul', {class: 'task-history'}, children);
    };

    _p._statusMakeTask = function(uiDescriptions, isInit, processId, stepKey, tasKey, task) {
        var renderers = {
                'created': this._statusMakeTextNode // "2018-12-20T17:31:08.472Z"
              , 'history': this._statusMakeStatusEntries // [
                           //     {
                           //         "status": "PENDING",
                           //         "details": "*initial state*",
                           //         "created": "2018-12-20T17:31:08.474Z",
                           //         "data": null
                           //     },
                           //     ...
                           // ]
                           // for debugging `private` could be interesting.
                           // maybe in an expandable box.
              , 'private': this._statusMakeKeyValue//  null
              , '@default': this._statusMakeKeyValue
            }
          , order = []
          , target = this._getElementFromTemplate('task')
          , userInterfaces = this._createUserInteractions(uiDescriptions, isInit, [processId, stepKey, tasKey])
          ;
        dom.insertAtMarkerComment(target, 'insert: task-key'
                                            , dom.createTextNode(tasKey));
        dom.insertAtMarkerComment(target, 'insert: user-interfaces', userInterfaces);
        this._renderDOMToTarget(target, renderers, order, task);


        // FIXME
        // dom.insertAtMarkerComment(target, 'insert: user-interfaces', uis);

        return target;
    };

    _p._statusMakeTasks = function(uiDescriptions, isInit, processId, stepKey, key, tasks) {
        var children = [];
        for(let [taskKey, task] of tasks)
            children.push(this._statusMakeTask(uiDescriptions, isInit, processId, stepKey, taskKey, task));
        return dom.createFragment(children);
    };

    _p._statusMakeStep = function(uiDescriptions, isInit, processId, stepKey, step) {
        //jshint unused: vars
        var stepKey2Path = {failStep: 'fail', finallyStep: 'finally'}
          , stepPathKey = stepKey2Path[stepKey] || stepKey
          , renderers = {
                'tasks': this._statusMakeTasks.bind(this, uiDescriptions, isInit, processId, stepPathKey)
              , 'isActivated': null// done via css
              , 'finishedStatus': this._statusMakeStatusEntry.bind(this, 'div')// same as in task.history, but should also be a indicator
              , '@default': this._statusMakeKeyValue
            }
          , order = []
          , target = this._getElementFromTemplate('step')
          , userInterfaces = this._createUserInteractions(uiDescriptions, isInit, [processId, stepPathKey])
          ;
        dom.insertAtMarkerComment(target, 'insert: step-key'
                                            , dom.createTextNode(stepKey));
        dom.insertAtMarkerComment(target, 'insert: user-interfaces', userInterfaces);
        this._renderDOMToTarget(target, renderers, order, step);


        if(step.isActivated)
            target.classList.add('activated');
        if(step.finishedStatus)
            target.classList.add('finished', step.finishedStatus.status);
        if(step.isActivated && !step.finishedStatus)
            // there's always only one active step at a time
            target.classList.add('active');

        var header = target.getElementsByClassName('header')[0];
        header.addEventListener('click', function(event) {
            target.classList.toggle('opened');
            if(target.classList.contains('opened'))
                target.scrollIntoView();
        } ,false);

        return target;
    };

    _p._statusMakeSteps = function(uiDescriptions, isInit, processId, key, steps) {
        var children = [];
        for(let [index, step] of steps.entries())
            children.push(this._statusMakeStep(uiDescriptions, isInit
                                        , processId, index + '', step));
        return dom.createFragment(children);
    };

    _p._renderDOMToTarget = function(target, renderers, order, processState) {
        var seen = new Set()
          , elements = {}
          ;
        for(let [key, value] of Object.entries(processState || {})) {
            if(!value)
                // Skip empty values for now, it could be annoying.
                // Always a good idea? => no!
                // FIXME: this should be much more reasonable.
                if(typeof value !== 'boolean')
                    continue;
            let renderer = key in renderers
                        ? renderers[key]
                        : renderers['@default'];
            if(!renderer)
                // skipped with intend -> the key is defined but the
                // value is falsy.
                continue;
            elements[key] = renderer.call(this, key, value);
        }

        // don't check if defaultMarker is there, rather fail if it is not.
        var defaultMarker = dom.getMarkerComment(target, 'insert: @default');
        for(let key of (order || []).concat(Object.keys(elements))) {
            if(seen.has(key) || !(key in elements))
                continue;
            seen.add(key);
            let item = elements[key]
              , marker = dom.getMarkerComment(target, 'insert: ' + key)
              ;
            if(marker)
                // first try to put it into the template at marker
                dom.insert(marker, 'after', item);
            else {
                // Fallback into the special default list "before" to keep
                // the order in tact, but first wrap...
                item = dom.createElement('li', {}, item);
                dom.insert(defaultMarker, 'before', item);
            }
        }
        return target;
    };

    _p._uiDescriptionsToMap = function(uiDescriptions) {
        var result = new Map();
        for(let ui of (uiDescriptions || [])) {
            let uis = result.get(ui.targetPath);
            if(!uis){
                uis = [];
                result.set(ui.targetPath, uis);
            }
            uis.push(ui);
        }
        return result;
    };

    _p._statusMakeExecLog = function(key, logs){
        /*
         * logs =  [
         *    [
         *      "2018-12-21T07:09:59.084Z",
         *      {
         *        "requester": "graphicore",
         *        "step": "0",
         *        "task": "ApproveProcess",
         *        "callback": "callbackApproveProcess"
         *      }
         *    ],
         *    ...
         * ]
         */
        var children = [];
        for(let [date, log] of logs) {
            let entry = dom.createElement('li', {}, [
                dom.createElement('em', {}, date)
              , '—'
              , dom.createElement('strong', {}, log.requester)
              , ' called: '
              , dom.createElement('span', {},
                        [ ['.', log.step, log.task].join('/')
                        , '::'
                        , log.callback
                        ])
            ]);
            children.push(entry);
        }
        return dom.createFragment([
            dom.createElement('strong', {}, key)
          , dom.createElement('ul', {}, children)
        ]);
    };

    _p._statusMakeMarkdown = function(key, note) {
        return dom.createFragment([
            dom.createElement('strong', {}, key)
            , ' '
          , dom.createFragmentFromMarkdown(note)
        ]);
    };

    _p._renderProcess = function(processElem, processId, processState, uiDescriptions, isInit) {
        // "familyName": "ABeeZee",
        // "requester": "graphicore",
        // "initType": "update",
        // "genre": "",
        // "fontfilesPrefix": "",
        // "note": "",
        // "id": "19f4da1f-53a2-47c5-b9a1-c0056b99d61b",
        // "created": "2018-12-20T17:31:08.471Z",
        // "finishedStatus": null,
        // "execLog": [ ... ]
        // "steps": [...]
        // failStep: ...
        // finallyStep: ...
        //
        // these will be rendered differently
        // they are also more like infrastructure data, while the
        // other keys are special for our concrete implementation.
        var _uiDescriptionsMap = !isInit ? this._uiDescriptionsToMap(uiDescriptions) : null
          , renderers = {
            // generic/infrastructure elements
            //   'id':
            // , 'created':
               'finishedStatus': this._statusMakeStatusEntry.bind(this, 'div')
              , 'execLog': this._statusMakeExecLog
              , 'steps': this._statusMakeSteps.bind(this, _uiDescriptionsMap, isInit, processId)
              , 'failStep': this._statusMakeStep.bind(this, _uiDescriptionsMap, isInit, processId)
              , 'finallyStep': this._statusMakeStep.bind(this, _uiDescriptionsMap, isInit, processId)
                // specific/data elements
              , 'familyName': this._statusMakeTextNode
            //, 'requester':
              , 'note': this._statusMakeMarkdown
            //, 'initType':
            //, 'genre':
            //, 'fontfilesPrefix':
                // we'll be able to render elements in the future
                // that we don't know about yet.
              , '@default': this._statusMakeKeyValue
            }
                // only, in order, elements that must be inserted before
                // everything else.
          , order = ['id', 'created', 'initType', 'requester', 'genre'
                        , 'repoNameWithOwner', 'fontfilesPrefix', 'note']
          , target = this._getElementFromTemplate(isInit
                                                ? 'dispatcher-process-init'
                                                : 'dispatcher-process')
          ;

        dom.clear(processElem);

        if(!isInit) {

            dom.insertAtMarkerComment(target, 'insert: process-style'
                    , dom.createTextNode(processState.initType === 'update' ? 'Update' : 'Onboard'));

            this._renderDOMToTarget(target, renderers, order, processState);
            dom.insertAtMarkerComment(target, 'insert: process-link', dom.createElement(
                               'a'
                             , {href: '/dispatcher/process/'+ processId}
                             , ' Process ID: ' +  processId
                            ));
            if(processState.finishedStatus)
                target.classList.add(processState.finishedStatus.status);
        }
        else {
            dom.insertAtMarkerComment(target, 'insert: message'
                                , dom.createElement('span', {}, 'initializing process …'));
            dom.insertAtMarkerComment(target, 'insert: user-interfaces',
                this._createUserInteraction(processId, uiDescriptions[0], isInit));
        }
        dom.appendChildren(processElem, [target]);
    };

    _p.sessionChangeHandler = function(session) {
        this._session = session;
        if(this._currentProcessListener && this._currentProcessLastData)
            this._currentProcessListener(...this._currentProcessLastData);
    };

    _p._createUserInteraction = function(processId, description, isInit) {
        // use if client is not authorized to send the form
        // FIXME: currently only checking if there's a session at all
        var disabled = !this._session || this._session.status !== 'OK'
          , form = dom.createElement('form')
          , uiElements = [], inputs = []
          , label, input, label_input
          , hasSend = false
          , i, l, uiField
          , named = {}, key
          ;

        // If any uiField has a key 'condition'
        // the value lools like [string name, value]
        // that means: show/use/submit this field only if
        // the value of the field named `name` has a value
        // identical to `value`.
        // Show: means display: none is removed from element.style
        // use/submit: means the value will not be in the result values
        // if the condition is false.
        // the condition is false either: if the `name` named field is
        // not shown or if the value doesn't match
        // I'm trying to shortcut "nested" conditions, to a point where
        // it is unpractical to use them. could be made more elaborate
        // in the future, with the added danger of defining circular/recursive
        // dependencies ...
        // the easiest right now is:
        // a field can't dependency on a field that has a condition itself.
        // thus, there's only one level dependencies possible.
        for (i=0,l=description.ui.length;i<l;i++) {
            uiField = description.ui[i];
            key = '' + ('name' in uiField ? uiField.name : i);
            switch(uiField.type) {
                case('choice'):
                    label_input = this._uiMakeChoice(uiField, disabled);
                    break;
                case('line'):
                    label_input = this._uiMakeLine(uiField, disabled);
                    break;
                case('text'):
                    label_input = this._uiMakeText(uiField, disabled);
                    break;
                case('info'):
                    label_input = this._uiMakeInfo(uiField, disabled);
                    break;
                case('binary'):
                    label_input = this._uiMakeBinary(uiField, disabled);
                    break;
                case('send'):
                    hasSend = true;
                    label_input = this._uiMakeSend(uiField, disabled);
                    break;
                default:
                    throw new Error('Not implemnted: this._uiMake{"'+uiField.type+'"}');
            }
            label = label_input[0];
            input = label_input[1];
            uiElements.push(label);
            inputs.push(input);
            named[key] = [uiField, label, input];
        }

        function change(uiField, input, value, target/*, event (not always!)*/) {
            // jshint validthis:true, unused:vars
            target.style.display = this._getValue(uiField, input) === value
                                        // visible
                                        ? null
                                        // invisible
                                        : 'none'
                                        ;
        }
        var conditionName, conditionValue, condition_uiField_Input
          , conditionUiField, conditionInput;
        for(key in named) {
            uiField = named[key][0];
            label = named[key][1];
            // input = named[key][2];
            if(!('condition' in uiField))
                continue;
            conditionName = uiField.condition[0];
            conditionValue = uiField.condition[1];
            condition_uiField_Input = named[conditionName];
            if(!condition_uiField_Input)
                // not found
                continue;
            conditionUiField = condition_uiField_Input[0];
            if('condition' in conditionUiField)
                // prevents deep and circular dependencies
                continue;

            conditionInput = condition_uiField_Input[2];
            // => add event listener
            // when value changes
            // show label if value matches
            // hide input if value mis-matches
            // also, run this right now as init
            conditionInput.addEventListener('change'
                    , change.bind(
                        this
                        , conditionUiField
                        , conditionInput
                        , conditionValue
                        , label)
                    , false);
            // aaand init
            change.call(this
                      , conditionUiField
                      , conditionInput
                      , conditionValue
                      , label);
        }

        if(!hasSend) {
            label_input = this._uiMakeSend({
                    type: 'send'
            });
            label = label_input[0];
            uiElements.push(label);
        }

        form.addEventListener("submit"
                , this._sendUI.bind(this, processId, description, inputs, isInit)
                , false);
        dom.appendChildren(form, uiElements);
        return form;
    };

    _p._uiLabel = function(description, element, before) {
        var label, children;
        if(description.label) {
            children = [
                  dom.createElement('strong', {}, description.label)
                , ' '
                , element
            ];
            if(before)
                // e.g. for checkboxes
                children.reverse();
            label = dom.createElement('label', {}, children);
        }
        else
            // so we put it actuallly into the dom
            // this is a bit problematic, since the caller
            // can't really expect to ge a label element back
            // maybe it would be better to just put the element
            // int an otherwise empty label
            label = element;
        return [label, element];
    };

    _p._uiMakeSend = function(description, disabled) {
        var button = dom.createElement('button', {}, description.text || 'Send!');
        if(disabled) button.disabled = true;
        return this._uiLabel(description, button);
    };

    _p._uiMakeChoice = function(description, disabled) {
        var defaultVal = 0
          , options = []
          , i, l, label, value, select
          ;
        for( i=0,l=description.options.length;i<l;i++) {
            if(description.options[i] instanceof Array) {
                label = description.options[i][0];
                value = description.options[i][1];
            }
            else
                label = value = description.options[i];
            // we don't roundtrip the value trough dom, it's to easy to
            // manipulate ;-)
            options.push(dom.createElement('option', {}, label));
            if(description.default === value || description.default === i)
                defaultVal = i;
        }
        select = dom.createElement('select', {}, options);
        select.selectedIndex = defaultVal;
        if(disabled) select.disabled = true;
        return this._uiLabel(description, select);
    };

    _p._uiGetChoice = function(description, input) {
        if(input.selectedIndex === -1)
            // nothing is selected
            return undefined;
        if(input.selectedIndex >= description.options.length)
            // DOM manipulation with the dev-tool?
            throw new Error('Unkown option selected!?');
        var option = description.options[input.selectedIndex];
        return (option instanceof Array) ? option[1] : option;
    };

    _p._uiMakeLine = function(description, disabled) {
        var input = dom.createElement('input', {
                type: 'text'
              , value: description.default || ''
              , placeholder: description.placeholder || ''
            });
        if(disabled) input.disabled = true;
        return this._uiLabel(description, input);
    };

    _p._uiGetLine = function(description, input) {
        return input.value;
    };

    _p._uiMakeText = function(description, disabled) {
        var input = dom.createElement('textarea', {
                placeholder: description.placeholder || ''
            });
        input.value = description.default || '';
        if(disabled) input.disabled = true;
        return this._uiLabel(description, input);
    };

    _p._uiGetText = function(description, input) {
        return input.value;
    };

    _p._uiMakeInfo =function(description, disabled) {
        // description could add classes like warn/caution info etc...
        var info = dom.createElementfromMarkdown(
                        'div', {class: 'info-field'}, description.content);
        if(disabled)
            info.classList.add('disabled');
        return [info, info];
    };

    _p._uiMakeBinary = function(description, disabled) {
        // jshint: unused:vars
        var input = dom.createElement('input', {type: 'checkbox'});
        if(description.default)
            input.checked = true;
        if(disabled) input.disabled = true;
        return this._uiLabel(description, input, true);
    };

    _p._uiGetBinary = function(description, input) {
        // jshint: unused:vars
        return !!input.checked;
    };

    _p._getValue = function(uiField, input) {
        var value;
        switch(uiField.type) {
                case('choice'):
                    value = this._uiGetChoice(uiField, input);
                    break;
                case('line'):
                    value = this._uiGetLine(uiField, input);
                    break;
                case('text'):
                    value = this._uiGetText(uiField, input);
                    break;
                case('binary'):
                    value = this._uiGetBinary(uiField, input);
                    break;
                case('send'):
                    // seems like there's no good way to figure if
                    // a send button was used and which.
                    value = null;
                    break;
                default:
                    value = null;
            }
        return value;
    };

    _p._collectUiValues = function(description, inputs) {
        var values = {}
          , uiField, input, key, value
          ;
        for (let i=0,l=description.ui.length;i<l;i++) {
            uiField = description.ui[i];
            input = inputs[i];
            if('condition' in uiField)
                continue;
            // falling back to index as a key
            key = '' + ('name' in uiField ? uiField.name : i);
            value = this._getValue(uiField, input);
            if(value !== null)
                values[key] = value;
        }

        var condition_name, condition_value
            // these don't have themselves conditions
          , allowedConditions = new Set(Object.keys(values))
          ;
        // second pass, not pretty but works, quick and dirty
        for (let i=0,l=description.ui.length;i<l;i++) {
            uiField = description.ui[i];
            input = inputs[i];
            if(!('condition' in uiField))
                continue;
            condition_name = uiField.condition[0];
            condition_value = uiField.condition[1];
            // yeah this is a quick an dirty hack
            // but good enough to just evaluate a single depth of conditions
            if(!allowedConditions.has(condition_name))
                // condition can't have a condition itself this way ;-)
                continue;
            if(values[condition_name] !== condition_value)
                continue;
            // falling back to index as a key
            key = '' + ('name' in uiField ? uiField.name : i);
            value = this._getValue(uiField, input);
            if(value !== null)
                values[key] = value;
        }
        return values;
    };

    _p._sendUI = function(processId, description, inputs, isInit, event) {
        event.preventDefault();
        var values = this._collectUiValues(description, inputs);

        if(isInit)
            this._sendInitProcess(description, values);
        else
            this._sendExecute(description, values);
    };

    _p._sendExecute = function(description, values) {
        var commandData = {
            // The result of `path.toString();` e.g.:
            //      "db205789-73e9-41a3-9d2d-45facd2290c5/0/DummyFeedback"
            //
            // Where the path data is:
            //  {
            //    processId: "db205789-73e9-41a3-9d2d-45facd2290c5",
            //    step: "0",
            //    task": "DummyFeedback"
            // }
            targetPath: description.targetPath
          , callbackName: description.callbackName // e.g. "callbackDummyUI"
          , ticket: description.ticket // e.g. "2018-11-08T22:06:10.945Z;4e812ae9d11b6e43c4d030260b0ba2f5c58bfd4554e5d053abc49dc83b14c3e6"
          , payload: values
        };

        this._log.info('_sendExecute');
        console.log('_sendExecute sending', commandData);

        this._socket.emit(
            'execute-dispatcher-process'
          , this._session.sessionId || null
          , commandData
          , function(result, error) {
                if(error)
                    this._log.errorMd('execute back channel error:', error);
                else
                    this._log.infoMd('execute back channel answer:', result);
            }.bind(this)
        );
    };

    _p._onInitProcessAnswer = function(processId, error) {
        if(error) {
            console.error('init-dispatcher-process', error);
            this._log.errorMd('init-dispatcher-process:', error);
            // TODO: This must be shown to the user, to help improving
            // the answers -> same as process back-channel. a simple
            // logging window should do.
            // The sent answers should relate to the form the user sees
            // and be understandable. We may have these attached to input
            // elements in the future, but for now the logging widget is
            // OK.
        }
        else {
            this._log.info('answer init-dispatcher-process:', processId);
            var url = location.origin
                      + '/dispatcher/process/' + encodeURIComponent(processId);
            // Show a thank you screen.
            this._showThankYou(processId, url);
            // and got to the process url (pushState)
            //          this state, with thank you screen and NO process
            //          interface is unique for this situation, there's
            //          no other way (e.g. via the URL) to get here. The
            //          reason for the url chnge is, that the user can
            //          share the link immediately.

            window.history.pushState(null, null, url);
            // From thank you screen, open the process interface and
            // subscribe to process when user confirms/clicks on
            // thank you screen.
        }
    };

    _p._sendInitProcess = function(description, values) {
        var data = {
            payload: values
        };

        this._log.info('_sendInitProcess');
        console.log('_sendInitProcess sending', data);

        this._socket.emit(
            'init-dispatcher-process'
          , this._session.sessionId || null
          , data
          , this._onInitProcessAnswer.bind(this)
        );
    };

    return DispatcherController;
});
