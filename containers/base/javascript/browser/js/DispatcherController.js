define([
    'dom-tool'
], function(
    dom
) {
    /* jshint browser:true, esnext:true, devel: true*/ //  esnext:true TEMPORAY ???
    "use strict";
    function DispatcherController(container, templatesContainer, socket, data) {
        //jshint unused:vars

        this._session = null;
        this._listElem = dom.createElement('div');
        this._processElem = dom.createElement('p');
        dom.appendChildren(container, [this._l, this._processElem]);

        // we should also run this when the login status changes, so that
        // forms can be enabled/disabled if the user is authorized to
        // send them. But, the server should probably decide what the
        // user is authorized to do, not the client.
        // It will eventually be a list of roles for each UI and a list
        // of roles for the user (maybe that list is different on a per
        // process base, i.e. a meta-role like: project-owner is only
        // attached to a user, if he is project owner...
        this._lastProcessData = null;
        this._socket = socket;
        this._subscribedProcessIds = new Set();

        socket.on('changes-dispatcher-process', this.onChangeProcess.bind(this));

        //var countList = 0;
        //this.onChangeList = function(data) {
        //    this._listElem.innerHTML = data;
        //    countList += 1;
        //    if(countList === 3)
        //        socket.emit('unsubscribe-dispatcher-list', {});
        //};
        // socket.on('changes-dispatcher-list', this.onChangeList.bind(this));
        // socket.emit('subscribe-dispatcher-list', {});

        socket.emit('initializing-ui-dispatcher-process', null, (uiDescription, error)=>{
            if(error)
                console.error('error initializing-ui-dispatcher-process:', error);
            else
                this.onInitializingUI([uiDescription]);
        });

        // To test if it loads (seserializes) well
        //onInitAnswer('b56d226d-8333-41e1-80da-ad973b8ab0c6', null)
        // finished: onInitAnswer('a9963e5b-b3fc-4b2d-9199-1856fa666e6f', null);

        container.addEventListener('destroy', (e)=>{
            console.log('OH, Hey!, the destroy event got received by DispatcherController');
            socket.emit('unsubscribe-dispatcher-list');

            for(let processId of this._subscribedProcessIds)
                socket.emit('unsubscribe-dispatcher-process', {
                    processId: processId
                });
        }, false);
    }
    var _p = DispatcherController.prototype;

    _p.onChangeProcess = function(...data) {
        this._lastProcessData = data;
        console.log('onChangeProcess', ...data);
        var [message, processId, processState, uiDescriptions, isInit] = data;
        this._renderProcess(processId, message, processState, uiDescriptions, isInit);

    };

    _p.onInitializingUI = function(...data) {
        var [uiDescriptions] = data;
        this.onChangeProcess('…initializing', 'N/A', null, uiDescriptions, true);
    };

    _p._renderProcess = function(processId, message, processState, uiDescriptions, isInit) {
        var uis, process, ol;
        uis = uiDescriptions
                    ? dom.createFragment(uiDescriptions.map(ui=>this._createUserInteraction(processId, ui, isInit)))
                    : '<- NO USER INTERACTIONS ->'
                    ;
        process = processState
                    ? dom.createElement('pre', {}, JSON.stringify(processState, null, 2))
                    : '<- NO PROCESS STATE ->'
                    ;
        ol = dom.createElement('ol', {}, [
            dom.createElement('li', {}, message +' processId: ' +  processId)
          , dom.createElement('li', {}, uis)
          , dom.createElement('li', {}, process)
        ]);
        dom.clear(this._processElem);
        dom.appendChildren(this._processElem, ol);
    };

    _p.sessionChangeHandler = function(session) {
        this._session = session;
        if(this._lastProcessData)
            this.onChangeProcess(...this._lastProcessData);
    };

    _p._createUserInteraction = function(processId, description, isInit) {
        // use if client is not authorized to send the form
        var disabled = !this._session || this._session.status !== 'OK'// FIXME: currently only checking if there's a session at all
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

    _p._uiLabel = function(description, element) {
        var label = description.label
                ? dom.createElement('label', {}, [
                      dom.createElement('strong', {}, description.label)
                    , ' '
                    , element
                  ])
                : element
                ;
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

    _p._uiMakeBinary = function(description, disabled) {
        // jshint: unused:vars
        var input = dom.createElement('input', {type: 'checkbox'});
        if(description.default)
            input.checked = true;
        if(disabled) input.disabled = true;
        return this._uiLabel(description, input);
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
                case('binary'):
                    value = this._uiGetBinary(uiField, input);
                    break;
                case('send'):
                    // seems like there's no good way to figure if
                    // a send button was used and which.
                    value = null;
            }
        return value;
    };

    _p._collectUiValues = function(description, inputs) {
        var values = {}
          , uiField, input, key
          ;
        for (let i=0,l=description.ui.length;i<l;i++) {
            uiField = description.ui[i];
            input = inputs[i];
            if('condition' in uiField)
                continue;
            // falling back to index as a key
            key = '' + ('name' in uiField ? uiField.name : i);
            values[key] = this._getValue(uiField, input);
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
            values[key] = this._getValue(uiField, input);
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

        console.log('_sendExecute sending', commandData);

        this._socket.emit(
            'execute-dispatcher-process'
          , this._session.sessionId || null
          , commandData
          , function(result, error) {
                if(error)
                    console.error('execute back channel error:', error);
                else
                    console.log('execute back channel answer:', result);
            }
        );
    };

    _p._onInitProcessAnswer = function(processId, error) {
        if(error)
            console.error('error init-dispatcher-process:', error);
        else {
            console.log('answer init-dispatcher-process:', processId);
            // now, listen to it
            this._subscribedProcessIds.add(processId);
            this._socket.emit('subscribe-dispatcher-process', {
                processId: processId
            });
        }
    };

    _p._sendInitProcess = function(description, values) {
        var data = {
            payload: values
        };

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
