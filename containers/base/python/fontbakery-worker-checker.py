#!/usr/bin/env python
from __future__ import print_function, division, unicode_literals

import pytz
from datetime import datetime
from protocolbuffers.messages_pb2 import DistributedFamilyJob
from worker.fontbakeryworker import (
                , main
                , get_fontbakery
                , FontbakeryWorker
                )
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


class WorkerChecker(FontbakeryWorker):
  def __init__(dbTableContext, queue, cache):
      super(WorkerDistributor, self).__init__(dbTableContext, queue, cache)
      self._with_tempdir = True
      self._JobType = DistributedFamilyJob

  def _work(self, fonts):
    self._dbOps.update({'started': datetime.now(pytz.utc)})
    runner, spec = get_fontbakery(fonts)
    order = spec.deserialize_order(job.order)
    reporter = DashbordWorkerReporter(self._dbOps, job.jobid,
                                        specification=spec, runner=runner)
    reporter.run(order)
    self._dbOps.update({'finished': datetime.now(pytz.utc)})

main(queue_in_name='fontbakery-worker-checker', db_name='fontbakery', db_table='draganddrop'
     , Worker=WorkerChecker)
