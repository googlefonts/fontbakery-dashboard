#!/usr/bin/env python
from __future__ import print_function, division, unicode_literals

import os
import pytz

from datetime import datetime
from copy import deepcopy

from .worker_base import(
                        WorkerBase
                      , WorkerError
                      , PreparationError
                      )

from protocolbuffers.messages_pb2 import (
                                          FamilyJob
                                        , WorkerJobDescription
                                        , CompletedWorker
                                        )
from fontbakery.reporters import FontbakeryReporter
from fontbakery.message import Message
from fontbakery.checkrunner import STARTCHECK, ENDCHECK, DEBUG

RDB_FAMILYTESTS = 'familytests'


__private_marker = object()
def get_fontbakery(fonts):
  from fontbakery.commands.check_googlefonts import runner_factory
  runner = runner_factory(fonts)
  profile = runner.profile
  # This changes the profile object, which is not elegant.
  # It's a bug when we do it repeatedly, creating a deep call stack, like
  # a manually build recursion without end after a while.
  # The __private_marker is a hack to change the profile object
  # only once with this function.
  old_check_skip_filter = profile.check_skip_filter
  if not old_check_skip_filter or \
      getattr(old_check_skip_filter,'__mark', None) is not __private_marker:
    def check_skip_filter(checkid, font=None, **iterargs):
        # Familyname must be unique according to namecheck.fontdata.com
      if checkid == 'com.google.fonts/check/165':
        return False, ('Disabled for Fontbakery-Dashboard, see: '
                        'https://github.com/googlefonts/fontbakery/issues/1680')
      if old_check_skip_filter:
        return old_check_skip_filter(checkid, font, **iterargs)
      return True, None
    setattr(check_skip_filter,'__mark', __private_marker)
    profile.check_skip_filter = check_skip_filter
  return runner, profile

class DBOperations(object):
  def __init__(self, rethinkdb, job):
    # r, rdb_connection, db_name, table = rethinkdb
    self._rethinkdb = rethinkdb
    self._docid = job.docid
    self._jobid = job.jobid or None

  @property
  def q(self):
    r, _,  db_name, table = self._rethinkdb
    q = r.db(db_name).table(table)
    return q

  @property
  def r(self):
    r, *_ = self._rethinkdb
    return r

  @property
  def conn(self):
    _, rdb_connection, *_ = self._rethinkdb
    return rdb_connection

  @property
  def has_job(self):
    return self._jobid is not None

  def update(self, doc):
    if self.has_job:
      # even for this, `update` is supposed to be atomic.
      _doc = {
          'jobs': self.r.row['jobs'].merge({self._jobid: doc})
        }
    else:
      _doc = doc

    return self.q.get(self._docid).update(_doc).run(self.conn)

  def insert_checks(self, check_results):
    r = self.r
    doc = {
        'tests': r.row['tests'].merge(check_results)
      # increase the counter
      # FIXME: This is a denormalization, and we can most probably create
      # a rethinkdb query to fetch a results object like this on the fly.
      # This is mainly useful for the collection-wide test results view.
      # Maybe an on-the-fly created results object is fast enough. After all,
      # this is a classical case for an SQL database query.

      # This was the first version with the following problem:
      # if the worker is in a crashback loop and the same tests are
      # executed multiple times, the result fields can grow bigger than
      # their actual number i.e. total > len(tests), yet we may not be
      # finished with all tests.
      #, 'results': r.row['results'].merge(lambda results: {
      #    test_result['result']: results[test_result['result']].default(0).add(1)
      #})
      # this recreates the results dict on each insert
      # to avoid the race condition, the r.row['tests'] is recreated
      # here on the fly
        , 'results': r.row['tests'].merge(check_results)
                    .values()
                    .filter(lambda item: item.has_fields('result'))
                    .map(lambda item: item['result'])
                    .fold({}, lambda acc, result: acc.merge(
                        r.object(result, acc[result].default(0).add(1))))
    }

    result = self.q.get(self._docid).update(doc).run(self.conn)
    if result['errors']:
      raise WorkerError('RethinkDB: {}'.format(result['first_error']))


def validate_filename(logs, seen, filename):
  # Basic input validation
  # Don't put any file into tmp containing a '/' or equal to '', '.' or '..'
  if filename in {'', '.', '..'} or '/' in filename:
    raise PreparationError('Invalid filename: "{0}".'.format(filename))

  if filename in seen:
    logs.append('Skipping duplicate file name "{0}".'.format(filename))
    return False

  return True


def _prepare(job, cache, dbOps=None, tmp_directory=None):
  """
    Write files from the grpc.StorageServer to tmp_directory.

    Returns a list of log messages for each file in job.files, some may
    be skipped. This is to give the user direct feedback about the request
    made.

    Raises FontbakeryPreparationError if files appear to be invalid.
  """
  # `maxfiles` files should be small enough to not totally DOS us easily.
  # And big enough for all of our jobs, otherwise, change ;-)
  files = cache.get(job.cache_key).files
  maxfiles = 45
  logs = []
  if tmp_directory is None:
    logs.append('Dry run! tmp_directory is None.')
  seen = set()

  fontfiles = []
  for jobFile in files:
    filename = jobFile.name
    if not validate_filename(logs, seen, filename):
      continue

    seen.add(filename)
    if tmp_directory is not None:
      path = os.path.join(tmp_directory, filename)
      with open(path, 'wb') as f:
        f.write(jobFile.data)
    else:
      path = filename

    logs.append('Added file "{}".'.format(filename))
    if path.lower().endswith('.ttf') or path.lower().endswith('.otf'):
      fontfiles.append(path)

  if len(fontfiles) > maxfiles:
    raise PreparationError('Found {} font files, but maximum '
                    'is limiting to {}.'.format(len(fontfiles), maxfiles))

  # If this is a problem, fontbakery itself should have a check for
  # it. It improves the reporting! Also, this was limited to ".ttf"
  # suffixes, which should be done differently in the future as well.
  # if len(fontfiles) == 0:
  #   raise FontbakeryPreparationError('Could not find .ttf files in job.')
  if dbOps:
    dbOps.update({'preparation_logs': logs})
  return fontfiles


class DashbordWorkerReporter(FontbakeryReporter):
  def __init__(self, dbOps, jobid, profile, runner
                                          , ticks_to_flush = None, **kwd):
    super(DashbordWorkerReporter, self).__init__(runner=runner, **kwd)
    self._dbOps = dbOps
    self._jobid = jobid
    self._profile = profile;
    self.ticks_to_flush = ticks_to_flush or 1
    self.doc = []
    self._current = None
    self._collectedChecks = None

  def _register(self, event):
    super(DashbordWorkerReporter, self)._register(event)
    status, message, identity = event
    section, test, iterargs = identity
    if not test:
      return

    key = self._profile.serialize_identity(identity)

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
        self._save_result(key, self._current)
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

  def _save_result(self, key, test_result):
    """ send test_result to the retthinkdb document"""
    if self._collectedChecks is None:
      self._collectedChecks = {}
    self._collectedChecks[key] = test_result
    if len(self._collectedChecks) >= self.ticks_to_flush:
      self.flush()

  def flush(self):
    if self._collectedChecks:
      self._dbOps.insert_checks(self._collectedChecks)
    self._collectedChecks = None


class Distributor(WorkerBase):
  JobType=FamilyJob
  def __init__(self, logging, job, cache, rethinkdb, queue):
    self._log = logging
    self._job = job
    self._cache = cache
    # rethinkdb = (r, rdb_connection, rdb_name)
    rethinkdb = rethinkdb + (RDB_FAMILYTESTS, )
    self._dbOps = DBOperations(rethinkdb, job)
    self._queue = queue

  def _run(self, fonts):
    # this is a dry run, but it will fail early if there's a problem with
    # the files in job, also, it lists the fonts.
    runner, profile = get_fontbakery(fonts)

    # this must survive JSON
    full_order = list(profile.serialize_order(runner.order))
    tests = {identity:{'index':index}  for index, identity in enumerate(full_order)}

    # FIXME: do something fancy to split this up
    # maybe we can distribute long running tests evenly or such
    # this would require more info of course.
    jobs = len(fonts) + 1  # go with number of fonts plus one for not font specific checks parallel jobs
    self._log.info('worker_distribute_jobs: Splitting up into %s jobs.', jobs)

    from math import ceil
    job_size = int(ceil(len(full_order) / jobs))
    orders = [full_order[i:i+job_size]
                              for i in range(0, len(full_order), job_size)]

    jobs_meta = {}
    jobs = []
    for jobid, order in enumerate(orders):
      # if split up in more jobs, these are created multiple times
      jobid = '{}'.format(jobid) # must be string
      jobs_meta[jobid] = {
          'id': jobid
        , 'created': datetime.now(pytz.utc)
        # the indexes in full_order of the tests this job is supposed to run
        # could be helpful, to mark the not finished ones as doomed if the
        # job has an exception and terminates.
      }

      sub_job = FamilyJob()
      sub_job.docid = self._job.docid
      # this is not possible
      # sub_job.cache_key = self._job.cache_key
      sub_job.cache_key.CopyFrom(self._job.cache_key)
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
      self._log.debug('dispatching job %s of docid %s', job.jobid, job.docid)
      jobDescription = WorkerJobDescription()
      jobDescription.worker_name = 'fontbakery_checker'
      jobDescription.job.Pack(job)
      self._queue.worker(jobDescription)

  def run(self):
    # save_preparation_logs = True => dbOps is not None
    # self._with_tempdir = False => tmp_directory is None
    fonts = _prepare(self._job, self._cache, self._dbOps, None)
    # A checker-worker *MUST* write the correct 'finished' field for it's docid/jobid
    # A distributor-worker can not write finished in here.
    self._run(fonts)
    self._log.info('DONE! docid: %s', self._job.docid)

  def finalize(self, traceback, *exc):
    if traceback is None:
      # not failed
      return
    # FAILED!
    # Report suppression of the error
    self._log.exception('FAIL Document closed exceptionally. docid: '
                      '%s exception: %s', self._job.docid, traceback)
    # write to the DB doc
    # if there is a jobid, this is reported in the job, otherwise it
    # is reported in the doc.
    self._dbOps.update({'finished': datetime.now(pytz.utc)
                      , 'exception': traceback
                      })

    # If the Distributor worker fails we MUST send a CompletedWorker message.
    message = CompletedWorker()
    message.worker_name = 'fontbakery'
    message.completed_message.Pack(self._job)
    self._queue.end(message)
    return True # exception handled


class Checker(WorkerBase):
  JobType=FamilyJob
  def __init__(self, logging, job, cache, rethinkdb, queue, tmp_directory, ticks_to_flush):
    self._log = logging
    self._job = job
    self._cache = cache

    # rethinkdb = (r, rdb_connection, rdb_name)
    rethinkdb = rethinkdb + (RDB_FAMILYTESTS, )
    self._dbOps = DBOperations(rethinkdb, job)
    self._queue = queue
    self._tmp_directory = tmp_directory
    self._ticks_to_flush = ticks_to_flush

  def _run(self, fonts):
    self._dbOps.update({'started': datetime.now(pytz.utc)})
    runner, profile = get_fontbakery(fonts)
    order = profile.deserialize_order(self._job.order)
    reporter = DashbordWorkerReporter(self._dbOps, self._job.jobid,
                                        profile=profile
                                      , runner=runner
                                      , ticks_to_flush=self._ticks_to_flush
                                      , )
    reporter.run(order)
    # flush the rest
    reporter.flush()
    self._dbOps.update({'finished': datetime.now(pytz.utc)})

  def run(self):
    # save_preparation_logs = False => dbOps is None
    # self._with_tempdir = True => tmp_directory is not None
    fonts = _prepare(self._job, self._cache, None, self._tmp_directory)
    self._log.debug('Files in Tempdir {}: {}'.format(
                      self._tmp_directory, os.listdir(self._tmp_directory)))
    # A checker-worker *MUST* write the correct 'finished' field for it's docid/jobid
    # A distributor-worker can not write finished in here.
    self._run(fonts)
    self._log.info('DONE! docid: %s', self._job.docid)

  def finalize(self, traceback, *exc):
    if traceback is not None:
      # FAILED!
      # Report suppression of the error
      self._log.exception('FAIL Document closed exceptionally. docid: '
                      '%s exception: %s', self._job.docid, traceback)
      # write to the DB doc
      # if there is a jobid, this is reported in the job, otherwise it
      # is reported in the doc.
      self._dbOps.update({'finished': datetime.now(pytz.utc)
                        , 'exception': traceback
                        })
    # ALWAYS
    # For the time being just send a FamilyJob just like the
    # one that is self._job, but leave out the job.order, because that is
    # not interesting anymore.
    job = deepcopy(self._job)
    # In py 2.7 got an TypeError: field name must be a string
    # if using u'order', which is the default, we import unicode_literals
    # message.ClearField(b'order')
    job.ClearField('order')
    message = CompletedWorker()
    message.worker_name = 'fontbakery'
    message.completed_message.Pack(job)
    self._queue.end(message)
    return True # exception (if any) handled
