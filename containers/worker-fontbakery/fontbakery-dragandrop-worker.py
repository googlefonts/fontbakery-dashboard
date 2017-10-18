#!/usr/bin/env python
from __future__ import print_function, division, unicode_literals

import os
import json
from subprocess import  Popen, PIPE
import time
import pytz
from datetime import datetime
import tempfile
import struct
from io import BytesIO, SEEK_CUR
import shutil
import traceback
from contextlib import contextmanager
from functools import partial
import pika
import rethinkdb as r
import logging
from collections import namedtuple
import requests

class FontbakeryWorkerError(Exception):
  pass

class FontbakeryPreparationError(FontbakeryWorkerError):
  pass

class FontbakeryCommandError(FontbakeryWorkerError):
  pass

def get_fontbakery(fonts):
  from fontbakery.commands.check_googlefonts import runner_factory
  runner = runner_factory(fonts)
  spec = runner.specification
  return runner, spec

def worker_distribute_jobs(dbOps, queueData, job, prepare, dispatch):
  # this is a dry run, but it will fail early if there's a problem with
  # the files in job, also, it lists the fonts.
  prep_logs, fonts = prepare(None, job)

  dbOps.update({'preparation_logs': prep_logs})
  runner, spec = get_fontbakery(fonts)

  # this must survive JSON
  full_order = spec.serialize_order(runner.order)
  tests = {identity:{'index':index}  for index, identity in enumerate(full_order)}

  # FIXME: do something fancy to split this up
  # maybe we can distribute long running tests evenly or such
  # this would require more info of course.
  jobs = len(fonts) + 1  # go with number of fonts plus one for not font specific checks parallel jobs
  logging.info('worker_distribute_jobs: Splitting up into %s jobs.', jobs)

  from math import ceil
  job_size = int(ceil(len(full_order) / jobs))
  orders = [full_order[i:i+job_size]
                            for i in range(0, len(full_order), job_size)]
  jobs_meta = []
  jobs = []
  for jobid, order in enumerate(orders):
    # if split up in more jobs, these are created multiple times
    jobs_meta.append({
        'id': jobid
      , 'created': datetime.now(pytz.utc)
      # the indexes in full_order of the tests this job is supposed to run
      # could be helpful, to mark the not finished ones as doomed if the
      # job has an exception and terminates.
    })

    jobs.append({
        'docid': job['docid']
      , 'type': '{0}_distributed'.format(job['type'])
      , 'id': jobid
      , 'order': order
    })

  dbOps.update({
        'started': datetime.now(pytz.utc)
        # important for parallel execution, to piece together the original
        # order again. The items in the execution_order list are JSON
        # formatted strings and can be used as keys.
      , 'iterargs': runner.iterargs
      , 'test_descriptions': {test.id: test.description
                                        for _, test, _ in runner.order}
        # and to have a place where the sub-workers can report
      , 'jobs': jobs_meta # record start and end times
      , 'tests': tests
      , 'results': {}
  })

  dispatch(queueData, job, jobs)

def dispatch_collectiontest_jobs(queueData, parent_job,jobs):
  options = pika.BasicProperties(
        # TODO: do we need persistent here?
        delivery_mode=2  # pika.spec.PERSISTENT_DELIVERY_MODE
  )
  # dispatch sub jobs
  for job in jobs:
    job['family'] = parent_job['family']
    content = json.dumps(job)
    _dispatch(queueData, job, content)

def dispatch_draganddrop_jobs(queueData, parent_job, jobs):
  # dispatch sub jobs
  for job in jobs:
    job_bytes = json.dumps(job)
    content = b''.join([
        struct.pack('I', len(job_bytes))
      , job_bytes
      # this is still packed readily for us
      , parent_job['files_data']
    ])
    _dispatch(queueData, job, content)

def _dispatch(queueData, job, content):
  logging.debug('dispatching job %s of docid %s', job['id'], job['docid'])
  options = pika.BasicProperties(
        # TODO: do we need persistent here?
        delivery_mode=2  # pika.spec.PERSISTENT_DELIVERY_MODE
  )
  queueData.channel.basic_publish(exchange='', routing_key=queueData.name
                                      , body=content, properties=options)

from fontbakery.reporters import FontbakeryReporter
from fontbakery.message import Message
from fontbakery.testrunner import STARTTEST, ENDTEST, DEBUG
class DashbordWorkerReporter(FontbakeryReporter):
  def __init__(self, dbOps, jobid, specification, runner, **kwd):
    super(DashbordWorkerReporter, self).__init__(runner=runner, **kwd)
    self._dbOps = dbOps
    self._jobid = jobid
    self._spec = specification
    self.doc = []
    self._current = None

  def _register(self, event):
    super(DashbordWorkerReporter, self)._register(event)
    status, message, identity = event
    section, test, iterargs = identity
    if not test:
      return

    key = self._spec.serialize_identity(identity)

    if status == STARTTEST:
        self._current = {
            'job_id': self._jobid # for debugging/analysis tasks
          , 'statuses': []
        }

    if status == ENDTEST:
        # Do more? Anything more would make access easier but also be a
        # derivative of the actual data, i.e. not SSOT. Calculating (and
        # thus interpreting) results for the tests is probably not too
        # expensive to do it on the fly.
        self._current['result'] = message.name
        self._flush_result(key, self._current)
        self._current = None

    if status >= DEBUG:
      # message can be a lot here, currently we know about:
      #    string, an Exception, a Message. Probably we should leave it
      #    like this. Message should be the ultimate answer if it's not
      #    an Exception or a string.
      # turn everything in a fontbakery/Message like object
      # `code` may be used for overwriting special failing statuses
      # otherwise, code must be none
      #
      # Optional keys are:
      #  "code": used to explicitly overwrite specific (FAIL) statuses
      #  "traceback": only provided if message is an Excepion and likely
      #               if status is "ERROR"
      log = {'status': status.name}

      if hasattr(message, 'traceback'):
        # message is likely a FontbakeryError if this is not None
        log['traceback'] = message.traceback
      if isinstance(message, Message):
        # Ducktyping could be a valid option here.
        # in that case, a FontbakeryError could also provide a `code` attribute
        # which would allow to skip that error explicitly. However
        # ERROR statuses should never be skiped explicitly, the cause
        # of the error must be repaired!
        log.update(message.getData())
      else:
        log['message'] = '{}'.format(message)
      self._current['statuses'].append(log)

  def _flush_result(self, key, test_result):
    """ send test_result to the retthinkdb document"""
    self._dbOps.insert_test(key, test_result)

def _run_fontbakery(dbOps, job, fonts):
  dbOps.update({'started': datetime.now(pytz.utc)})
  runner, spec = get_fontbakery(fonts)
  order = spec.deserialize_order(job['order'])
  reporter = DashbordWorkerReporter(dbOps, job['id'],
                                      specification=spec, runner=runner)
  reporter.run(order)
  dbOps.update({'finished': datetime.now(pytz.utc)})
  # TODO: when all jobs are finished, we should have a worker that
  # is cleaning up ... that could be part of the dispatch worker
  # initiating and cleaning up would make some sense...
  # THUS: this would probably dispatch a queue message, that it has finished
  #       (in any case: successful OR not!)
  # The dispatch worker would A) mark the whole test documnet as `isFinished`
  # and, if part of a collection test, dispatch another queue message for
  # the manifest master (sociopath) to clean up and mark as finished the
  # test document.
  #
  # So TODO here: postmortem messages
  #    - as sender:  basically the same for checker-worker to dispatcher-worker
  #                                 and for dispatcher-worker to manifest-sociopath
  #    - as receiver for: dispatcher-worker from many checker-workers
  #                   and manifest-sociopath from many dispatcher-worker
  #    - the manifest-sociopath could be implemented here. CAUTION: the
  #                   worker that dispatches collection-tests is meant here
  #                   needs better role description!
  #                   ALSO, how does a drag and drop job enter the process?
  #                   someone has to dispatch to a dispatcher-worker and
  #                   clean up it's answer!

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
    Write job['files'] to tmpDirectory.

    Returns a list of log messages for each file in job['files'], some may
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
  for desc, data in job['files']:
    filename = desc['filename']
    if not validate_filename(seen, filename):
      continue

    seen.add(filename)
    if tmpDirectory is not None:
      path = os.path.join(tmpDirectory, filename)
      with open(path, 'wb') as f:
        f.write(data)
    else:
      path = filename

    logs.append('Added file "{}".'.format(filename))
    if path.endswith('.ttf'):
      fontfiles.append(path)

  if len(fontfiles) == 0:
    raise FontbakeryPreparationError('Could not find .ttf files in job.')
  return logs, fontfiles

def worker_run_fontbakery(dbOps, queueData, job, prepare):   # pylint: disable=unused-argument
  # TODO: it would be nice to get rid of tmpDirectory, but some tests
  # expect a tmpDirectory. Maybe we can differentiate the jobs in the
  # future, split in those who need a tmpDir and those who don't.
  # A (tmp_)directory condition could even handle this from within fontbakery
  # e.g. the ms fontvalidator would require a `directory` and it would be
  # created on the fly. Though, fontbakery would have to clean it up
  # again as well, which is not yet supported!
  with tempdir() as tmpDirectory:
    logging.info('Tempdir: %s', tmpDirectory)
    logs, fonts = prepare(tmpDirectory, job)
    logging.debug('Files in tmp {}'.format(os.listdir(tmpDirectory)))
    logging.info('Starting run_fontbakery ...')
    # got these logs in distribute for the entire doc (a dry run)
    # but also uses prepare
    # this should produce a very similar log.
    # with dbTableContext() as (q, conn):
    #   ATTENTION: this would have to go to the job item at `jobs[job["id"]]`
    #   q.get(job['docid']).update({'preparation_logs': logs}).run(conn)
    _run_fontbakery(dbOps, job, fonts)

def _unpack_files(stream, description_only=False):
  while True:
    head = stream.read(8)
    if len(head) != 8:
      break
    jsonlen, filelen = struct.unpack('II', head)

    desc = stream.read(jsonlen)
    assert len(desc) == jsonlen, 'Stream was long enough to contain JSON-data.'
    desc = json.loads(desc.decode('utf-8'))
    if description_only:
      yield (desc, None)
      # advance the stream for `filelen` from `SEEK_CUR` (current position)
      stream.seek(filelen, SEEK_CUR)
      continue
    # also yield the bytes of file
    filedata = stream.read(filelen)
    assert len(filedata) == filelen, 'Stream was long enough to contain file-data.'
    yield (desc, filedata)

def parse_job(stream):
  try:
    return json.loads(stream.read())
  except ValueError:# No JSON object could be decoded
    stream.seek(0) # reset
    return parse_draganddrop_style_job(stream)

def parse_draganddrop_style_job(stream):
  # read one Uint32\
  data_len = stream.read(4)
  data_len = struct.unpack('<I', data_len)[0]
  data = stream.read(data_len).decode('utf-8')

  try:
    job = json.loads(data)
    is_origin = False
  except ValueError:# No JSON object could be decoded
    # This is an assumption about how rethinkdb automatic id's work.
    # don't expect it to be forever true.
    # We should json decode it like so: '"{}"'.format(docid), then all
    # these lengths checks wouldn't really be needed.
    assert data_len == 36, 'Docid length should be 36 but is {0}.'.format(data_len)
    if len(data) != data_len:
      return None
    docid = data
    is_origin = True

  if not is_origin:
    job['files'] = list(_unpack_files(stream))
    return job

  # originial job
  cur = stream.tell()
  files_bytes = stream.read() # all to the end
  stream.seek(cur) # reset
  return {
      'docid': docid
    , 'type': 'draganddrop'
    , 'files': list(_unpack_files(stream, description_only=True))
    , 'files_data': files_bytes
  }

@contextmanager
def tempdir():
  # In python 3.7 there's a contextmanager: TemporaryDirectory
  tmpDirectory =  tempfile.mkdtemp()
  yield tmpDirectory
  shutil.rmtree(tmpDirectory)

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

def consume(dbTableContext, queueData, method, properties, body):  # pylint: disable=unused-argument
  logging.info('Consuming ...')
  logging.debug('consuming args: %s %s', method, properties)
  job = None
  dbOps = None
  try:
    job = parse_job(BytesIO(body))
    if job is not None:
      logging.debug('Got docid: %s a job of type: $s', job.get('docid', None), job.get('type', None))
      dbOps = DBOperations(dbTableContext, job['docid'], job.get('id', None))
      moreArgs = None
      if job['type'] == 'draganddrop':
        prepare = prepare_draganddrop_fontbakery
        worker = worker_distribute_jobs
        dispatch = dispatch_draganddrop_jobs
        moreArgs = [dispatch]
      elif job['type'] == 'draganddrop_distributed':
        prepare = prepare_draganddrop_fontbakery
        worker = worker_run_fontbakery
      elif job['type'] == 'collectiontest':
        prepare = prepare_collection_fontbakery
        worker = worker_distribute_jobs
        dispatch = dispatch_collectiontest_jobs
        moreArgs = [dispatch]
      elif job['type'] == 'collectiontest_distributed':
        prepare = prepare_collection_fontbakery
        worker = worker_run_fontbakery
      else:
        raise FontbakeryWorkerError('Job type has no dispatcher: {}'.format(job['type']))

      queueData.channel.basic_ack(delivery_tag=method.delivery_tag)
      worker(dbOps, queueData, job, prepare, *(moreArgs or []))
      logging.info('DONE! (job type: %s)', job['type'])
    else:
      logging.warning('Job is None, doing nothing')
  except Exception as e:
    # write to the DB doc
    # NOTE: we may have no docid here, if the message was lying or unparsable
    if job is not None and dbOps:
      # Report suppression of the error
      logging.exception('FAIL docid: %s', job['docid'])
      # It will be handy to know this from the client.
      exception = traceback.format_exc()
      # if there is a jobid, this is reported in the job, otherwise it
      # is reported in the doc.
      dbOps.update({'finished': datetime.now(pytz.utc)
                  , 'exception': exception
                  })
      logging.exception('Document closed exceptionally. %s', e)
    else:
      # Did not report this appropriately
      logging.exception('Can\'t report to data base document. %s', e)
      raise
  finally:
    # anything else to clean up?
    pass

    # FIXME: we really shouldn't ack the job if can't even mark it as
    # failed in the RethinkDB-doc.
    # publishing the job again, with increased retry count would be good
    # though. (Needs a retry count field on the job).

    # TODO: to keep jobs from disappearing (and also from being redelivered
    # forever), a dead-end queue could be created.
    # Also nice as a tactic would be to reinsert the job into the original
    # queue, but with an incremented retry count. After {n} retries we could
    # move it to the dead-end. That way, a temporary db failure or such would
    # not be a "job killer".

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

QueueData = namedtuple('QueueData', ['channel', 'name'])

def main(queue_name, db_name, db_table, consumefunc):
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
      queue_channel.queue_declare(queue=queue_name, durable=True)
      logging.info('Waiting for messages in %s...', queue_name)
      # BlockingChannel has a generator
      queue = QueueData(queue_channel, queue_name)
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

main(queue_name='drag_and_drop_queue', db_name='fontbakery', db_table='draganddrop'
     , consumefunc=consume)
