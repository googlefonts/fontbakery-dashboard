define([
    'marked'
], function(
    marked
){
    "use strict";
    /*global document*/

    function ValueError(message) {
        this.name = 'ValueError';
        this.message = message || '(No message for ValueError)';
        this.stack = (new Error()).stack;
    }
    ValueError.prototype = Object.create(Error.prototype);
    ValueError.prototype.constructor = ValueError;


    function appendChildren(elem, contents, cloneChildNodes) {
        var _contents, i, l, child;
        if(contents === undefined || contents === null)
            _contents = [];
        else
            _contents = contents instanceof Array ? contents : [contents];
        for(i=0,l=_contents.length;i<l;i++) {
            child = _contents[i];
            if(!child || typeof child.nodeType !== 'number')
                child = createTextNode(child);
            else if(cloneChildNodes)
                child = child.cloneNode(true);//always a deep clone
            elem.appendChild(child);
        }
    }

    function createTextNode(text) {
        return document.createTextNode(text);
    }

    function createElement(tagname, attr, contents, cloneChildNodes) {
        var elem = document.createElement(tagname)
          , k
          ;

        if(attr) for(k in attr)
            elem.setAttribute(k, attr[k]);

        appendChildren(elem, contents, cloneChildNodes);
        return elem;
    }

    function createChildElement(parent, tagname, attr, contents, cloneChildNodes) {
        var elem = createElement(tagname, attr, contents, cloneChildNodes);
        parent.appendChild(elem);
        return elem;
    }

    function createElementfromHTML(tag, attr, innerHTMl) {
        var element = createElement(tag, attr);
        element.innerHTML = innerHTMl;
        return element;
    }

    function createElementfromMarkdown(tag, attr, mardownText) {
        return createElementfromHTML(tag, attr, marked(mardownText, {gfd: true}));
    }

    function appendHTML(elem, html) {
        var parsed = createElementfromHTML('div', null, html);
        while(parsed.firstChild)
            elem.appendChild(parsed.firstChild);

    }

    function appendMarkdown(elem, markdown) {
        appendHTML(elem, marked(markdown, {gfd: true}));
    }

    function createFragmentFromHTML(html) {
        var frag = document.createDocumentFragment();
        appendHTML(frag, html);
        return frag;
    }

    function createFragment(contents, cloneChildNodes) {
        var frag = document.createDocumentFragment();
        appendChildren(frag, contents, cloneChildNodes);
        return frag;
    }

    function createComment(text) {
        return document.createComment(text);
    }

    function isDOMElement(node) {
        return node && node.nodeType && node.nodeType === 1;
    }

    function replaceNode(newNode, oldNode) {
        if(oldNode.parentNode) // replace has no effect if oldNode has no place
            oldNode.parentNode.replaceChild(newNode, oldNode);
    }

    function removeNode(node) {
        if(node.parentNode)
            node.parentNode.removeChild(node);
    }

    function insertBefore(newElement, referenceElement) {
        if(referenceElement.parentElement && newElement !== referenceElement)
            referenceElement.parentElement.insertBefore(newElement
                                                      , referenceElement);
    }

    function insertAfter(newElement, referenceElement) {
        // there is no element.insertAfter() in the DOM
        if(!referenceElement.nextSibling)
            referenceElement.parentElement.appendChild(newElement);
        else
            insertBefore(newElement, referenceElement.nextSibling);
    }

    function insert(element, position, child) {
        switch(position) {
            case 'append':
                element.appendChild(child);
                break;
            case 'prepend':
                if(element.firstChild)
                    insertBefore(child, element.firstChild);
                else
                    element.appendChild(child);
                break;
            case 'before':
                insertBefore(child, element);
                break;
            case 'after':
                insertAfter(child, element);
                break;
            default:
                throw new ValueError('Unknown position keyword "'+position+'".');
        }
    }

    function getChildElementForSelector(element, klass, deep) {

        var elements = Array.prototype.slice
                            .call(element.querySelectorAll(klass));
        if(!deep)
            // I don't know an easier way to only allow
            // direct children.
            elements = elements.filter(function(elem) {
                                return elem.parentNode === element;});
        return elements[0] || null;
    }

    function getMarkerComment(element, marker) {
        var frames = [[element && element.childNodes, 0]]
          , frame, nodelist, i, l, childNode
          ;
        main:
        while((frame = frames.pop()) !== undefined){
            nodelist = frame[0];
            for(i=frame[1],l=nodelist.length;i<l;i++) {
                childNode = nodelist[i];
                if(childNode.nodeType === 8 //Node.COMMENT_NODE == 8
                           && childNode.textContent.trim() === marker) {
                    return childNode;
                }
                if(childNode.nodeType === 1) { //Node.ELEMEMT_NODE == 1
                    frames.push([nodelist, i+1]);
                    frames.push([childNode.childNodes, 0]);
                    break;
                }
            }
        }
        return null;
    }

    function insertAtMarkerComment(element, marker, child, fallbackPosition) {
        var found = getMarkerComment(element, marker);
        if(found)
            insert(found, 'after', child);
        else if (fallbackPosition !== false)
            // undefined defaults to append
            insert(element, fallbackPosition || 'append', child);
        else
            throw new Error('Marker <!-- '+marker+' --> not found');
    }

    function clear(elem) {
        while(elem.lastChild)
            removeNode(elem.lastChild);
    }

    function validateChildEvent(event, stopElement, searchAttribute) {
        var elem = event.target;
        if(event.defaultPrevented) return;
        while(true) {
            if(elem === stopElement.parentElement || !elem)
                return;
            if(elem.hasAttribute(searchAttribute))
                // found!
                break;
            elem = elem.parentElement;
        }
        event.preventDefault();
        return elem.getAttribute(searchAttribute);
    }

    return {
        createElement: createElement
      , createChildElement: createChildElement
      , createElementfromHTML: createElementfromHTML
      , createElementfromMarkdown: createElementfromMarkdown
      , createTextNode: createTextNode
      , appendChildren: appendChildren
      , appendHTML: appendHTML
      , appendMarkdown: appendMarkdown
      , createFragment: createFragment
      , createComment: createComment
      , createFragmentFromHTML: createFragmentFromHTML
      , isDOMElement: isDOMElement
      , replaceNode: replaceNode
      , removeNode: removeNode
      , insert: insert
      , insertAfter: insertAfter
      , insertBefore: insertBefore
      , getChildElementForSelector: getChildElementForSelector
      , getMarkerComment: getMarkerComment
      , insertAtMarkerComment: insertAtMarkerComment
      , clear: clear
      , validateChildEvent: validateChildEvent
      , ValueError: ValueError
    };
});
