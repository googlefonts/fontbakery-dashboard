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
import pika
import rethinkdb as r

def _get_font_results(directory):
  marker = 'fontbakery.json'
  for f in os.listdir(directory):
    print ('_get_font_results', f, file=sys.stderr)
    if not f.endswith(marker):
      continue
    fileName = f[:-len(marker)]
    with open(os.path.join(directory, f)) as io:
      results = json.load(io)
    yield fileName, results

def run_fontbakery(dbTable, doc, directory):
  files = []
  for f in os.listdir(directory):
    # TODO: allow also .woff .woff2 .otf in the future. Not urgent, though,
    # our google fonts needs are only ttf
    if f[-4:] == ".ttf":
      # Do we need to escape spaces in the fullpaths here?
      files.append(f)

  if len(files) == 0:
    # TODO: use special Exception sub-class
    raise Exception('Could not find .ttf files in job.')

  docid = doc['id']
  dbTable.get(docid).update({'started': datetime.now(pytz.utc)}).run()

  cmd = ["fontbakery", "check-ttf", "--verbose", "--json"]
  cmd += [os.path.join(directory, f) for f in files]
  # FIXME: eventually we should get completely rid of this type of fontbakery
  # output. Until then, having it written to doc.stdout and doc.stderr would be
  # OK as well I guess.
  p = Popen(cmd, stdout=PIPE, stderr=PIPE)
  stdout, stderr = p.communicate()

  dbTable.get(docid).update({
    'command': cmd,
    'stderr': stderr.decode('utf-8'),
    'stdout': stdout.decode('utf-8')
  }).run()

  for fontFile, results in _get_font_results(directory):
    print ('saving results for', fontFile, file=sys.stderr)
    item = {}
    item[fontFile] = results;
    dbTable.get(docid).update({'fonts': item}).run()

  dbTable.get(docid).update({'isFinished': True
                      , 'finished': datetime.now(pytz.utc)}).run()

def _unpack_files(stream):
    # L = unsignedlong 4 bytes
    while True:
        head = stream.read(8)
        if not head:
            break
        jsonlen, filelen = struct.unpack('II', head)
        desc = json.loads(stream.read(jsonlen).decode('utf-8'))
        filedata = stream.read(filelen)
        yield (desc, filedata)

def parse_job(stream):
  # read one Uint32\
  docidLen = stream.read(4)
  # print ('docidLen bytes:',  map(ord, list(docidLen)), file=sys.stderr)
  docidLen = struct.unpack('<I', docidLen)[0]
  if docidLen != 36:
    print('Dropping job, docidLen is not 36:', docidLen, file=sys.stderr)
    return None
  docid = stream.read(docidLen).decode('utf-8')
  files = []
  for desc_filedata in _unpack_files(stream):
    files.append(desc_filedata)

  return {'docid':docid, 'files': files}

def prepare_fontbakery(tmpDirectory, job):
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
        raise Exception('Invalid filename: "{0}".'.format(filename))

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
        logs.append('Added file "{0}".'.format(filename))
    return logs



def consume(dbTable, ch, method, properties, body): #pylint: disable=unused-argument
  print('consume', method, properties, file=sys.stderr)
  tmpDirectory =  tempfile.mkdtemp()
  job = None
  doc = None
  try:
    job = parse_job(BytesIO(body))
    if job is not None:
      print ('job docid is', job['docid'], file=sys.stderr)
      doc = dbTable.get(job['docid']).run()
    else:
      print ('job is None', file=sys.stderr)
    if doc is not None:
      print('doc is', doc, file=sys.stderr)
      logs = prepare_fontbakery(tmpDirectory, job)

      print('Files in tmp {}'.format(os.listdir(tmpDirectory)), file=sys.stderr)

      dbTable.get(doc['id']).update({'prepLogs': logs}).run()
      run_fontbakery(dbTable, doc, tmpDirectory)
    else:
      # FIXME: This happens even if doc is NOT None
      # (we got the docid from rethinkdb itself)
      print ('doc is None', file=sys.stderr)
  except Exception as e:
    # write to the db doc
    # NOTE: we may have no docid here, if the message was lying or unparsable
    if doc is not None:
      (dbTable.get(doc['id'])
            # e.msg is a bit thin, would be nice to have more info here
           .update({
                      'isFinished': True
                    , 'finished': datetime.now(pytz.utc)
                    , 'exception': '{}'.format(e)
                   })
           .run())
    traceback.print_exc(file=sys.stderr)
    raise e
  finally:
    # remove all temp files
    shutil.rmtree(tmpDirectory)

  # NOTE: This won't happen if we produce an error in the general
  # except block above, but that is intentional. If we can't log
  # the error message, the job will stay in the queue, we'll have to
  # find out what's up here.
  # TODO: to keep jobs from being recheckt forever, because we can't log
  # the error, a deadend queue could be created.
  # Also nice as a tactic would be to reinsert the job into the original
  # queue, but with an incremented retry count. After {n} retries we could
  # move it to the dead end. That way, a temporary db failure would not be
  # a "job killer".
  ch.basic_ack(delivery_tag = method.delivery_tag)


def main():
  db_host = os.environ.get("RETHINKDB_DRIVER_SERVICE_HOST")
  db_port = os.environ.get("RETHINKDB_DRIVER_SERVICE_PORT", 28015)
  r.connect(db_host, db_port).repl()
  db = r.db('fontbakery')
  dbTable = db.table('draganddrop')
  queue_name='drag_and_drop_queue'

  # FIXME: Where would BROKER be set? RABBITMQ_SERVICE_SERVICE_HOST is
  # set by kubernetes for the service named "rabbitmq-service" AFAIK
  msgqueue_host = os.environ.get("RABBITMQ_SERVICE_SERVICE_HOST", os.environ.get("BROKER"))

  callback = lambda *args: consume(dbTable, *args)

  while True:
    try:
      connection = pika.BlockingConnection(pika.ConnectionParameters(host=msgqueue_host))
      channel = connection.channel()
      channel.queue_declare(queue=queue_name, durable=True)
      print('Waiting for messages...', file=sys.stderr)
      channel.basic_qos(prefetch_count=1)
      channel.basic_consume(callback,
                            queue=queue_name)
      channel.start_consuming()
    except pika.exceptions.ConnectionClosed:
      print ("RabbitMQ not ready yet.", file=sys.stderr)
      time.sleep(1)
    finally:
      channel.close()
      connection.close()

main()
