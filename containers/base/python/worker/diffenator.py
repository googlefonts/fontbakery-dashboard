#!/usr/bin/env python
from __future__ import print_function, division, unicode_literals


import os
import pytz
from datetime import datetime
import traceback
from protocolbuffers.messages_pb2 import (
                                          CompletedWorker
                                        , FamilyJob
                                        , DiffenatorResult
                                        , DiffenatorWorkerResult
                                        , Files
                                        , File
                                        )
from google.protobuf.timestamp_pb2 import Timestamp
from fontTools.ttLib import TTFont
from diffenator.diff import DiffFonts
from diffenator.font import DFont

class DiffenatorWorkerError(Exception):
  pass


class DiffenatorPreparationError(DiffenatorWorkerError):
  pass

#################
# START taken from gftools-qa
# https://github.com/googlefonts/gftools/blob/master/bin/gftools-qa.py
#################
DIFFENATOR_THRESHOLDS = {
    "weak": dict(
        glyphs_thresh=0.02,
        marks_thresh=20,
        mkmks_thresh=20,
        kerns_thresh=30,
        render_diffs=True,
        ),
    "normal": dict(
        glyphs_thresh=0.01,
        marks_thresh=10,
        mkmks_thresh=10,
        kerns_thresh=15,
        render_diffs=True,
    ),
    "strict": dict(
        glyphs_thresh=0.00,
        marks_thresh=0,
        mkmks_thresh=0,
        kerns_thresh=1,
        render_diffs=True,
    )
}

def instances_in_font(ttfont):
    styles = []
    if 'fvar' in ttfont.keys():
        for instance in ttfont['fvar'].instances:
            nameid = instance.subfamilyNameID
            name = ttfont['name'].getName(nameid, 3, 1, 1033).toUnicode()
            name = name.replace(' ', '')
            styles.append(name)
    else:
        styles.append(os.path.basename(ttfont.reader.file.name).split('-')[1][:-4])
    return styles

def font_instances(ttfonts):
    styles = {}
    for ttfont in ttfonts:
        ttfont_styles = instances_in_font(ttfont)
        for style in ttfont_styles:
            styles[style] = ttfont.reader.file.name
    return styles

def on_each_matching_font(func):
    def func_wrapper(logger, fonts_before, fonts_after, out, *args, **kwargs):
        fonts_before_ttfonts = [TTFont(f) for f in fonts_before]
        fonts_after_ttfonts = [TTFont(f) for f in fonts_after]
        fonts_before_h = font_instances(fonts_before_ttfonts)
        fonts_after_h = font_instances(fonts_after_ttfonts)
        shared = set(fonts_before_h.keys()) & set(fonts_after_h.keys())
        if not shared:
            raise DiffenatorPreparationError(("Cannot find matching fonts. "
                             "Are font filenames the same?"))
        logger.debug('Found %s comparable font instances.',  len(shared))
        for font in shared:
            out_for_font = os.path.join(out, font)
            func(logger, fonts_before_h[font], fonts_after_h[font], out_for_font,
                 *args, **kwargs)
    return func_wrapper

@on_each_matching_font
def run_diffenator(logger, font_before, font_after, out, thresholds):
    logger.debug('run_diffenator with fonts before: %s after: %s'
                                              , font_before, font_after)

    logger.debug('create DFont("%s")', font_before)
    font_before = DFont(font_before)
    logger.debug('create DFont("%s")', font_after)
    font_after = DFont(font_after)


    logger.debug('variable font specifics')
    if font_after.is_variable and not font_before.is_variable:
        font_after.set_variations_from_static(font_before)

    elif not font_after.is_variable and font_before.is_variable:
        font_before.set_variations_from_static(font_after)

    elif font_after.is_variable and font_before.is_variable:
        # TODO get wdth and slnt axis vals
        variations = {"wght": font_before.ttfont["OS/2"].usWeightClass}
        font_after.set_variations(variations)
        font_before.set_variations(variations)

    logger.debug('create DiffFonts')
    diff = DiffFonts(font_before, font_after, settings=thresholds)
    logger.debug('diff.to_gifs')
    diff.to_gifs(dst=out)
    logger.debug('diff.to_txt')
    diff.to_txt(20, os.path.join(out, "report.txt"))
    logger.debug('diff.to_md')
    diff.to_md(20, os.path.join(out, "report.md"))
    logger.debug('diff.to_html')
    diff.to_html(20, os.path.join(out, "report.html"), image_dir=".")
#################
# /END taken from gftools-qa
#################

# Maybe as a first round, to see what we get:
# Save all to the tmp-dir, then put all to a files-messages and all of
# that to the persistence storage, making it downloadable as a zip!
# then we can inspect the results and figure how to use them …


# FIXME: I'm going to allow either 'before/' or 'after/' as prefixed here
# standing for 'before=old font' 'after=new font'
# and I kind of like the idea to have the preparation done in process manager
# because there seems to be some idiosyncrasies in how we call it and
# initWorkers could be really a simple implementation then, just forwarding
# the actual job and doing the adimin...
# If ever we need to share this, there can be refactoring be done.
def validate_filename(logs, seen, expected_prefixes, filename):
  # Basic input validation
  # Don't put any file into tmp containing a '/' or equal to '', '.' or '..'
  if not any(filename.startswith(prefix) for prefix in expected_prefixes):
    logs.append(('Skipping file name "{0}" must be in one of these '
                 'directories: {1}.').format(filename, ', '.join(expected_prefixes)))
    return False

  prefix, basename = filename.split('/', 1)

  if basename in {'', '.', '..'} or '/' in basename:
    raise DiffenatorPreparationError('Invalid filename: "{0}".'.format(filename))

  if filename in seen:
    logs.append('Skipping duplicate file name "{0}".'.format(filename))
    return False
  seen.add(filename)

  return True

class Diffenator(object):
  JobType=FamilyJob
  def __init__(self, logging, job, cache, persistence, queue, tmp_directory):
    self._log = logging
    self._job = job
    self._cache = cache
    self._persistence = persistence
    self._queue = queue
    self._tmp_directory = tmp_directory
    self._out_dir = os.path.join(self._tmp_directory, 'diffenator')
    os.mkdir(self._out_dir)
    self._answer = DiffenatorWorkerResult()
    self._answer.job_id = self._job.docid

  def _prepare(self, files):
    """
      Write files from the grpc.StorageServer to tmp_directory.

      Returns a list of log messages for each file in job.files, some may
      be skipped. This is to give the user direct feedback about the request
      made.

      Raises DiffenatorPreparationError if files appear to be invalid.
    """
    # `maxfiles` files should be small enough to not totally DOS us easily.
    # And big enough for all of our jobs, otherwise, change ;-)
    maxfiles = 60
    logs = self._answer.preparation_logs
    seen = set()

    target_dirs = ['before', 'after']
    expected_prefixes = tuple(map('{}/'.format, target_dirs))
    fontfiles = {prefix: [] for prefix in target_dirs}
    filecount = 0

    for target_dir in target_dirs:
      # this raises if targetDir already exists, but I strongly assert
      # that it doesn't at this point, the tmp_directory is expected to be
      # brand new.
      os.mkdir(os.path.join(self._tmp_directory, target_dir))

    for jobFile in files:
      filename = jobFile.name
      if not validate_filename(logs, seen, expected_prefixes, filename):
        continue

      path = os.path.join(self._tmp_directory, filename)
      with open(path, 'wb') as f:
        f.write(jobFile.data)

      logs.append('Added file "{}".'.format(filename))

      if path.lower().endswith('.ttf') or path.lower().endswith('.otf'):
        prefix, _ = filename.split('/', 1)
        fontfiles[prefix].append(path)
      filecount += 1

    if filecount > maxfiles:
      raise DiffenatorPreparationError('Found {} font files, but maximum '
                      'is limiting to {}.'.format(len(fontfiles), maxfiles))

    return fontfiles

  def _set_answer_timestamp(self, fieldname, dt=None):
    if dt is None:
      dt = datetime.now(pytz.utc);
    ts = Timestamp()
    ts.FromDatetime(datetime.now(pytz.utc))
    getattr(self._answer, fieldname).CopyFrom(ts)

  def run(self):
    self._set_answer_timestamp('started')
    fonts = self._prepare(self._cache.get(self._job.cache_key).files)
    # all_fonts = reduce(lambda a,b: a+b, fonts.values(),[])
    all_files = [os.path.join(dp, f) for dp, dn, fn \
                          in os.walk(self._tmp_directory) for f in fn]
    self._log.debug('Files in Tempdir {}: {}'.format(
                                        self._tmp_directory, all_files))

    self._log.info('entering run_diffenator …')
    # FIXME: should we collect stdout/stderr here???
    run_diffenator(self._log, fonts['before'], fonts['after'], self._out_dir, DIFFENATOR_THRESHOLDS['normal'])
    self._log.info('DONE! docid: %s', self._job.docid)

  def _make_result(self, result_dir_name):
    files = []
    result_path = os.path.join(self._out_dir, result_dir_name)
    for subdir, _, filenames in os.walk(result_path):
      for filename in filenames:
        file_msg = File()
        abs_path = os.path.join(subdir, filename)
        # CAUTION subdir shouldn't have a . or / at the beginning!
        relative_path = os.path.relpath(abs_path, start=result_path)
        file_msg.name = relative_path
        with open(abs_path, 'rb') as f:
          file_msg.data = f.read()
        files.append(file_msg)
    files_msg = Files()
    files_msg.files.extend(files)
    return files_msg

  def _make_results(self):
    result_dirs = next(os.walk(self._out_dir))[1]
    files_msgs = (self._make_result(result_name) for result_name in result_dirs)
    storage_keys = self._persistence.put(files_msgs)
    results = []
    for result_name, storage_key in zip(result_dirs, storage_keys):
      dr = DiffenatorResult()
      dr.name = result_name
      dr.storage_key.CopyFrom(storage_key)
      results.append(dr)
    self._answer.results.extend(results)

  def finalize(self, tb_str, *exc):
    if tb_str is not None:
      self._log.exception('FAIL Document closed exceptionally. docid: '
                      '%s exception: %s', self._job.docid, tb_str)
      self._answer.exception = tb_str

    # always
    self._set_answer_timestamp('finished')

    # try collecting the results (even if there was an exception, maybe
    # there's something

    try:
      self._make_results()
    except Exception as e:
      msg = 'Can\'t create (all) results:\n{}'.format(traceback.format_exc())
      if self._answer.exception:
        self._answer.exception += '\n\n AND ' + msg
      else:
        self._answer.exception = msg

    # In py 2.7 got an TypeError: field name must be a string
    # if using u'order', which is the default, we import unicode_literals
    # message.ClearField(b'order')
    message = CompletedWorker()
    message.worker_name = 'diffenator'
    message.completed_message.Pack(self._answer)
    self._queue.end(message)
    return True # exception (if any) handled

#$ python3 -c "from worker.diffenator import main;main()"

# debugrun.py:
# #!/usr/bin/env python
# import logging
# FORMAT = '%(asctime)s:%(name)s:%(levelname)s:%(message)s'
# logging.basicConfig(format=FORMAT)
# from worker.diffenator import main
# main()
#
def main():
  import logging
  FORMAT = '%(asctime)s:%(name)s:%(levelname)s:%(message)s'
  logging.basicConfig(format=FORMAT)
  logger = logging.getLogger('DIFFENATOR_WORKER')
  import importlib
  wl = importlib.import_module('worker-launcher')
  setLoglevel = wl.setLoglevel
  getSetup = wl.getSetup

  setup = getSetup()
  setLoglevel(logger, setup.log_level)
  # DEBUG is a lot of output!
  # setLoglevel(logging.getLogger('fontdiffenator'), 'INFO')
  setLoglevel(logging.getLogger('fontdiffenator'), setup.log_level)
  logger.info('loglevel: ' + setup.log_level)

  fonts = {'before': [], 'after': []}

  tmp = '/var/python/debug_vollkorn'
  out_dir = os.path.join(tmp, 'result')
  os.mkdir(out_dir)
  # just collect the fonts
  for sub in fonts.keys():
    dirname = os.path.join(tmp, sub)
    fonts[sub] = [os.path.join(dirname, filename)\
                              for filename in next(os.walk(dirname))[2]\
                                  if filename.endswith('.ttf')]

  logger.info('fonts before:\n%s', '\n'.join(fonts['before']))
  logger.info('fonts after:\n%s', '\n'.join(fonts['after']))

  run_diffenator(logger, fonts['before'], fonts['after'], out_dir, DIFFENATOR_THRESHOLDS['normal'])
