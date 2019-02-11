"use strict";
/* jshint esnext:true, node:true*/

const { Any } = require('google-protobuf/google/protobuf/any_pb.js')
    , FONT_BAKERY_TYPES_NAMESPACE = 'fontbakery.dashboard'
    ;

function ProtobufAnyHandler(logging, knownTypes, typesNamespace=FONT_BAKERY_TYPES_NAMESPACE) {
    this._log = logging;
    this._knownTypes = knownTypes || {};
    this._typesNamespace = typesNamespace && typesNamespace.slice(-1) === '.'
                ? typesNamespace.slice(0, -1)
                : typesNamespace
                ;
}

const _p = ProtobufAnyHandler.prototype;

_p.getTypeNameForMessage = function(message) {
    var name;
    for(name in this._knownTypes)
        if(message instanceof this._knownTypes[name])
            return [this._typesNamespace, name].join('.');
    this._log.debug('Unknown message type', message);
    throw new Error('Can\'t find type name for message');
};

_p.getTypeForTypeName = function(typeName) {
    var name = typeName.split('.').pop();
    if(name in this._knownTypes)
        return this._knownTypes[name];
    this._log.debug('Unknown type name ', typeName, 'known types are:'
                    , Object.keys(this._knownTypes).join(', '));
    throw new Error('Can\'t find type for type name,');
};

_p.pack = function(message) {
    var any = new Any()
      , typeName = this.getTypeNameForMessage(message) // e.g. 'fontbakery.dashboard.Files'
      ;
    any.pack(message.serializeBinary(), typeName);
    return any;
};

_p.unpack = function(any) {
    var typeName = any.getTypeName()
      , Type = this.getTypeForTypeName(typeName)
      , message = any.unpack(Type.deserializeBinary, typeName)
      ;
    return message;
};


///// pack and unpack are just simple wrappers. /////

/**
 * The main case for pack is to default add FONT_BAKERY_TYPES_NAMESPACE
 * as the default `typesNamespace` argument.
 */
function pack(message, typeName, typesNamespace=FONT_BAKERY_TYPES_NAMESPACE) {
    var any = new Any()
      , typesNamespace_ = typesNamespace && typesNamespace.slice(-1) === '.'
                ? typesNamespace.slice(0, -1)
                : typesNamespace
      , fullTypeName = [typesNamespace_, typeName].join('.')
      ;
    return any.pack(message.serializeBinary(), fullTypeName);
}

/**
 * The main usage of unpack is to be better readable than
 *      `Type.deserializeBinary(any.getValue_asU8());`
 * If typeName is set it returns null in case of a missmatch.
 */
function unpack(any, Type, typeName /*optional*/) {
        // In any.unpack: `if (this.getTypeName() == name) {` WHY???
        // This still is just hope based, that Type.deserializeBinary
        // can load the value. Without that name detour, this is the
        // implementation:
        //      `Type.deserializeBinary(any.getValue_asU8());`
        // So, if we expect a type, it suggests that we should know
        // the name of the type, but that's no real validation, since
        // the name comes along with the data and is thus just user input
        // as well. We got to trust that the data can be parsed with Type.
        // In conclusion, if we know what data to expect, we don't have
        // to use Any, it's just that the added TypeName is a nice
        // documentation and may be useful for debugging.
    var typeName_ = typeName || any.getTypeName()
      , message = any.unpack(Type.deserializeBinary, typeName_)
      ;
    return message;
}

exports.unpack = unpack;
exports.pack = pack;

exports.ProtobufAnyHandler = ProtobufAnyHandler;
