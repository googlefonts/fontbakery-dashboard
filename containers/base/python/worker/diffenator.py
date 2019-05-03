#!/usr/bin/env python
from __future__ import print_function, division, unicode_literals

import os

from .diff_tools_shared import (
                                 DiffWorkerBase
                               , on_each_matching_font
                               )

from diffenator.diff import DiffFonts
from diffenator.font import DFont


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

@on_each_matching_font
def run_diffenator(logger, font_before, font_after, out, thresholds=DIFFENATOR_THRESHOLDS['normal']):
    logger.debug('run_diffenator with fonts before: %s after: %s'
                                              , font_before, font_after)

    font_before = DFont(font_before)
    font_after = DFont(font_after)


    if font_after.is_variable and not font_before.is_variable:
        font_after.set_variations_from_static(font_before)

    elif not font_after.is_variable and font_before.is_variable:
        font_before.set_variations_from_static(font_after)

    elif font_after.is_variable and font_before.is_variable:
        # TODO get wdth and slnt axis vals
        variations = {"wght": font_before.ttfont["OS/2"].usWeightClass}
        font_after.set_variations(variations)
        font_before.set_variations(variations)

    diff = DiffFonts(font_before, font_after, settings=thresholds)
    diff.to_gifs(dst=out)
    diff.to_txt(20, os.path.join(out, "report.txt"))
    diff.to_md(20, os.path.join(out, "report.md"))
    diff.to_html(20, os.path.join(out, "report.html"), image_dir=".")

#################
# /END taken from gftools-qa
#################

class DiffenatorWorker(DiffWorkerBase):
  def __init__(self, logging, job, cache, persistence, queue, tmp_directory):
    self._workername = 'diffenator'
    super().__init__(logging, job, cache, persistence, queue, tmp_directory)

  def run(self):
    self._set_answer_timestamp('started')
    fonts = self._prepare(self._cache.get(self._job.cache_key).files, ['before', 'after'])
    # all_fonts = reduce(lambda a,b: a+b, fonts.values(),[])
    all_files = [os.path.join(dp, f) for dp, dn, fn \
                          in os.walk(self._tmp_directory) for f in fn]
    self._log.debug('Files in Tempdir {}: {}'.format(
                                        self._tmp_directory, all_files))

    self._log.info('entering run_diffenator …')
    # FIXME: should we collect stdout/stderr here???
    run_diffenator(self._log, fonts['before'], fonts['after'], self._out_dir, DIFFENATOR_THRESHOLDS['normal'])
    self._log.info('DONE! docid: %s', self._job.docid)


# The intention for main was ever only for debugging/profiling.
# debug_run.py:
#     #!/usr/bin/env python3
#
#     import logging
#     FORMAT = '%(asctime)s:%(name)s:%(levelname)s:%(message)s'
#     logging.basicConfig(format=FORMAT)
#
#     import sys
#     print('python version:', sys.version)
#
#     from worker.diffenator import main
#     main()
# with memory profiling:
# base/python$ mprof run debug_python.py
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
