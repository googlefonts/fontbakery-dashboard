define([], function() {
    // this only works for objects that can also be defined in JSON:
    // string, number, object, array, true, false, null
    // where `object` must be vanilla js objects no types etc.
    function isEqual(a, b) {
        var i, l, k;
        if(a === b)
            return true;
        if(a instanceof Array) {
            if(!(b instanceof Array))
                return false;
            if(a.length != b.length)
                return false;
            for(i=0,l=a.length;i<l;i++) {
                if(!isEqual(a[i], b[i]))
                    return false;
            }
            return true;
        }
        // typeof null > 'object'
        if(a === null || b === null)
            return false;
        if(typeof a === 'object') {
            if(typeof b !== 'object')
                return false;
            for(k in a) {
                if(!(k in b))
                    return false;
                if(!isEqual(a[k], b[k]))
                    return false;
            }
            return true;
        }
        return false;
    };
    return isEqual;
});
