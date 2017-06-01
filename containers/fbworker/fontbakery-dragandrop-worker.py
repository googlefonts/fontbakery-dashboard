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
from io import BytesIO
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

def _get_font_results(directory):
  marker = 'fontbakery.json'
  for f in os.listdir(directory):
    logging.debug('_get_font_results for "%s".', f)
    if not f.endswith(marker):
      continue
    fileName = f[:-len(marker)]
    with open(os.path.join(directory, f)) as io:
      results = json.load(io)
    yield fileName, results

def run_fontbakery(dbTableContext, docid, directory):
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


  allResults = {}
  for resultFile, results in _get_font_results(directory):
    logging.debug('Saving result document "%s".', resultFile)
    allResults[resultFile] = results;
  with dbTableContext() as (q, conn):
    q.get(docid).update({'results': allResults}).run(conn)

  with dbTableContext() as (q, conn):
    q.get(docid).update({'isFinished': True
                      , 'finished': datetime.now(pytz.utc)}).run(conn)

def _unpack_files(stream):
    # L = unsignedlong 4 bytes
    while True:
      head = stream.read(8)
      if len(head) != 8:
        break
      jsonlen, filelen = struct.unpack('II', head)

      desc = stream.read(jsonlen)
      assert len(desc) == jsonlen, 'Stream was long enough to contain JSON-data.'
      desc = json.loads(desc.decode('utf-8'))

      filedata = stream.read(filelen)
      assert len(filedata) == filelen, 'Stream was long enough to contain file-data.'

      yield (desc, filedata)

def parse_job(stream):
  # read one Uint32\
  docidLen = stream.read(4)
  docidLen = struct.unpack('<I', docidLen)[0]
  # This is an assumption about how rethinkdb automatic id's work.
  # don't expect it to be forever true.
  assert docidLen == 36, 'DocidLen is 36: {0}.'.format(docidLen)
  docid = stream.read(docidLen).decode('utf-8')
  if len(docid) != docidLen:
    return None

  files = []
  for desc_filedata in _unpack_files(stream):
    files.append(desc_filedata)

  return {'docid':docid, 'files': files}

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
  tmpDirectory =  tempfile.mkdtemp()
  job = None
  docid = None
  try:
    job = parse_job(BytesIO(body))
    if job is not None:
      docid = job['docid']
      logging.debug('Got docid: %s', docid)
      logs = prepare_fontbakery(tmpDirectory, job)
      logging.debug('Files in tmp {}'.format(os.listdir(tmpDirectory)))
      logging.info('Starting ...')
      with dbTableContext() as (q, conn):
        q.get(docid).update({'prepLogs': logs}).run(conn)
      run_fontbakery(dbTableContext, docid, tmpDirectory)
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
  setLoglevel(os.environ.get("WORKER_LOG_LEVEL", 'INFO'))

  db_host = os.environ.get("RETHINKDB_DRIVER_SERVICE_HOST")
  db_port = os.environ.get("RETHINKDB_DRIVER_SERVICE_PORT", 28015)
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
