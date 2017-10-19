#!/usr/bin/env python
from __future__ import print_function, division, unicode_literals

import pytz
from datetime import datetime
import traceback
import pika
import logging
from protocolbuffers.messages_pb2 import FamilyJob

from worker import (
                  FontbakeryWorkerError
                , FontbakeryPreparationError
                , main
                , DBOperations
                , tempdir
                , logging
                , get_fontbakery
                , prepare_draganddrop_fontbakery
                , prepare_collection_fontbakery
                )

def worker_distribute_jobs(dbOps, queueData, job, prepare):
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

  # I figure a generator for this is cheaper on memory, but its effect
  # is only big if python copies, not references the bytes of
  # job.files in sub_job.files
  def jobs_generator(orders):
    for jobid, order in enumerate(orders):
      sub_job = FamilyJob()
      sub_job.docid = job.docid
      sub_job.files.extend(job.files)
      sub_job.type = FamilyJob.DRAGANDDROP_DISTRIBUTED
      sub_job.distributedInfo.id = jobid
      sub_job.distributedInfo.order.extend(order)
      yield sub_job

  jobs = jobs_generator(orders)
  for jobid, order in enumerate(orders):
    # if split up in more jobs, these are created multiple times
    jobs_meta.append({
        'id': jobid
      , 'created': datetime.now(pytz.utc)
      # the indexes in full_order of the tests this job is supposed to run
      # could be helpful, to mark the not finished ones as doomed if the
      # job has an exception and terminates.
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
  for job in jobs:
    dispatch(queueData, job)

# OLD:
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

def dispatch(queueData, job):
  logging.debug('dispatching job %s of docid %s', job.distributedInfo.id, job.docid)
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

  queueData.channel.basic_publish(exchange='', routing_key=queueData.distribute_name
                                , body=job.SerializeToString(), properties=options)

def consume(dbTableContext, queueData, method, properties, body):  # pylint: disable=unused-argument
  logging.info('Consuming ...')
  logging.debug('consuming args: %s %s', method, properties)
  job = None
  dbOps = None
  try:
    job = FamilyJob()
    job.ParseFromString(body)
    types = {v:k for k,v in FamilyJob.JobType.items()};
    jobtype = types[job.type];
    logging.debug('Got docid: %s a job of type: $s', job.docid, jobtype)
    if job.type != FamilyJob.DRAGANDDROP_ORIGIN:
      raise FontbakeryWorkerError('Job type unknown: {}'.format(jobtype))
    dbOps = DBOperations(dbTableContext, job.docid)
    worker_distribute_jobs(dbOps, queueData, job
                                        , prepare_draganddrop_fontbakery)
    # Temporarily disabled
    # elif job['type'] == 'collectiontest':
    #   prepare = prepare_collection_fontbakery
    #   worker = worker_distribute_jobs
    #   dispatch = dispatch_collectiontest_jobs
    #   moreArgs = [dispatch]
    logging.info('DONE! (job type: %s)', jobtype)
  except Exception as e:
    # write to the DB doc
    # NOTE: we may have no docid here, if the message was lying or unparsable
    if job is not None and dbOps:
      # Report suppression of the error
      logging.exception('FAIL docid: %s', job.docid)
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

  queueData.channel.basic_ack(delivery_tag=method.delivery_tag)
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

main(queue_in_name='fontbakery-worker-distributor', db_name='fontbakery', db_table='draganddrop'
     , consumefunc=consume, queue_out_name='fontbakery-worker-checker')
