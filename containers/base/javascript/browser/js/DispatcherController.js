define([
    'dom-tool'
], function(
    dom
) {
    /* jshint browser:true, esnext:true, devel: true*/ //  esnext:true TEMPORAY ???
    "use strict";
        function DispatcherController(container, templatesContainer, socket, data) {
        //jshint unused:vars

        var l = dom.createElement('div')
          , p = dom.createElement('p')
          ;

        dom.appendChildren(container, [l, p]);

        this.onChangeProcess = function(...data) {
            console.log('onChangeProcess', ...data);
            var [stupidMsg, processId, processState, uiDescriptions] = data
              , ol
              ;

            ol = dom.createElement('ol', {}, [
                dom.createElement('li', {}, stupidMsg +' processId: ' +  processId)
              , dom.createElement('li', {}
                    , uiDescriptions
                        ? dom.createFragment(uiDescriptions.map(ui=>this._createUserInteraction(processId, ui)))
                        : '<- NO USER INTERACTIONS->'
                        )
              , dom.createElement('li', {}
                        , dom.createElement('pre', {}, JSON.stringify(processState, null, 2)))
            ]);
            dom.clear(p);
            dom.appendChildren(p, ol);
        };

        var countList = 0;
        this.onChangeList = function(data) {
            l.innerHTML = data;
            countList += 1;
            if(countList === 3)
                socket.emit('unsubscribe-dispatcher-list', {});
        };

        this._socket = socket;
        this._subscribedProcessIds = new Set();

        socket.on('changes-dispatcher-list', this.onChangeList.bind(this));
        socket.on('changes-dispatcher-process', this.onChangeProcess.bind(this));
        socket.emit('subscribe-dispatcher-list', {});


        var onInitAnswer = (processId, error)=>{
            if(error)
                console.error('error init-dispatcher-process:', error);
            else {
                console.log('answer init-dispatcher-process:', processId);
                // now, listen to it
                this._subscribedProcessIds.add(processId);
                socket.emit('subscribe-dispatcher-process', {
                    processId: processId
                });
            }
        };

        socket.emit('init-dispatcher-process', {
                familyName: '(unknown family)'
                // FIXME: figure how the server can do authentication
                // via socket.io. uiServer will need a authenticated
                // "requester"
            }, onInitAnswer
        );

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

    _p._createUserInteraction = function(processId, description) {

        var form = dom.createElement('form')
          , uiElements = [], inputs = []
          , label, input, label_input
          , hasSend = false
          , i, l, uiField
          ;
        for (i=0,l=description.ui.length;i<l;i++) {
            uiField = description.ui[i];
            switch(uiField.type){
                case('choice'):
                    label_input = this._uiMakeChoice(uiField);
                    break;
                case('line'):
                    label_input = this._uiMakeLine(uiField);
                    break;
                case('binary'):
                    label_input = this._uiMakeBinary(uiField);
                    break;
                case('send'):
                    hasSend = true;
                    label_input = this._uiMakeSend(uiField);
                    break;
                default:
                    throw new Error('Not implemnted: this._uiMake{"'+uiField.type+'"}');
            }
            label = label_input[0];
            input = label_input[1];
            uiElements.push(label);
            inputs.push(input);
        }

        if(!hasSend) {
            label_input = this._uiMakeSend({
                    type: 'send'
            });
            label = label_input[0];
            uiElements.push(label);
        }

        form.addEventListener("submit"
                , this._sendUI.bind(this, processId, description, inputs)
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

    _p._uiMakeSend = function(description) {
        var button = dom.createElement('button', {}, description.text || 'Send!');
        return this._uiLabel(description, button);
    };

    _p._uiMakeChoice = function(description) {
        var defaultVal = 0
          , options = []
          , i, l, label, value, select
          ;
        for( i=0,l=description.options.length;i<l;i++) {
            label = description.options[i][0];
            value = description.options[i][1];
            // we don't roundtrip the value trough dom, it's to easy to
            // manipulate ;-)
            options.push(dom.createElement('option', {}, label));
            if(description.default === value || description.default === i)
                defaultVal = i;
        }
        select = dom.createElement('select', {}, options);
        select.selectedIndex = defaultVal;
        return this._uiLabel(description, select);
    };

    _p._uiGetChoice = function(description, input) {
        if(!description.options[input.selectedIndex])
            throw new Error('Unkown option selected!?');
        return description.options[input.selectedIndex][1];
    };

    _p._uiMakeLine = function(description) {
        var input = dom.createElement('input', {
                type: 'text'
              , value: (description.default||'')
            });
        return this._uiLabel(description, input);
    };

    _p._uiGetLine = function(description, input) {
        return input.value;
    };

    _p._uiMakeBinary = function(description) {
        // jshint: unused:vars
        var input = dom.createElement('input', {type: 'checkbox'});
        if(description.default)
            input.checked = true;
        return this._uiLabel(description, input);
    };

    _p._uiGetBinary = function(description, input) {
        // jshint: unused:vars
        return !!input.checked;
    };

    _p._sendUI = function(processId, description, inputs, event) {
        event.preventDefault();

        var values = [], commandData;
        for (let i=0,l=description.ui.length;i<l;i++){
            let uiField = description.ui[i]
              , input = inputs[i]
              ;
            switch(uiField.type) {
                case('choice'):
                    values.push(this._uiGetChoice(uiField, input));
                    break;
                case('line'):
                    values.push(this._uiGetLine(uiField, input));
                    break;
                case('binary'):
                    values.push(this._uiGetBinary(uiField, input));
                    break;
                case('send'):
                    // seems like there's no good way to figure if
                    // a send button was used and which.
                    values.push(null);
            }
        }

        commandData = {
            // eg:
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

        console.log('_sendUI sending', commandData);

        this._socket.emit(
            'execute-dispatcher-process'
          , commandData
          , function(result, error) {
                if(error)
                    console.error('execute back channel error:', error);
                else
                    console.log('execute back channel answer:', result);
            }
        );
    };
    return DispatcherController;
});
