"use strict";
/* jshint esnext:true, node:true*/

const { Any } = require('google-protobuf/google/protobuf/any_pb.js');

function ProtobufAnyHandler(knownTypes, typesNamespace) {
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
    this._logging.debug('Unknown message type', message);
    throw new Error('Can\'t find type name for message');
};

_p.getTypeForTypeName = function(typeName) {
    var name = typeName.split('.').pop();
    if(name in this._knownTypes)
        return this._knownTypes[name];
    this._logging.debug('Unknown type name ', typeName);
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


exports.ProtobufAnyHandler = ProtobufAnyHandler;
