#!/usr/bin/env python
from __future__ import print_function, division, unicode_literals

import sys
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

class FontbakeryWorkerError(Exception):
  pass

class FontbakeryPreparationError(FontbakeryWorkerError):
  pass

class FontbakeryCommandError(FontbakeryWorkerError):
  pass

# FIXME: probably a method of specification
def serialize_order(order):
  # serialize session, test etc. in a way that we can identify them
  # and also that they can be a json document.
  # No need to keep the actual objects, just ids/names
  # an entry that means the same must be serialized the same
  # and deserialized without any loss!
  raise NotImplementedError('serialize_order')

# FIXME: requires the spec! probably a method of specification
def deserialize_order(order):
  # serialize session, test etc. in a way that we can identify them
  # and also that they can be a json document.
  # No need to keep the actual objects, just ids/names
  raise NotImplementedError('serialize_order')

def worker_distribute_jobs(dbTableContext, queue, job):
  full_order = fontbakery.get_order(files['desc'])
  # FIXME: do something fancy to split this up
  # maybe we can distribute long running tests evenly or such
  # this would require more info of course.
  jobs = 5  # go with 5 parallel jobs
  from math import ceil
  job_size = ceil(len(full_order) / jobs)
  orders = [full_order[i:i+job_size] \
                            for i in range(0, len(full_order), job_size)]
  docid = job['docid']
  jobs_meta = []
  jobs = []
  for jobid, order in enumerate(orders):
    # if split up in more jobs, these are created multiple times
    jobs_meta.append({
        'id': jobid
      , 'created': datetime.now(pytz.utc)
      , 'started': None
      , 'finished': None
    })
    jobs.append({
        'docid': docid
      , 'type': 'distributed'
      , 'id': jobid
      , 'order': spec.serialize_order(order)
      , 'files': None # will be filled by parse_job
    })

  with dbTableContext() as (q, conn):
    # important for parallel execution, to piece together the original
    # order again and to have a place where the sub-workers can report
    q.get(docid).update({
      'started': datetime.now(pytz.utc)
      # the items in the execution_order list are strings!
    , 'execution_order': spec.serialize_order(full_order)
    , 'jobs': jobs_meta # record start and end times
    , 'tests': []
    })

  options = pika.BasicProperties(
        # TODO: do we need persistent here?
        delivery_mode=pika.spec.PERSISTENT_DELIVERY_MODE # == 2
  )
  # dispatch sub jobs
  for sub_job in jobs:
    job_bytes = json.dumps(sub_job)
    content = b''.join([
        struct.pack('I', len(job_bytes))
      , job_bytes
      # this is still packed readily for us
      , job['files']['bytes']
    ])

    #log.info('sendToQueue doc', docid, 'job', sub_job['id'], 'queue', queueName
    #                                    , len(content), 'Bytes');

    # For point-to-point routing, the routing key is the name of a message queue.
    queue.channel.basic_publish(exchange=None, routing_key=queue.name
                                      , body=content, properties=options)

from fontbakery.reporters import FontbakeryReporter
class DashbordWorkerReporter(FontbakeryReporter):
  def __init__(self, dbTableContext, docid, jobid, runner, **kwd):
    super(SerializeReporter, self).__init__(runner=runner, **kwd)
    self._dbTableContext = dbTableContext
    self._docid = docid
    self._jobid = jobid

  def _flush_result(self, signature, test_result):
    # FIXME: it would be good if test_result was already the complete document
    # then we wouldn't have to amend signature and job_id in here.
    with self._dbTableContext() as (q, conn):
      q.get(self._docid)('tests').append({
          # this must equal the line in execution_order, a string
          # thus, probably the spec should serialize it
          'signature':
        , 'result': test_result
        , 'job_id': self._jobid # for debugging/analysis tasks
      });

def _run_fontbakery(dbTableContext, tmpDirectory, job):
  # TODO: it would be nice to get rid of tmpDirectory, but some tests
  # expect a tmpDirectory. Maybe we can differentiate the jobs in the
  # future, split in those who need a tmpDir and those who don't.
  # A (tmp_)directory condition could even handle this from within fontbakery
  # e.g. the ms fontvalidator would require a `directory` and it would be
  # created on the fly. Though, fontbakery would have to clean it up
  # again as well, which is not yet supported!

  # This is BAD because it has a race condition with the other jobs!
  # It actually always overrides all jobs, thus it may reset other jobs.
  # This is the example an internet search gives usually
  # worked in javascript:
  #    r.db('fontbakery').table('ballpark').get(key).update({
  #      jobs: r.row('jobs').map(function (job) {
  #        return r.branch(
  #            // 1. Which element(s) in the array you want to update
  #            job('id').eq(0),
  #            // 2. The change you want to perform on the matching elements
  #            job.merge({started: new Date()}),
  #            job)
  #      })
  #    }
  #   );
  # Python:
  # q.get(docid).update({
  #   "jobs": r.row('jobs').map(lambda job_row: r.branch(
  #         # 1. Which element(s) in the array you want to update
  #         job_row('id').eq(job['id']),
  #         # 2. The change you want to perform on the matching elements
  #         job_row.merge({'started': datetime.now(pytz.utc)}),
  #         job_row
  #   ))
  # })



  # worked in javascript:
  #    r.db('fontbakery').table('ballpark').get(key).update(
  #   {
  #     jobs: r.row('jobs').changeAt(1,
  #       r.row('jobs').nth(1).merge({started: new Date()}))
  #   }
  # );
  # This is GOOD since job-id is exclusive to this worker, there's no
  # race condition with other workers (maybe within this one!?).
  with dbTableContext() as (q, conn):
    q.get(docid).update({
      'jobs': r.row('jobs').changeAt(job['id'],
        # merge creates and returns a new object
        # thus, parallel access to job-id would be a race condition.
        r.row('jobs').nth(job['id']).merge({'started': datetime.now(pytz.utc)})
      )
    })

  order = spec.deserialize_order(job['order'])
  reporter = DashbordWorkerReporter(dbTableContext, docid, job['id']
                                                        , runner=runner)
  reporter.run(order)

  with dbTableContext() as (q, conn):
    q.get(docid).update({
      'jobs': r.row('jobs').changeAt(job['id'],
        # merge creates and returns a new object
        # thus, parallel access to job-id would be a race condition.
        r.row('jobs').nth(job['id']).merge({'finished': datetime.now(pytz.utc)})
      )
    })

def prepare_fontbakery(tmpDirectory, job):
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
  seen = set()
  for desc, data in job['files']:
    filename = desc['filename']
    # Basic input validation
    # Don't put any file into tmp containing a '/' or equal to '', '.' or '..'
    if filename in {'', '.', '..'} or '/' in filename:
      raise FontbakeryPreparationError('Invalid filename: "{0}".'.format(filename))

    if filename in seen:
      logs.append('Skipping duplicate file name "{0}".'.format(filename))
      continue

    if len(seen) == maxfiles:
      logs.append('Skipping file "{0}", max allowed file number {1} reached.'
                                                .format(filename, maxfiles))
      continue

    seen.add(filename)
    with open(os.path.join(tmpDirectory, filename), 'wb') as f:
      f.write(data)
      logs.append('Added file "{}".'.format(filename))
  return logs

def worker_run_fontbakery(dbTableContext, queue, job):  #pylint: disable=unused-argument
  with tempdir() as tmpDirectory:
    logging.info('Tempdir: %s', tmpDirectory)
    logs = prepare_fontbakery(tmpDirectory, job)
    logging.debug('Files in tmp {}'.format(os.listdir(tmpDirectory)))
    logging.info('Starting ...')
    with dbTableContext() as (q, conn):
      q.get(job['docid']).update({'preparation_logs': logs}).run(conn)
    _run_fontbakery(dbTableContext, tmpDirectory, job)

def _get_font_results(directory):
  marker = '.fontbakery.json'
  for f in os.listdir(directory):
    logging.debug('_get_font_results for "%s".', f)
    if not f.endswith(marker):
      continue
    fileName = f[:-len(marker)]
    with open(os.path.join(directory, f)) as io:
      results = json.load(io)
    yield fileName, results

def old_run_fontbakery(dbTableContext, docid, directory, jobid, order):
  files = []
  for f in os.listdir(directory):
    # TODO: allow also .woff .woff2 .otf in the future. Not urgent, though,
    # our google fonts needs are only ttf now.
    if f[-4:] == ".ttf":
      files.append(f)
  if len(files) == 0:
    raise FontbakeryPreparationError('Could not find .ttf files in job.')

  with dbTableContext() as (q, conn):
    q.get(docid).update({'started': datetime.now(pytz.utc)}).run(conn)

  cmd = ["fontbakery", "check-ttf", "--verbose", "--json"]
  cmd += [os.path.join(directory, f) for f in files]
  # FIXME: eventually we should get completely rid of this type of fontbakery
  # output. Until then, having it written to doc.stdout and doc.stderr would be
  # OK as well I guess.
  p = Popen(cmd, stdout=PIPE, stderr=PIPE)
  stdout, stderr = p.communicate()

  with dbTableContext() as (q, conn):
    q.get(docid).update({
      'command': cmd,
      'stderr': stderr.decode('utf-8'),
      'stdout': stdout.decode('utf-8')
    }).run(conn)


  if p.returncode != 0:
    raise FontbakeryCommandError('Exit code was not zero: "{0}". See "stderr".'.format(p.returncode))

  allResults = {}
  for resultFile, results in _get_font_results(directory):
    logging.debug('Saving result document "%s".', resultFile)
    allResults[resultFile] = results;
  with dbTableContext() as (q, conn):
    q.get(docid).update({'results': allResults}).run(conn)

  with dbTableContext() as (q, conn):
    q.get(docid).update({'isFinished': True
                      , 'finished': datetime.now(pytz.utc)}).run(conn)

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
      yield desc
      # advance the stream for `filelen` from `SEEK_CUR` (current position)
      stream.seek(filelen, SEEK_CUR)
      continue
    # also yield the bytes of file
    filedata = stream.read(filelen)
    assert len(filedata) == filelen, 'Stream was long enough to contain file-data.'
    yield (desc, filedata)

def parse_job(stream):
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
    assert data_len == 36, 'DocidLen is 36: {0}.'.format(docidLen)
    if len(docid) != data_len:
      return None
    docid = data
    is_origin = True

  if !is_origin:
    job['files'] = list(_unpack_files(stream))
    return job

  # originial job
  cur = stream.tell()
  files_bytes = stream.read() # all to the end
  stream.seek(cur) # reset
  descriptions = list(_unpack_files(stream, description_only=True))
  return {
      'docid': docid
    , 'type': 'origin'
    , 'files': {'desc': descriptions, 'bytes': files_bytes}
  }

@contextmanager
def tempdir():
  # In python 3.7 there's a contextmanager: TemporaryDirectory
  tmpDirectory =  tempfile.mkdtemp()
  yield tmpDirectory
  shutil.rmtree(tmpDirectory)

def consume(dbTableContext, queue, method, properties, body): #pylint: disable=unused-argument
  logging.info('Consuming ...')
  logging.debug('consuming args: %s %s', method, properties)
  job = None
  try:
    job = parse_job(BytesIO(body))
    if job is not None:
      logging.debug('Got docid: %s a job of type: $s', job['docid'], job['type'])
      if job['type'] == 'origin':
        worker_distribute_jobs(dbTableContext, queue, job)
      else if job['type'] == 'distributed':
        worker_run_fontbakery(dbTableContext, queue, job)
      else:
        raise FontbakeryWorkerError('Job type has no dispatcher: {}'.format(job['type']))
      logging.info('DONE!')
    else:
      logging.warning('Job is None, doing nothing')
  except Exception:
    # write to the DB doc
    # NOTE: we may have no docid here, if the message was lying or unparsable
    if job is not None:
      docid = job['docid']
      # Report suppression of the error
      logging.exception('FAIL docid: %s', docid)
      # It will be handy to know this from the client.
      exception = traceback.format_exc()
      with dbTableContext() as (q, conn):
        q.get(docid).update({
                              'isFinished': True
                            , 'finished': datetime.now(pytz.utc)
                            , 'exception': exception
                            }).run(conn)
      logging.debug('Document closed exceptionally.')
    else:
      # Did not report this appropriately
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
    queue_channel.basic_ack(delivery_tag=method.delivery_tag)

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

  print ('RethinkDB', 'HOST', db_host, 'PORT', db_port)

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
      logging.info('Waiting for messages...')
      # BlockingChannel has a generator
      queue = QueueData(queue_channel, queue_name)
      for method, properties, body in queue.channel.consume(queue.name):
        consumefunc(dbTableContext, queue, method, properties, body)
    except pika.exceptions.ConnectionClosed as e:
      logging.warning('RabbitMQ not ready yet.', exc_info=True)
      time.sleep(1)
    finally:
      if connection and connection.is_open and not connection.is_closing:
        connection.close()
        if queue_channel and queue_channel.is_open and not queue_channel.is_closing:
          queue_channel.close()

main(queue_name='drag_and_drop_queue', db_name='fontbakery', db_table='draganddrop'
     , consumefunc=consume)
