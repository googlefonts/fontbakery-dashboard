#!/usr/bin/env python
from __future__ import print_function, division, unicode_literals, absolute_import

import sys
import logging
import time
from protocolbuffers import messages_pb2_grpc
from protocolbuffers.messages_pb2 import (
                                          StorageItem
                                        )
from google.protobuf.any_pb2 import Any
from collections import OrderedDict
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

      # There's no better way than to check the details, see #56 and #59
      if code == grpc.StatusCode.UNKNOWN and error.details() not in {'Stream removed'}:
        raise error

      if tries >= MAX_TRIES_BY_CODE[code]:
        raise RetriesExceeded(error)

      # retry in ...
      backoff = 0.0625 * 2 ** tries # 0.125, 0.25, 0.5, 1.0
      logging.warning('Exception in try #{0} backing off for {1} seconds '
                      'until retry. Error: {2}'.format(tries, backoff, error))
      time.sleep(backoff)

class StorageClient(object):
  """
  usage:

  from worker.storageclient import StorageClient
  from protocolbuffers.messages_pb2 import StorageKey, Files
  import sys
  client =StorageClient('localhost', 50051, Files)
  storageKey = StorageKey(key=sys.argv[1])
  print('[GET] request:', storageKey)
  result = client.get(storageKey)
  print('[GET] result:', result)

  """
  def __init__(self, host, port, ExpectedGetType):
    self._channel = grpc.insecure_channel('{}:{}'.format(host, port)
          , options=[
              ('grpc.max_send_message_length', 80 * 1024 * 1024)
            , ('grpc.max_receive_message_length', 80 * 1024 * 1024)
          ]
    )
    self._client = messages_pb2_grpc.StorageStub(self._channel)
    self.ExpectedGetType = ExpectedGetType

  def get(self, storageKey):
    any = backoff(self._client.Get, storageKey);
    return unpack_any(any, self.ExpectedGetType)

  def put (self, messages, ensure_answers_in_order=True):
    """
      ensure_answers_in_order: bool, default True
          Using this to make sure we answer in the same order as we PUT.
          Could be done otherwise more memory efficient in some cases.
          However, user expectation are probably to get the answers in the
          same order as the messages and it would lead to subtle bugs
          otherwise. If ensure_answers_in_order is False the order of
          answers is not guaranteed to be the same order as messages,
          depending purely on the server implementation.
    """
    if ensure_answers_in_order:
      result = OrderedDict()
    def make_storage_item(message, clientid):
      storage_item = StorageItem()
      any_message = Any()
      any_message.Pack(message)
      storage_item.payload.CopyFrom(any_message)
      if clientid is not None:
        storage_item.clientid = clientid
      if ensure_answers_in_order:
        result[clientid] = None
      return storage_item

    storage_items = (make_storage_item(message, str(index))\
                              for index, message in enumerate(messages))

    for storageKey in self._client.Put(storage_items):
      if ensure_answers_in_order:
        result[storageKey.clientid] = storageKey
      else:
        yield storageKey

    if ensure_answers_in_order:
      for storageKey in result.values():
        yield storageKey


# Used for ad-hoc testing only!
# Due to the mess of py3 imports of the protocolbuffers, called like
# this:
# containers/base/python$ python -c 'from worker.storageclient import main;main()'
def main():
  c = StorageClient('127.0.0.1', '3456', None)
  from google.protobuf.timestamp_pb2 import Timestamp
  from time import sleep

  def getCurrentTs():
    sleep(.5)
    ts = Timestamp()
    ts.GetCurrentTime()
    print('generated another timestamp:', ts)
    return ts

  tss = (getCurrentTs() for _ in range(10))
  for r in c.put(tss):
    print('result:', r);
  print('done!')
