#!/usr/bin/env python
from __future__ import print_function, division, unicode_literals

import pytz
from datetime import datetime
import traceback
import pika
import logging
from protocolbuffers.messages_pb2 import FamilyJob, DistributedFamilyJob

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

class WorkerDistributor(Worker)
  def __init__(dbTableContext, queue, cache):
      super(WorkerDistributor, self).__init__(dbTableContext, queue, cache)
      self._save_preparation_logs = True
      self._JobType = FamilyJob

  def _work(self, fonts):
    # this is a dry run, but it will fail early if there's a problem with
    # the files in job, also, it lists the fonts.
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

      sub_job = DistributedFamilyJob()
      sub_job.docid = self._job.docid
      sub_job.cacheKey = self._job.cacheKey
      sub_job.jobid = jobid
      sub_job.order.extend(order)
      jobs.append(sub_job)

    self._dbOps.update({
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
      self._dispatch(job)

  def _dispatch(self, job):
    logging.debug('dispatching job %s of docid %s', job.jobid, job.docid)
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
    channel,routing_key = (self._queueData.channel, self._queueData.distribute_name)
    channel.basic_publish(exchange=''
                        , routing_key=routing_key
                        , body=job.SerializeToString()
                        , properties=options)

main(queue_in_name='fontbakery-worker-distributor', db_name='fontbakery', db_table='draganddrop'
     , Worker=WorkerDistributor, queue_out_name='fontbakery-worker-checker')
