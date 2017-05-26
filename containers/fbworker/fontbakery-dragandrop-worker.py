#!/usr/bin/env python
from __future__ import print_function
from dateutil import parser
import json
import os
import pika
import rethinkdb as r
from subprocess import  Popen, PIPE
import sys
import time
import urllib

def calc_font_stats(results):
  stats = {
    "Total": len(results.keys()),
    "OK": 0
  }
  for k in results.keys():
    result = results[k]['result']
    if result not in stats.keys():
      stats[result] = 1
    else:
      stats[result] += 1
  return stats


def update_global_stats(summary, stats):
  for k in stats.keys():
    if k in summary.keys():
      summary[k] += stats[k]
    else:
      summary[k] = stats[k]

def save_output_on_database(commit, output):
  data = {"commit": commit, "familyname": FAMILYNAME, "output": output}
  print ("save_output_on_database: '{}' [{}]".format(FAMILYNAME, commit))
  if db.table('fb_log').filter({"commit": commit, "familyname": FAMILYNAME}).count().run() == 0:
    db.table('fb_log').insert(data).run()
  else:
    db.table('fb_log').filter({"commit": commit, "familyname": FAMILYNAME}).update(data).run()


def save_results_on_database(f, fonts_dir, commit, i, family_stats, date):
#  print ("Invoked 'save_results_on_database' with f='{}'".format(f))
  if f[-20:] != ".ttf.fontbakery.json":
#    print("Not a report file.")
    return

  print ("Check results JSON file: {}".format(f))
  fname = f.split('.fontbakery.json')[0]
  family_stats['familyname'] = FAMILYNAME
  data = open(fonts_dir + "/" + f).read()
  results = json.loads(data)
  font_stats = calc_font_stats(results)
  update_global_stats(family_stats['summary'], font_stats)
  check_results = {
    "giturl": REPO_URL,
    "results": results,
    "commit": commit,
    "fontname": fname,
    "familyname": FAMILYNAME,
    "date": date,
    "stats": font_stats,
    "HEAD": (i==0)
  }

  if db.table('check_results').filter({"commit": commit, "fontname":fname}).count().run() == 0:
    db.table('check_results').insert(check_results).run()
  else:
    db.table('check_results').filter({"commit": commit, "fontname":fname}).update(check_results).run()


def save_overall_stats_to_database(db, family_stats):
  print ("save_overall_stats_to_database:\nstats = {}".format(family_stats))
  if db.table('cached_stats').filter({"commit":commit, "giturl": REPO_URL, "familyname": FAMILYNAME}).count().run() == 0:
    db.table('cached_stats').insert(family_stats).run()
  else:
    db.table('cached_stats').filter({"commit":commit, "giturl": REPO_URL, "familyname": FAMILYNAME}).update(family_stats).run()


def run_fontbakery(dbTable, doc, directory):
  files = []
  for f in os.listdir(directory):
    # TODO: allow also .woff .woff2 .otf in the future. Not urgent, though,
    # our google fonts needs are only ttf
    if f[-4:] == ".ttf":
      # Do we need to escape spaces in the fullpaths here?
      files.append(f)

  # TODO: all files in doc.files that are not in files should be marked as
  # wontCheck here

  if len(files) == 0:
    # TODO: use special Exception sub-class
    raise Exception('Could not find .ttf files in job.')

  cmd = ["fontbakery", "check-ttf", "--verbose", "--json"]
  cmd += [os.path.join(directory, f) for f in files]
  # FIXME: eventually we should get completely rid of this type of fontbakery
  # output. Until then, having it written to doc.stdout and doc.stderr would be
  # OK as well I guess.

  p = Popen(cmd, stdout=PIPE, stderr=PIPE)
  stdout, stderr = p.communicate()

  dbTable.get(doc.id).update({
    command: cmd,
    stderr: stderr,
    stdout: stdout
  }).run()


  for f in os.listdir("."):
    save_results_on_database(f, ".", commit, -1, family_stats, None)

  save_overall_stats_to_database(commit, family_stats)



connection = None
def consume(dbTable, ch, method, properties, body): #pylint: disable=unused-argument
  print('consume', method, properties)

  try:
    job =
    doc = dbTable.get(job.docid).run()
    # unpack and prepare message
    # TODO: do basic input validation
    # like, don't put any file into tmp containing a '/' or equal to '', '.' or '..'
    # actually that could be just an fatal Exception.
    # also, double files should be marked as double, or be renamed
    # A limit on the file number would also be good I guess.
    tmpDirectory =
    run_fontbakery(dbTable, doc, tmpDirectory)
  except Exception as e:
    # write to the db doc
    # NOTE: we may have no docid here, if the message was lying or unparsable
    dbTable.get(job.docid)
            # e.msg is a bit thin, would be nice to have more info here
           .update({'isFinished': True, 'exception': e.msg})
           .run()
  finally:
      # remove all temp files

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
  os.chdir("/")

  db_host = os.environ.get("RETHINKDB_DRIVER_SERVICE_HOST")
  db_port = os.environ.get("RETHINKDB_DRIVER_SERVICE_PORT", 28015)
  r.connect(db_host, db_port).repl()
  db = r.db('fontbakery')
  dbTable = db.table('draganddrop')

  # FIXME: Where would BROKER be set? RABBITMQ_SERVICE_SERVICE_HOST is
  # set by kubernetes for the service named "rabbitmq-service" AFAIK
  msgqueue_host = os.environ.get("RABBITMQ_SERVICE_SERVICE_HOST", os.environ.get("BROKER"))

  callback = lambda *args: consume(dbTable, *args)

  while True:
    try:
      connection = pika.BlockingConnection(pika.ConnectionParameters(host=msgqueue_host))
      channel = connection.channel()
      channel.queue_declare(queue='drag_and_drop_queue', durable=True)
      print('Waiting for messages...', file=sys.stderr)
      channel.basic_qos(prefetch_count=1)
      channel.basic_consume(callback,
                            queue='font_repo_queue')
      channel.start_consuming()
    except pika.exceptions.ConnectionClosed:
      print ("RabbitMQ not ready yet.", file=sys.stderr)
      time.sleep(1)

main()

