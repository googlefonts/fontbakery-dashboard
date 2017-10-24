// GENERATED CODE -- DO NOT EDIT!

'use strict';
var grpc = require('grpc');
var messages_pb = require('./messages_pb.js');
var google_protobuf_any_pb = require('google-protobuf/google/protobuf/any_pb.js');
var shared_pb = require('./shared_pb.js');

function serialize_fontbakery_dashboard_CacheItem(arg) {
  if (!(arg instanceof messages_pb.CacheItem)) {
    throw new Error('Expected argument of type fontbakery.dashboard.CacheItem');
  }
  return new Buffer(arg.serializeBinary());
}

function deserialize_fontbakery_dashboard_CacheItem(buffer_arg) {
  return messages_pb.CacheItem.deserializeBinary(new Uint8Array(buffer_arg));
}

function serialize_fontbakery_dashboard_CacheKey(arg) {
  if (!(arg instanceof messages_pb.CacheKey)) {
    throw new Error('Expected argument of type fontbakery.dashboard.CacheKey');
  }
  return new Buffer(arg.serializeBinary());
}

function deserialize_fontbakery_dashboard_CacheKey(buffer_arg) {
  return messages_pb.CacheKey.deserializeBinary(new Uint8Array(buffer_arg));
}

function serialize_fontbakery_dashboard_CacheStatus(arg) {
  if (!(arg instanceof messages_pb.CacheStatus)) {
    throw new Error('Expected argument of type fontbakery.dashboard.CacheStatus');
  }
  return new Buffer(arg.serializeBinary());
}

function deserialize_fontbakery_dashboard_CacheStatus(buffer_arg) {
  return messages_pb.CacheStatus.deserializeBinary(new Uint8Array(buffer_arg));
}

function serialize_google_protobuf_Any(arg) {
  if (!(arg instanceof google_protobuf_any_pb.Any)) {
    throw new Error('Expected argument of type google.protobuf.Any');
  }
  return new Buffer(arg.serializeBinary());
}

function deserialize_google_protobuf_Any(buffer_arg) {
  return google_protobuf_any_pb.Any.deserializeBinary(new Uint8Array(buffer_arg));
}


// The greeting service definition.
var CacheService = exports.CacheService = {
  // Sends a greeting
  put: {
    path: '/fontbakery.dashboard.Cache/Put',
    requestStream: true,
    responseStream: true,
    requestType: messages_pb.CacheItem,
    responseType: messages_pb.CacheKey,
    requestSerialize: serialize_fontbakery_dashboard_CacheItem,
    requestDeserialize: deserialize_fontbakery_dashboard_CacheItem,
    responseSerialize: serialize_fontbakery_dashboard_CacheKey,
    responseDeserialize: deserialize_fontbakery_dashboard_CacheKey,
  },
  // Sends another greeting
  get: {
    path: '/fontbakery.dashboard.Cache/Get',
    requestStream: false,
    responseStream: false,
    requestType: messages_pb.CacheKey,
    responseType: google_protobuf_any_pb.Any,
    requestSerialize: serialize_fontbakery_dashboard_CacheKey,
    requestDeserialize: deserialize_fontbakery_dashboard_CacheKey,
    responseSerialize: serialize_google_protobuf_Any,
    responseDeserialize: deserialize_google_protobuf_Any,
  },
  purge: {
    path: '/fontbakery.dashboard.Cache/Purge',
    requestStream: false,
    responseStream: false,
    requestType: messages_pb.CacheKey,
    responseType: messages_pb.CacheStatus,
    requestSerialize: serialize_fontbakery_dashboard_CacheKey,
    requestDeserialize: deserialize_fontbakery_dashboard_CacheKey,
    responseSerialize: serialize_fontbakery_dashboard_CacheStatus,
    responseDeserialize: deserialize_fontbakery_dashboard_CacheStatus,
  },
};

exports.CacheClient = grpc.makeGenericClientConstructor(CacheService);
