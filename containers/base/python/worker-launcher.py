#!/usr/bin/env python
from __future__ import print_function, division, unicode_literals

import os
from tempfile import TemporaryDirectory
import pika
from rethinkdb import RethinkDB

import traceback
from collections import namedtuple
import inspect
from contextlib import ExitStack
from protocolbuffers.messages_pb2 import Files, WorkerJobDescription

import logging
FORMAT = '%(asctime)s:%(name)s:%(levelname)s:%(message)s'
logging.basicConfig(format=FORMAT)


from worker.storageclient import StorageClient
from worker.fontbakery import (
                      Checker as FontBakeryChecker
                    , Distributor as FontBakeryDistributor
                    )
from worker.diffenator import Diffenator

logger = logging.getLogger('FB_WORKER')
r = RethinkDB()

class Queue(object):
  def __init__(self, channel, worker_name, end_name):
    self.channel = channel
    self._worker_name = worker_name
    self._end_name = end_name

  def _queue(self, message, queue_name):
    options = pika.BasicProperties(
          # TODO: do we need persistent here?
          delivery_mode=2  # pika.spec.PERSISTENT_DELIVERY_MODE
    )
    # Default exchange
    # The default exchange is a pre-declared direct exchange with no name,
    # usually referred by the empty string "". When you use the default exchange,
    # your message will be delivered to the queue with a name equal to the routing
    # key of the message. Every queue is automatically bound to the default exchange
    # with a routing key which is the same as the queue name.
    routing_key = queue_name
    self.channel.basic_publish(exchange=''
                        , routing_key=routing_key
                        , body=message.SerializeToString()
                        , properties=options)

  def end(self, message):
    return self._queue(message, self._end_name)

  def worker(self, message):
    return self._queue(message, self._worker_name)


def setLoglevel(logger, loglevel):
  '''
  loglevel, use: DEBUG, INFO, WARNING, ERROR, CRITICAL
  '''
  numeric_level = getattr(logging, loglevel.upper(), None)
  if not isinstance(numeric_level, int):
    raise ValueError('Invalid log level: %s' % loglevel)
  logger.setLevel(numeric_level)

Setup = namedtuple('Setup', ['log_level', 'db_host', 'db_port'
                           , 'msgqueue_host', 'cache_host', 'cache_port'
                           , 'persistence_host', 'persistence_port'
                           , 'ticks_to_flush'])

def getSetup():
  log_level = os.environ.get("FONTBAKERY_WORKER_LOG_LEVEL", 'INFO')
  # in gcloud, we use a cluster with proxy setup
  # the proxy service is called: "rethinkdb-proxy" hence:
  db_host = os.environ.get("RETHINKDB_PROXY_SERVICE_HOST", None)
  db_port = os.environ.get("RETHINKDB_PROXY_SERVICE_PORT", 28015)
  if db_host is None:
    # Fall back to "rethinkdb-driver"
    db_host = os.environ.get("RETHINKDB_DRIVER_SERVICE_HOST")
    db_port = os.environ.get("RETHINKDB_DRIVER_SERVICE_PORT", 28015)

  # FIXME: Where would BROKER be set? RABBITMQ_SERVICE_SERVICE_HOST is
  # set by kubernetes for the service named "rabbitmq-service" AFAIK
  msgqueue_host = os.environ.get("RABBITMQ_SERVICE_SERVICE_HOST", os.environ.get("BROKER"))
  cache_host = os.environ.get("FONTBAKERY_STORAGE_CACHE_SERVICE_HOST")
  cache_port = os.environ.get("FONTBAKERY_STORAGE_CACHE_SERVICE_PORT", 50051)

  persistence_host = os.environ.get("FONTBAKERY_STORAGE_PERSISTENCE_SERVICE_HOST")
  persistence_port = os.environ.get("FONTBAKERY_STORAGE_PERSISTENCE_SERVICE_PORT", 50051)

  # 1 reports every test result to the database and creates a good
  # live report granularity, but it also slows the database down.
  # For a massive scale of checkers, this can be a major tool to tune
  # performance.

  ticks_to_flush = int(os.environ.get("FONTBAKERY_CHECKER_TICKS_TO_FLUSH", 1))

  return Setup(log_level, db_host, db_port, msgqueue_host
                              , cache_host, cache_port
                              , persistence_host, persistence_port
                              , ticks_to_flush)


def parse_job(workers, body):
  try:
    job_description = WorkerJobDescription()
    job_description.ParseFromString(body)
    logger.debug('Got job description: %s', job_description)
  except Exception as e:
    # Can not report this appropriately
    logger.exception('Can\'t parse body %s', e)
    raise

  worker_name = job_description.worker_name
  Worker = workers[worker_name]
  job = Worker.JobType()
  if not job_description.job.Unpack(job):
    raise ValueError('job_description.job.Unpack Failed: expected type '
                     + '{}:"{}" doesn\'t match "{}".'
                     .format(Worker.JobType, Worker.JobType.DESCRIPTOR.full_name
                          , job_description.job.TypeName()))
  return Worker, job;


def getMandatoryParams(callable):
    """
    If callable is a class, we'll get the non-optional parameters of the
    constructor, i.e. the parameters of `__init__` without the `self`.
    """
    params = inspect.signature(callable).parameters
    return [name for name, param in params.items() \
                      if param.kind is inspect.Parameter.POSITIONAL_OR_KEYWORD \
                      # If the parameter has no default value, this
                      # attribute is set to Parameter.empty.
                      and param.default is inspect.Parameter.empty]


class CTX(object):
  def __init__(self, Worker, resources):
      self._worker = Worker(*resources)

  def __enter__(self):
    return self._worker.run

  def __exit__(self, *exc):
    '''
    exc = ExceptionClass, exceptionClassInstance, classTracebackInstance
    map(type, exc) = [<class 'type'>, <class 'ExceptionClass'>, <class 'traceback'>]
    '''

    # FIXME: raise if the cause of the error is a resource that got lost
    #        i.e. database, cache, queue because then kubernetes can restart
    #        the pod with its back-off delay

    tb = None
    if exc[0]:
      # same as print_exception() in an except block
      tb = ''.join(traceback.format_exception(*exc))

    if hasattr(self._worker, 'finalize'):
      # Should return True if exc was dealt ok with
      # otherwise it will be re-raised
      # FIXME: finalize will need some resources as well!
      return self._worker.finalize(tb, *exc)
    # If there was an exception but no finalize the default is to
    # re-raise the exception, what happens when we return False.
    # Without exception there's nothing to raise anyways.
    return False

def consume(workers, static_resources, resource_managers, method, properties, body):
  Worker, job = parse_job(workers, body)
  logger.info('consuming a job for: %s with %s %s', Worker, method, properties)

  with ExitStack() as stack:
    # If __enter__ raises it's NOT handled by __exit__
    # which is actually a good thing, only the call
    # to worker, the content in the `with` block
    # will be handled by __exit__.

    # We don't do optional arguments
    dependencies = getMandatoryParams(Worker)
    resources = []

    # somehow there should be a way to get resources like
    # a tmpdir context managed ....
    for name in dependencies:
      if name == 'job':
        resources.append(job)
      elif name in resource_managers:
        # for e.g. tmp_dir
        context_manager = resource_managers[name]
        resources.append(stack.enter_context(context_manager()))
      else:
        # If name is missing a KeyError will be raised
        # which seems appropriate.
        resources.append(static_resources[name])
    # enter context and executr
    run = stack.enter_context(CTX(Worker, resources))
    run()


def main():
  """
    We don't handle uncaught exceptions here. If this fails kubernetes
    will restart the pod and take care that the times between restarts
    gets longer.
  """
  setup = getSetup()

  setLoglevel(logger, setup.log_level)
  # DEBUG is a lot of output!
  # setLoglevel(logging.getLogger('fontdiffenator'), 'INFO')
  setLoglevel(logging.getLogger('fontdiffenator'), setup.log_level)

  logger.info('loglevel: ' + setup.log_level)

  logger.info(' '.join(['RethinkDB', 'HOST', setup.db_host, 'PORT', setup.db_port]))
  rdb_connection = r.connect(host=setup.db_host, port=setup.db_port, timeout=120)
  rdb_name = 'fontbakery'

  queue_worker_name='fontbakery-worker'
  queue_end_name='fontbakery-worker-cleanup'

  # http://pika.readthedocs.io/en/latest/examples/heartbeat_and_blocked_timeouts.html
  connection = pika.BlockingConnection(
                pika.ConnectionParameters(
                    host=setup.msgqueue_host
                    # for long running tasks
                  , heartbeat=20*60 # 20 minutes
                  # , socket_timeout=5
                ))
  queue_channel = connection.channel()
  queue_channel.basic_qos(prefetch_count=1)
  queue_channel.queue_declare(queue=queue_worker_name, durable=True)
  queue_channel.queue_declare(queue=queue_end_name, durable=True)

  static_resources = dict(
      logging=logger
    , queue=Queue(queue_channel, queue_worker_name, queue_end_name)
    , rethinkdb=(r, rdb_connection, rdb_name)
      # if we want to read more data types this must probably change?
    , cache=StorageClient(setup.cache_host, setup.cache_port, Files)
    , persistence=StorageClient(setup.persistence_host, setup.persistence_port, Files)
    , ticks_to_flush=setup.ticks_to_flush
  )

  resource_managers = dict(
      tmp_directory=TemporaryDirectory
  )

  workers = dict(
      fontbakery=FontBakeryDistributor
    , fontbakery_checker=FontBakeryChecker
    , diffenator=Diffenator
  )

  logger.info('Waiting for messages in %s...', queue_worker_name)
  # BlockingChannel has a generator
  # Why `no_ack=True`: A job can run much longer than the broker will
  # wait for an ack and there's no way to give a good estimate of how
  # long a job will take. If the ack times out, the job will be
  # reissued by the broker, creating an infinite loop.
  # Ack immediately and see how to handle failed jobs at another
  # point of time.
  for method, properties, body in queue_channel.consume(queue_worker_name):
    logger.info('consuming incoming message ...')
    try:
      consume(workers, static_resources, resource_managers, method, properties, body)
    except Exception as e:
      # exceptions that come here should restart the pod!
      # however that way, we don't see the exception log easily
      # which is bad for debugging
      logger.exception('consume FAILED: %s', e)
    finally:
      queue_channel.basic_ack(delivery_tag=method.delivery_tag)
      # FIXME: we should not always ack the job if can't even mark it as
      # failed in the RethinkDB-doc (or wherever???)
      # publishing the job again, with increased retry count would be an
      # option. (Needs a retry count field on the job).
      # TODO: to keep jobs from disappearing (and also from being redelivered
      # forever), a dead-end queue could be created.
      # Also nice as a tactic would be to re-insert the job into the original
      # queue, but with an incremented retry count. After {n} retries we could
      # move it to the dead-end. That way, a temporary db failure or such would
      # not be a "job killer".
      # BUT: for now we need to see cases where, how and why this actually fails.
if __name__ == '__main__':
  main()
