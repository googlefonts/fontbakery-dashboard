#!/usr/bin/env python
from __future__ import print_function, division, unicode_literals, absolute_import

import logging
import time
from protocolbuffers import messages_pb2_grpc
import grpc

# currently unused
def get_type_for_type_name(typeName, accepted_types):
  for Type in accepted_types:
    if Type.DESCRIPTOR.full_name == typeName:
      return Type
  raise KeyError('Type for name "{0}" not found.'.format(typeName))

# currently unused
def get_type_from_any(any, accepted_types):
  return get_type_for_type_name(any.TypeName(), accepted_types)

def unpack_any(any, Type):
  message = Type()
  if not any.Unpack(message):
    raise ValueError('any.Unpack Failed: expected type {}:"{}" doesn\'t match "{}".'
                  .format(Type, Type.DESCRIPTOR.full_name, any.TypeName()))
  return message

# currently unused
def unpack_any_generic(any, accepted_types):
  Type = get_type_from_any(any, accepted_types)
  return unpack_any(any, Type)

class RetriesExceeded(Exception):
  pass


# Thanks @Bogdanp for this comment:
# https://github.com/GoogleCloudPlatform/google-cloud-python/issues/2583#issuecomment-256026510
MAX_TRIES_BY_CODE = {
    grpc.StatusCode.UNKNOWN: 6 # as reported in #56
  , grpc.StatusCode.INTERNAL: 1
  , grpc.StatusCode.UNAVAILABLE: 5
  , grpc.StatusCode.DEADLINE_EXCEEDED: 5
}

def backoff(f, *args, **kwds):
  tries = 0
  while True:
    tries += 1
    try:
      return f(*args, **kwds)
    # see https://github.com/googlefonts/fontbakery-dashboard/issues/56
    # Expecting a _Rendezvous
    # https://github.com/grpc/grpc/tree/master/src/python/grpcio/grpc/_channel.py
    except grpc.RpcError as error:
      code = error.code()
      if code not in MAX_TRIES_BY_CODE:
        raise error

      # There's no better way than to check the see details, see #56 and #59
      if code == grpc.StatusCode.UNKNOWN and error.details() not in {'Stream removed'}:
        raise error

      if tries >= MAX_TRIES_BY_CODE[code]:
        raise RetriesExceeded(error)

      # retry in ...
      backoff = 0.0625 * 2 ** tries # 0.125, 0.25, 0.5, 1.0
      logging.warning('Exception in try #{0} backing off for {1} seconds '
                      'until retry. Error: {2}'.format(tries, backoff, error))
      time.sleep(backoff)

class CacheClient(object):
  """
  usage:

  from worker.cacheclient import CacheClient
  from protocolbuffers.messages_pb2 import CacheKey, Files
  import sys
  client = CacheClient('localhost', 50051, Files)
  cacheKey = CacheKey(key=sys.argv[1])
  print('[GET] request:', cacheKey)
  result = client.get(cacheKey)
  print('[GET] result:', result)

  """
  def __init__(self, host, port, ExpectedGetType):
    self._channel = grpc.insecure_channel('{}:{}'.format(host, port)
          , options=[
              ('grpc.max_send_message_length', 80 * 1024 * 1024)
            , ('grpc.max_receive_message_length', 80 * 1024 * 1024)
          ]
    )
    self._client = messages_pb2_grpc.CacheStub(self._channel)
    self.ExpectedGetType = ExpectedGetType

  def get(self, cacheKey):
    any = backoff(self._client.Get, cacheKey);
    return unpack_any(any, self.ExpectedGetType)

