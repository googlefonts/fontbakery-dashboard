#!/usr/bin/env python
from __future__ import print_function, division, unicode_literals, absolute_import

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
    self._channel = grpc.insecure_channel('{}:{}'.format(host, port))
    self._client = messages_pb2_grpc.CacheStub(self._channel)
    self.ExpectedGetType = ExpectedGetType

  def get(self, cacheKey):
    any = self._client.Get(cacheKey);
    return unpack_any(any, self.ExpectedGetType)

