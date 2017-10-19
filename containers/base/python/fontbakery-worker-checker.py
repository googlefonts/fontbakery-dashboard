#!/usr/bin/env python
from __future__ import print_function, division, unicode_literals

import os
import pytz
from datetime import datetime
import traceback
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
  order = spec.deserialize_order(job.distributedInfo.order)
  reporter = DashbordWorkerReporter(dbOps, job.distributedInfo.id,
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

def worker_run_fontbakery(dbOps, queueData, job, prepare):   # pylint: disable=unused-argument
  # TODO: it would be nice to get rid of tmpDirectory, but some tests
  # expect a tmpDirectory. Maybe we can differentiate the jobs in the
  # future, split in those who need a tmpDir and those who don't.
  # A (tmp_)directory condition could even handle this from within fontbakery
  # e.g. the ms fontvalidator would require a `directory` and it would be
  # created on the fly. Though, fontbakery would have to clean it up
  # again as well, which is not yet supported!
  logging.info('worker_run_fontbakery: docid %s jobid %s number of tests %s'
        , job.docid, job.distributedInfo.id, len(job.distributedInfo.order))
  with tempdir() as tmpDirectory:
    logging.info('Tempdir: %s', tmpDirectory)
    logs, fonts = prepare(tmpDirectory, job)
    logging.debug('Files in tmp {}'.format(os.listdir(tmpDirectory)))
    # got these logs in distribute for the entire doc (a dry run)
    # but also uses prepare
    # this should produce a very similar log.
    # with dbTableContext() as (q, conn):
    #   ATTENTION: this would have to go to the job item at `jobs[job.id]`
    #   q.get(job.docid).update({'preparation_logs': logs}).run(conn)
    _run_fontbakery(dbOps, job, fonts)

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
    if job.type != FamilyJob.DRAGANDDROP_DISTRIBUTED:
      raise FontbakeryWorkerError('Job type unknown: {}'.format(jobtype))

    dbOps = DBOperations(dbTableContext, job.docid, job.distributedInfo.id)
    worker_run_fontbakery(dbOps, queueData, job, prepare_draganddrop_fontbakery)
    # Temporarily disabled
    # elif job['type'] == 'collectiontest_distributed':
    #   prepare = prepare_collection_fontbakery
    #   worker = worker_run_fontbakery

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


main(queue_in_name='fontbakery-worker-checker', db_name='fontbakery', db_table='draganddrop'
     , consumefunc=consume)
