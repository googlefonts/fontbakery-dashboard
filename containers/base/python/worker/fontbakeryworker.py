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

class FontbakeryWorker(object):
  def __init__(self, dbTableContext, queue, cache):
    self._dbTableContext = dbTableContext
    self._queue = queue
    self._cache = cache

    self._job = None
    self._tmpDirectory = None
    self._dbOps = None

    self._save_preparation_logs = False
    self._with_tempdir = False

  def _prepare():
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
    tmpDirectory = self._tmpDirectory
    files = self._cache.get(job.cacheKey)
    maxfiles = 25
    logs = []
    if tmpDirectory is not None:
      logs.append('Dry run! tmpDirectory is None.')
    seen = set()

    fontfiles = []
    for jobFile in files:
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
      logging.info('DONE! (job type: %s)', jobtype)
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

  def _finalize():
    """
    FIXME: when all jobs are finished, we need a worker that
    is cleaning up ... that could be part of the dispatch-worker/manifest-master
    initiating and cleaning up would make some sense there...

    We need this especially to purge the cacheKey when not used anymore
    but also to eventually set the correct "finished" date and flag to
    the family/collection job.

    THUS: this would dispatch a queue message, that it has finished this
          job when _run ran to the end (when it fails the job won't be
          acked and will re-run)
    The dispatch worker would A) mark the whole test document as `isFinished`
    and, if part of a collection test, dispatch another queue message for
    the manifest master (sociopath) to clean up and mark as finished the
    test document.

    So TODO here: postmortem messages
      - as sender:  basically the same for checker-worker to dispatcher-worker
                                    and for dispatcher-worker to manifest-sociopath
      - as receiver for: dispatcher-worker from many checker-workers
                      and manifest-sociopath from many dispatcher-worker
      - the manifest-sociopath could be implemented here. CAUTION: the
                      worker that dispatches collection-tests is meant here
                      needs better role description!
                      ALSO, how does a drag and drop job enter the process?
                      someone has to dispatch to a dispatcher-worker and
                      clean up it's answer!
    """
    # good case:
    #   The finishedMessage is queued for each checker worker that's not
    #   in pod restart back-off loop i.e. where _run could write `finished`
    #   to a job.
    #
    #   assert finishedMessage.jobid has a finished field
    #                 OR set it yourself and put a warning message there.
    #                 "Did not finish itself, this should be highly irregular."
    #
    #   Eventually all checker workers have a `finished` field.
    #   Then (all not in a particular order)
    #       * the family test can write it's finished field and isFinished=True
    #       * if it has a collectionTest, dispatch a finishedMessage for that
    #       * purge the cache
    #   Then ack the queue message
    #
    # bad case:
    #   some/one worker checkers don't ever emit the finishedMessage
    #   The worst thing here is that the cache will keep the data forever
    #   so maybe we can add a mechanism to eventually end a job and purge
    #   all caches. It's not so bad when we don't get the appropriate finished
    #   fields set, but that would be done in the same run.
    #   see: Scheduling Messages with RabbitMQ
    #       https://www.rabbitmq.com/blog/2015/04/16/scheduling-messages-with-rabbitmq/
    #   also: RabbitMQ Delayed Message Plugin
    #       https://github.com/rabbitmq/rabbitmq-delayed-message-exchange/
    #   But probably, some kind of cron pod would also work.
    #   https://kubernetes.io/docs/concepts/workloads/controllers/cron-jobs/
    #   NOTE Cron Job Limitations: "... Therefore, jobs should be idempotent."

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
      with self._load_job(body), tempdir() as tmpDirectory:
        self._run(tmpDirectory)
    else:
      with self._load_job(body):
        self._run()
    # this will only be acked if self._load_job was succesful
    self._queueData.channel.basic_ack(delivery_tag=method.delivery_tag)
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

class DBOperations(object):
  def __init__(self, dbTableContext, job):
    self.dbTableContext = dbTableContext

    self._docid = job.docid
    self._jobid = job.jobid if 'jobid' in dj.DESCRIPTOR.fields_by_name \
                            else None

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
Setup = namedtuple('Setup', ['log_level', 'db_host', 'db_port'
                           , 'msgqueue_host', 'cache_host', 'cache_port'])

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

  return Setup(log_level, db_host, db_port, msgqueue_host, cache_host, cache_port)

def main(queue_in_name, db_name, db_table, Worker, queue_out_name=None):
  """
    We don't handle uncaught exceptions here. If this fails kubernetes
    will restart the pod and take care that the times between restarts
    gets longer.
  """
  setup = getSetup()
  setLoglevel(setup.log_level)
  logging.info(' '.join(['RethinkDB', 'HOST', setup.db_host, 'PORT', setup.db_port]))

  dbTableContext = partial(get_db, setup.db_host, setup.db_port, db_name, db_table)
  cache = CacheClient(setup.cache_host, setup.cache_port, Files)

  connection = pika.BlockingConnection(pika.ConnectionParameters(host=setup.msgqueue_host))
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
    worker = Worker(dbTableContext, queue, cache)
    worker.consume(method, properties, body)
