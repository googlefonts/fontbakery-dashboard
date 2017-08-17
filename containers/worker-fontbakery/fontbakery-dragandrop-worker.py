#!/usr/bin/env python
from __future__ import print_function

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

class FontbakeryWorkerError(Exception):
  pass

class FontbakeryPreparationError(FontbakeryWorkerError):
  pass

class FontbakeryCommandError(FontbakeryWorkerError):
  pass


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

def serialize_order(order):
  # serialize session, test etc. in a way that we can identify them
  # and also that they can be a json document.
  # No need to keep the actual objects, just ids/names
  raise NotImplementedError('serialize_order')

def distribute_jobs(dbTableContext, job):
  full_order = fontbakery.get_order(files['desc'])

  # FIXME: do something fancy to split this up
  orders = [ full_order ]
  docid = job['docid']
  jobid = 0 # equals the job-index!
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
      , 'order': serialize_order(order)
      , 'files': None # will be filled by parse_job
    })

  with dbTableContext() as (q, conn):
    # important for parallel execution, to piece together the original
    # order again and to have a place where the sub-workers can report
    q.get(docid).update({
      'started': datetime.now(pytz.utc)
    , 'execution_order': serialize_order(full_order)
    , 'jobs': jobs_meta # record start and end times
    })

  queue_options = {
        # TODO: do we need persistent here?
        'persistent': True
        # this? , 'deliveryMode': True
  }
  # dispatch sub jobs
  for sub_job in jobs:
    FIXME: a stub
    job_bytes = json.dumps(sub_job)
    content = b''.join([
        struct.pack('I', len(job_bytes))
      , job_bytes
      # this is still packed readily for us
      , job['files']['bytes']
    ])

    #log.info('sendToQueue doc', docid, 'job', sub_job['id'], 'queue', queueName
    #                                    , len(content), 'Bytes');
    queue_channel.sendToQueue(queueName, content, options);

def run_fontbakery(dbTableContext, tmpDirectory, job):
  # fixme: get rid of fontbakery
  with dbTableContext() as (q, conn):
    q.get(docid).update({'isFinished': True
                      , 'finished': datetime.now(pytz.utc)}).run(conn)

def run_fontbakery(dbTableContext, docid, directory, jobid, order):
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



def consume(dbTableContext, ch, method, properties, body): #pylint: disable=unused-argument
  logging.info('Consuming ...')
  logging.debug('consuming args: %s %s', method, properties)
  job = None
  docid = None
  tmpDirectory = None
  try:
    job = parse_job(BytesIO(body))
    if job is not None:
      docid = job['docid']
      logging.debug('Got docid: %s a job of type: $s', job['docid'], job['type'])
      if job['type'] == 'origin':
        distribute_jobs(dbTableContext, job)
      else:
        tmpDirectory =  tempfile.mkdtemp()
        logging.info('Tempdir: %s', tmpDirectory)
        logs = prepare_fontbakery(tmpDirectory, job)
        logging.debug('Files in tmp {}'.format(os.listdir(tmpDirectory)))
        logging.info('Starting ...')
        with dbTableContext() as (q, conn):
          q.get(docid).update({'preparation_logs': logs}).run(conn)
        run_fontbakery(dbTableContext, tmpDirectory, job)
      else:
        # fixme: tmpDirectory! we should be able to directly load the blobs
        # as
        run_fontbary(dbTableContext, job, tmpDirectory)

      logging.info('DONE!')
    else:
      logging.warning('Job is None, doing nothing')
  except Exception:
    # write to the DB doc
    # NOTE: we may have no docid here, if the message was lying or unparsable
    if docid is not None:
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
    if tmpDirectory is not None:
      # remove all temp files
      shutil.rmtree(tmpDirectory)

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
    ch.basic_ack(delivery_tag=method.delivery_tag)


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

def main():
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

  dbTableContext = partial(get_db, db_host, db_port, 'fontbakery', 'draganddrop')

  queue_name='drag_and_drop_queue'
  # FIXME: Where would BROKER be set? RABBITMQ_SERVICE_SERVICE_HOST is
  # set by kubernetes for the service named "rabbitmq-service" AFAIK
  msgqueue_host = os.environ.get("RABBITMQ_SERVICE_SERVICE_HOST", os.environ.get("BROKER"))
  callback = partial(consume, dbTableContext)

  while True:
    connection = None
    channel = None
    try:
      connection = pika.BlockingConnection(pika.ConnectionParameters(host=msgqueue_host))
      channel = connection.channel()
      channel.basic_qos(prefetch_count=1)
      channel.queue_declare(queue=queue_name, durable=True)
      channel.basic_consume(callback,
                            queue=queue_name)
      logging.info('Waiting for messages...')
      channel.start_consuming()
    except pika.exceptions.ConnectionClosed as e:
      logging.warning('RabbitMQ not ready yet.', exc_info=True)
      time.sleep(1)
    finally:
      if connection and connection.is_open and not connection.is_closing:
        connection.close()
        if channel and channel.is_open and not channel.is_closing:
          channel.close()

main()
