#!/usr/bin/env python
from __future__ import print_function, division, unicode_literals

import os
from contextlib import contextmanager
from functools import partial
import tempfile
import shutil
import pika
import rethinkdb as r
import logging
import traceback
import pytz
from datetime import datetime
from collections import namedtuple

from worker.cacheclient import CacheClient
from protocolbuffers.messages_pb2 import Files

class FontbakeryWorkerError(Exception):
  pass

class FontbakeryPreparationError(FontbakeryWorkerError):
  pass

def get_fontbakery(fonts):
  from fontbakery.commands.check_googlefonts import runner_factory
  runner = runner_factory(fonts)
  spec = runner.specification

  old_check_skip_filter = spec.check_skip_filter
  def check_skip_filter(checkid, font=None, **iterargs):
      # Familyname must be unique according to namecheck.fontdata.com
    if checkid == 'com.google.fonts/check/165':
      return False, ('Disabled for Fontbakery-Dashboard, see: '
                     'https://github.com/googlefonts/fontbakery/issues/1680')
    if old_check_skip_filter:
      return old_check_skip_filter(checkid, font, **iterargs)
    return True, None

  spec.check_skip_filter = check_skip_filter

  return runner, spec

def validate_filename(logs, seen, filename):
  maxfiles = 60
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

class FontbakeryWorker(object):
  def __init__(self, dbTableContext, queue, cache, setup=None):
    self._dbTableContext = dbTableContext
    self._queue = queue
    self._cache = cache

    self._job = None
    self._tmpDirectory = None
    self._dbOps = None

    self._save_preparation_logs = False
    self._with_tempdir = False

  def _prepare(self, tmpDirectory):
    """
      Write files from the grpc.CacheServe to tmpDirectory.

      Returns a list of log messages for each file in job.files, some may
      be skipped. This is to give the user direct feedback about the request
      made.

      Raises FontbakeryPreparationError if files appear to be invalid.
    """
    # `maxfiles` files should be small enough to not totally DOS us easily.
    # And big enough for all of our jobs, otherwise, change ;-)
    job = self._job
    files = self._cache.get(job.cache_key).files
    maxfiles = 45
    logs = []
    if tmpDirectory is not None:
      logs.append('Dry run! tmpDirectory is None.')
    seen = set()

    fontfiles = []
    for jobFile in files:
      filename = jobFile.name
      if not validate_filename(logs, seen, filename):
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

    if len(fontfiles) > maxfiles:
      raise FontbakeryPreparationError('Found {} font files, but maximum '
                      'is limiting to {}.'.format(len(fontfiles), maxfiles))

    if len(fontfiles) == 0:
      raise FontbakeryPreparationError('Could not find .ttf files in job.')
    if self._save_preparation_logs:
      self._dbOps.update({'preparation_logs': logs})
    return fontfiles

  def _run(self, tmpDirectory=None):
    if tmpDirectory:
      # TODO: it would be nice to get rid of tmpDirectory, but some tests
      # expect a tmpDirectory. Maybe we can differentiate the jobs in the
      # future, split in those who need a tmpDir and those who don't.
      # A (tmp_)directory condition could even handle this from within fontbakery
      # e.g. the ms fontvalidator would require a `directory` and it would be
      # created on the fly. Though, fontbakery would have to clean it up
      # again as well, which is not yet supported!
      logging.info('Tempdir: %s', tmpDirectory)
    try:
      fonts = self._prepare(tmpDirectory)
      if tmpDirectory:
        logging.debug('Files in tmp {}'.format(os.listdir(tmpDirectory)))
        # got these logs in distribute for the entire doc (a dry run)
        # but also uses prepare
        # this should produce a very similar log.
        # with dbTableContext() as (q, conn):
        #   ATTENTION: this would have to go to the job item at `jobs[job.id]`
        #   q.get(job.docid).update({'preparation_logs': logs}).run(conn)

      # A checker-worker *MUST* write the correct 'finished' field for it's docid/jobid
      # A distributor-worker can not write finished in here.
      self._work(fonts)
      logging.info('DONE! docid: %s', self._job.docid)
    except Exception as e:
      # FIXME: raise if the cause of the error is a resource that got lost
      #        i.e. database, cache, queue because then kubernetes can
      #             restart the pod with its back-off delay
      # write to the DB doc
      # Report suppression of the error
      logging.exception('FAIL docid: %s', self._job.docid)
      # It will be handy to know this from the client.
      exception = traceback.format_exc()
      # if there is a jobid, this is reported in the job, otherwise it
      # is reported in the doc.
      #
      # Not sure if the distributor-worker should write `finished` here
      # It doesn't hurt much though, _finalize will still run.
      self._dbOps.update({'finished': datetime.now(pytz.utc)
                  , 'exception': exception
                  })
      logging.exception('Document closed exceptionally. %s', e)
    self._finalize()

  def _finalize(self):
    # FIXME: if the worker-distributor fails in _run (except Exception as e:)
    # it also MUST finalize like the worker checker, but not necessarily when
    # _run succeeds. In any way, the CleanupJobs service wouldn't close
    # a job without good reason.
    pass

  @contextmanager
  def _parse_job(self, body):
    try:
      job = self._JobType()
      job.ParseFromString(body)
      logging.debug('Got job: %s', job)
      dbOps = DBOperations(self._dbTableContext, job)
    except Exception as e:
      # Can not report this appropriately
        logging.exception('Can\'t report to data base document. %s', e)
        raise
    self._job = job;
    self._dbOps = dbOps;
    yield
    self._job = None;
    self._dbOps = None

  def consume(self, method, properties, body):
    logging.info('Consuming ...')
    logging.debug('consuming args: %s %s', method, properties)
    if self._with_tempdir:
      with self._parse_job(body), tempdir() as tmpDirectory:
        self._run(tmpDirectory)
    else:
      with self._parse_job(body):
        self._run()
    # this will only be acked if self._load_job was succesful
    self._queue.channel.basic_ack(delivery_tag=method.delivery_tag)
    # FIXME: we really shouldn't ack the job if can't even mark it as
    # failed in the RethinkDB-doc (AND WE DON'T DO SO CURENTLY)
    # publishing the job again, with increased retry count would be good
    # though. (Needs a retry count field on the job).

    # TODO: to keep jobs from disappearing (and also from being redelivered
    # forever), a dead-end queue could be created.
    # Also nice as a tactic would be to reinsert the job into the original
    # queue, but with an incremented retry count. After {n} retries we could
    # move it to the dead-end. That way, a temporary db failure or such would
    # not be a "job killer".

  def _queue_out(self, message):
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
    channel, routing_key = (self._queue.channel, self._queue.out_name)
    channel.basic_publish(exchange=''
                        , routing_key=routing_key
                        , body=message.SerializeToString()
                        , properties=options)

class DBOperations(object):
  def __init__(self, dbTableContext, job):
    self.dbTableContext = dbTableContext

    self._docid = job.docid
    self._jobid = job.jobid or None

  @property
  def has_job(self):
    return self._jobid is not None

  def update(self, doc):
    if self.has_job:
      # even for this, `update` is supposed to be atomic.
      _doc = {
          'jobs': r.row['jobs'].merge({self._jobid: doc})
        }
    else:
      _doc = doc
    with self.dbTableContext() as (q, conn):
      return q.get(self._docid).update(_doc).run(conn)

  def insert_checks(self, check_results):
    doc = {
        'tests': r.row['tests'].merge(check_results)
      # increase the counter
      # FIXME: This is a denormalization, and we can most probably create
      # a rethinkdb query to fetch a results object like this on the fly.
      # This is mainly useful for the collection-wide test results view.
      # Maybe an on-the-fly created results object is fast enough. After all,
      # this is a classical case for an SQL database query.

      # This was the first version with the following problem:
      # if the worker is in a crashback loop and the same tests are
      # executed multiple times, the result fields can grow bigger than
      # their actual number i.e. total > len(tests), yet we may not be
      # finished with all tests.
      #, 'results': r.row['results'].merge(lambda results: {
      #    test_result['result']: results[test_result['result']].default(0).add(1)
      #})
      # this recreates the results dict on each insert
      # to avoid the race condition, the r.row['tests'] is recreated
      # here on the fly
        , 'results': r.row['tests'].merge(check_results)
                    .values()
                    .filter(lambda item: item.has_fields('result'))
                    .map(lambda item: item['result'])
                    .fold({}, lambda acc, result: acc.merge(
                        r.object(result, acc[result].default(0).add(1))))
    }

    with self.dbTableContext() as (q, conn):
      result = q.get(self._docid).update(doc).run(conn)
      if result['errors']:
        raise FontbakeryWorkerError('RethinkDB: {}'.format(result['first_error']))


@contextmanager
def tempdir():
  # In python 3.7 there's a contextmanager: TemporaryDirectory
  tmpDirectory =  tempfile.mkdtemp()
  yield tmpDirectory
  shutil.rmtree(tmpDirectory)

@contextmanager
def get_db(connection, db_name, table=None):
  """
  Use this context manager to send just one message per connection (socket).
  Depending on message size and network, this means some messages may
  arrive earlier than others at the db host, NOT in order.
  To compensate in a rethink change feed, `sqash` can be used.

  FIXME: not doing this anymore, I wonder if it was respnsible for making
  connecting to the db so slow that it timed out!.
  """
  if table is not None:
    q = r.db(db_name).table(table)
  else:
    q = r.db(db_name)
  yield q, connection

def setLoglevel(loglevel):
  '''
  loglevel, use: DEBUG, INFO, WARNING, ERROR, CRITICAL
  '''
  numeric_level = getattr(logging, loglevel.upper(), None)
  if not isinstance(numeric_level, int):
    raise ValueError('Invalid log level: %s' % loglevel)
  logging.basicConfig(level=numeric_level)

QueueData = namedtuple('QueueData', ['channel', 'in_name', 'out_name'])
Setup = namedtuple('Setup', ['log_level', 'db_host', 'db_port'
                           , 'msgqueue_host', 'cache_host', 'cache_port'
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
  cache_host = os.environ.get("FONTBAKERY_CACHE_SERVICE_HOST")
  cache_port = os.environ.get("FONTBAKERY_CACHE_SERVICE_PORT", 50051)

  # 1 reports every test result to the database and creates a good
  # live report granularity, but it also slows the database down.
  # For a massive scale of checkers, this can be a major tool to tune
  # performance.

  ticks_to_flush = int(os.environ.get("FONTBAKERY_CHECKER_TICKS_TO_FLUSH", 1))

  return Setup(log_level, db_host, db_port, msgqueue_host
                              , cache_host, cache_port, ticks_to_flush)

def main(queue_in_name, queue_out_name, db_name, db_table, Worker):
  """
    We don't handle uncaught exceptions here. If this fails kubernetes
    will restart the pod and take care that the times between restarts
    gets longer.
  """
  setup = getSetup()
  setLoglevel(setup.log_level)
  logging.info(' '.join(['RethinkDB', 'HOST', setup.db_host, 'PORT', setup.db_port]))

  dbConnection = r.connect(host=setup.db_host, port=setup.db_port, timeout=120)
  dbTableContext = partial(get_db, dbConnection, db_name, db_table)
  cache = CacheClient(setup.cache_host, setup.cache_port, Files)

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
  for method, properties, body in queue.channel.consume(queue.in_name):
    worker = Worker(dbTableContext, queue, cache, setup)
    worker.consume(method, properties, body)
