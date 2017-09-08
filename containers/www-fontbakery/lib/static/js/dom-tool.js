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
        if(_contents) for(i=0,l=_contents.length;i<l;i++) {
            child = _contents[i];
            if(typeof child.nodeType !== 'number')
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

    function isDOMElement(node) {
        return node && node.nodeType && node.nodeType === 1;
    }

    function replaceNode(newNode, oldNode){
        oldNode.parentNode.replaceChild(newNode, oldNode);
    }

    function removeNode(node){
        node.parentNode.removeChild(node);
    }

    function insertBefore(newElement, referenceElement) {
        referenceElement.parentElement.insertBefore(newElement, referenceElement);
    }

    function insertAfter(newElement, referenceElement) {
        // there is no element.insertAfter() in the DOM
        if(!referenceElement.nextSibling)
            referenceElement.parentElement.appendChild(newElement);
        insertBefore(newElement, referenceElement.nextSibling);
    }

    function insert(element, position, child) {
        switch(position) {
            case 'append':
                element.appendChild(child);
                break;
            case 'prepend':
                insertBefore(child, element.firstChild);
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

    function getChildElementForSelector(element, klass) {
        var elem = Array.prototype.slice
                            .call(element.querySelectorAll(klass))
                            // I don't know an easier way to only allow
                            // direct children.
                            .filter(function(elem) {
                                return elem.parentNode === element;})[0];
        return elem || null;
    }

    function getMarkerComment(element, marker) {
        var frames = [[element.childNodes, 0]]
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
                if(childNode.nodeType === 1) { //Node.ELEMEMT_NODE == 8
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
      , ValueError: ValueError
    };
});
