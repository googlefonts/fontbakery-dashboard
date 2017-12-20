#!/usr/bin/env python
from __future__ import print_function, division, unicode_literals

import pytz
from datetime import datetime
from copy import deepcopy
from protocolbuffers.messages_pb2 import FamilyJob
from worker.fontbakeryworker import (
                  main
                , get_fontbakery
                , FontbakeryWorker
                , logging
                )
from fontbakery.reporters import FontbakeryReporter
from fontbakery.message import Message
from fontbakery.checkrunner import STARTCHECK, ENDCHECK, DEBUG

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

    if status == STARTCHECK:
        self._current = {
            'job_id': self._jobid # for debugging/analysis tasks
          , 'statuses': []
        }

    if status == ENDCHECK:
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


class WorkerChecker(FontbakeryWorker):
  def __init__(self, dbTableContext, queue, cache):
      super(WorkerChecker, self).__init__(dbTableContext, queue, cache)
      self._with_tempdir = True
      self._JobType = FamilyJob

  def _work(self, fonts):
    self._dbOps.update({'started': datetime.now(pytz.utc)})
    runner, spec = get_fontbakery(fonts)
    order = spec.deserialize_order(self._job.order)
    reporter = DashbordWorkerReporter(self._dbOps, self._job.jobid,
                                        specification=spec, runner=runner)
    reporter.run(order)
    self._dbOps.update({'finished': datetime.now(pytz.utc)})

  def _finalize(self):
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
    The dispatch worker would A) mark the whole test document as `finished`
    and, if part of a collection test, dispatch another queue message for
    the manifest master (sociopath) to clean up and mark as finished the
    test document.

    TODO here: postmortem messages
      - as sender:  basically the same for checker-worker to dispatcher-cleanup
                                    and for dispatcher-cleanup to manifest-master-cleanup
      - as receiver for: dispatcher-worker from many checker-workers
                      and manifest-sociopath from many dispatcher-worker
      - the manifest-sociopath could be implemented here. CAUTION: the
                      worker that dispatches collection-tests is meant here
                      needs better role description!
                      ALSO, how does a drag and drop job enter the process?
                      someone has to dispatch to a dispatcher-worker and
                      clean up it's answer!
    good case:
      The finishedMessage is queued for each checker worker that's not
      in pod restart back-off loop i.e. where _run could write `finished`
      to a job.

      assert finishedMessage.jobid has a finished field
                    OR set it yourself and put a warning message there.
                    "Did not finish itself, this should be highly irregular."

      Eventually all checker workers have a `finished` field.
      Then (all not in a particular order)
          * the family test can write it's `finished` field
          * if it has a collectionTest, dispatch a finishedMessage for that
          * purge the cache
      Then ack the queue message

    bad case:
      some/one worker checkers don't ever emit the finishedMessage
      The worst thing here is that the cache will keep the data forever
      so maybe we can add a mechanism to eventually end a job and purge
      all caches. It's not so bad when we don't get the appropriate finished
      fields set, but that would be done in the same run.
      see: Scheduling Messages with RabbitMQ
          https://www.rabbitmq.com/blog/2015/04/16/scheduling-messages-with-rabbitmq/
      also: RabbitMQ Delayed Message Plugin
          https://github.com/rabbitmq/rabbitmq-delayed-message-exchange/
      But probably, some kind of cron pod would also work.
      https://kubernetes.io/docs/concepts/workloads/controllers/cron-jobs/
      NOTE Cron Job Limitations: "... Therefore, jobs should be idempotent."
    """

    # For the time being just send a FamilyJob just like the
    # one that is self._job, but leave out the job.order, because that is
    # not interesting anymore.
    message = deepcopy(self._job)
    # In py 2.7 got an TypeError: field name must be a string
    # if using u'order', which is the default, we import unicode_literals
    message.ClearField(b'order')
    #logging.debug('dispatching job %s of docid %s', job.jobid, job.docid)
    self._queue_out(message)


main(queue_in_name='fontbakery-worker-checker'
   , queue_out_name='fontbakery-cleanup-distributor'
   , db_name='fontbakery', db_table='familytests'
   , Worker=WorkerChecker)
