#!/usr/bin/env python
from __future__ import print_function, division, unicode_literals

import os
import time
from contextlib import contextmanager
from functools import partial
import tempfile
import shutil
import requests
import pika
import rethinkdb as r
import logging
from collections import namedtuple

class FontbakeryWorkerError(Exception):
  pass

class FontbakeryPreparationError(FontbakeryWorkerError):
  pass

def get_fontbakery(fonts):
  from fontbakery.commands.check_googlefonts import runner_factory
  runner = runner_factory(fonts)
  spec = runner.specification
  return runner, spec

def validate_filename(seen, filename):
  maxfiles = 30
  # Basic input validation
  # Don't put any file into tmp containing a '/' or equal to '', '.' or '..'
  if filename in {'', '.', '..'} or '/' in filename:
    raise FontbakeryPreparationError('Invalid filename: "{0}".'.format(filename))

  if filename in seen:
    logs.append('Skipping duplicate file name "{0}".'.format(filename))
    return False

  if len(seen) == maxfiles:
    logs.append('Skipping file "{0}", max allowed file number {1} reached.'
                                              .format(filename, maxfiles))
    return False
  return True

def prepare_draganddrop_fontbakery(tmpDirectory, job):
  """
    Write job.files to tmpDirectory.

    Returns a list of log messages for each file in job.files, some may
    be skipped. This is to give the user direct feedback about the request
    made.

    Raises FontbakeryPreparationError if files appear to be invalid.
  """
  # `maxfiles` files should be small enough to not totally DOS us easily.
  # And big enough for all of our jobs, otherwise, change ;-)

  maxfiles = 25
  logs = []
  if tmpDirectory is not None:
    logs.append('Dry run! tmpDirectory is None.')
  seen = set()
  fontfiles = []
  for jobFile in job.files:
    filename = jobFile.name
    if not validate_filename(seen, filename):
      continue

    seen.add(filename)
    if tmpDirectory is not None:
      path = os.path.join(tmpDirectory, filename)
      with open(path, 'wb') as f:
        f.write(jobFile.data)
    else:
      path = filename

    logs.append('Added file "{}".'.format(filename))
    if path.endswith('.ttf'):
      fontfiles.append(path)

  if len(fontfiles) == 0:
    raise FontbakeryPreparationError('Could not find .ttf files in job.')
  return logs, fontfiles

def prepare_collection_fontbakery(tmpDirectory, job):
  host = os.environ.get("COLLECTIONTEST_DISPATCHER_SERVICE_HOST")
  port = os.environ.get("COLLECTIONTEST_DISPATCHER_SERVICE_PORT", 3000)
  server = ''.join(['http://', host, ':', port])
  if tmpDirectory is None:
    url = '/'.join([server, 'family', 'filenames' , job['family']])
    logging.info('Requesting: {}'.format(url))
    response = requests.get(url)
    response.raise_for_status()
    files = [({'filename': f}, None) for f in json.loads(response.text)]
  else:
    url = '/'.join([server, 'family', 'files' , job['family']])
    logging.info('Requesting: {}'.format(url))
    response = requests.get(url)
    response.raise_for_status()
    files = list(_unpack_files(BytesIO(response.content)))
  logs = []
  seen = set()
  fontfiles = []
  for desc, data in files:
    filename = desc['filename']

    if not validate_filename(seen, filename):
      continue
    seen.add(filename)

    if tmpDirectory is not None:
      path = os.path.join(tmpDirectory, filename)
      with open(path, 'wb') as f:
        f.write(data)
      logs.append('Added file "{}".'.format(filename))
    else:
      path = filename

    if path.endswith('.ttf'):
      fontfiles.append(path)

  if len(fontfiles) == 0:
    raise FontbakeryPreparationError('Could not find .ttf files in job.')
  return logs, fontfiles

class DBOperations(object):
  def __init__(self, dbTableContext, docid, jobid=None):
    self.dbTableContext = dbTableContext
    self._docid = docid
    self._jobid = jobid

  @property
  def has_job(self):
    return self._jobid is not None

  def update(self, doc):
    if self.has_job:
      # even for this, `update` is supposed to be atomic.
      _doc = {
        'jobs': r.row['jobs'].change_at(self._jobid
                            , r.row['jobs'].nth(self._jobid).merge(doc))}
    else:
      _doc = doc
    with self.dbTableContext() as (q, conn):
      return q.get(self._docid).update(_doc).run(conn)

  def insert_test(self, key, test_result):
    doc = {
        'tests': r.row['tests'].merge({key: test_result})
      # increase the counter
      # FIXME: This is a denormalization, and we can most probably create
      # a rethinkdb query to fetch a results object like this on the fly.
      # This is mainly useful for the collection-wide test results view.
      # Maybe an on-the-fly created results object is fast enough. After all,
      # this is a classical case for an SQL database query.
      , 'results': r.row['results'].merge(lambda results: {
          test_result['result']: results[test_result['result']].default(0).add(1)
      })
    }

    with self.dbTableContext() as (q, conn):
      q.get(self._docid).update(doc).run(conn)

@contextmanager
def tempdir():
  # In python 3.7 there's a contextmanager: TemporaryDirectory
  tmpDirectory =  tempfile.mkdtemp()
  yield tmpDirectory
  shutil.rmtree(tmpDirectory)

@contextmanager
def get_db(host, port, db, table=None):
  """
  Use this context manager to send just one message per connection (socket).
  Depending on message size and network, this means some messages may
  arrive earlier than others at the db host, NOT in order.
  To compensate in a rethink change feed, `sqash` can be used. Maybe other
  tweeks, like the
  """
  connection = r.connect(host=host, port=port, db=db)
  if table is not None:
    q = r.table(table)
  else:
    q = r
  yield q, connection
  connection.close()

def setLoglevel(loglevel):
  '''
  loglevel, use: DEBUG, INFO, WARNING, ERROR, CRITICAL
  '''
  numeric_level = getattr(logging, loglevel.upper(), None)
  if not isinstance(numeric_level, int):
    raise ValueError('Invalid log level: %s' % loglevel)
  logging.basicConfig(level=numeric_level)

QueueData = namedtuple('QueueData', ['channel', 'name', 'distribute_name'])

def main(queue_in_name, db_name, db_table, consumefunc, queue_out_name=None):
  setLoglevel(os.environ.get("FONTBAKERY_WORKER_LOG_LEVEL", 'INFO'))

  # in gcloud, we use a cluster with proxy setup
  # the proxy service is called: "rethinkdb-proxy" hence:
  db_host = os.environ.get("RETHINKDB_PROXY_SERVICE_HOST", None)
  db_port = os.environ.get("RETHINKDB_PROXY_SERVICE_PORT", 28015)

  if db_host is None:
    # Fall back to "rethinkdb-driver"
    db_host = os.environ.get("RETHINKDB_DRIVER_SERVICE_HOST")
    db_port = os.environ.get("RETHINKDB_DRIVER_SERVICE_PORT", 28015)

  logging.info(' '.join(['RethinkDB', 'HOST', db_host, 'PORT', db_port]))

  dbTableContext = partial(get_db, db_host, db_port, db_name, db_table)

  # FIXME: Where would BROKER be set? RABBITMQ_SERVICE_SERVICE_HOST is
  # set by kubernetes for the service named "rabbitmq-service" AFAIK
  msgqueue_host = os.environ.get("RABBITMQ_SERVICE_SERVICE_HOST", os.environ.get("BROKER"))

  while True:
    connection = None
    queue_channel = None
    try:
      connection = pika.BlockingConnection(pika.ConnectionParameters(host=msgqueue_host))
      queue_channel = connection.channel()
      queue_channel.basic_qos(prefetch_count=1)
      queue_channel.queue_declare(queue=queue_in_name, durable=True)
      if queue_out_name is not None:
         queue_channel.queue_declare(queue=queue_out_name, durable=True)
      logging.info('Waiting for messages in %s...', queue_in_name)
      # BlockingChannel has a generator
      queue = QueueData(queue_channel, queue_in_name, queue_out_name)
      # Why `no_ack=True`: A job can run much longer than the broker will
      # wait for an ack and there's no way to give a good estimate of how
      # long a job will take. If the ack times out, the job will be
      # reissued by the broker, creating an infinite loop.
      # Ack immediately and see how to handle failed jobs at another
      # point of time.
      for method, properties, body in queue.channel.consume(queue.name):
        consumefunc(dbTableContext, queue, method, properties, body)
    except pika.exceptions.ConnectionClosed:
      logging.warning('RabbitMQ not ready yet.', exc_info=True)
      time.sleep(1)
    finally:
      if connection and connection.is_open and not connection.is_closing:
        connection.close()
        if queue_channel and queue_channel.is_open and not queue_channel.is_closing:
          queue_channel.close()
