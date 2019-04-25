#!/usr/bin/env python
from __future__ import print_function, division, unicode_literals

import os

from .worker_base import WorkerError
from .diff_tools_shared import (
                                 DiffWorkerBase
                               , on_each_matching_font
                               )

from collections import namedtuple

from fontTools.ttLib import TTFont
import json

from diffbrowsers.diffbrowsers import DiffBrowsers
from diffbrowsers.browsers import test_browsers


#################
# START taken from gftools-qa
# https://github.com/googlefonts/gftools/blob/master/bin/gftools-qa.py
#################

@on_each_matching_font
def run_diffbrowsers(logger, font_before, font_after, out, auth, gfr_url):
    logger.debug('run_diffbrowsers with fonts before: %s after: %s'
                                              , font_before, font_after)
    browsers_to_test = test_browsers["vf_browsers"]
    diff_browsers = DiffBrowsers(
        auth=auth,
        gfr_instance_url=gfr_url,
        dst_dir=out,
        browsers=browsers_to_test,
        gfr_is_local=False)
    diff_browsers.new_session([font_before],
                              [font_after])
    diff_browsers.diff_view("waterfall")
    has_vfs = any([
        'fvar' in TTFont(font_before).keys(),
        'fvar' in TTFont(font_after).keys()
    ])
    info = os.path.join(out, "info.json")
    json.dump(diff_browsers.stats, open(info, "w"))
    if has_vfs:
        for i in range(15, 17):
            diff_browsers.diff_view("glyphs_all", pt=i)

#################
# /END taken from gftools-qa
#################

Setup = namedtuple('Setup', ['gfr_url', 'bstack_credentials'])

def getSetup():
  gfr_url = os.environ.get("GF_REGRESSIONS_URL", "http://35.188.158.120/")

  bstack_username = os.environ.get("BROWSERSTACK_USERNAME", None)
  bstack_access_key = os.environ.get("BROWSERSTACK_ACCESS_KEY", None)
  if bstack_username is None or bstack_access_key is None:
    raise WorkerError('Browserstack authentication '
                'information is missing, please set the '
                'BROWSERSTACK_USERNAME and BROWSERSTACK_ACCESS_KEY '
                'environment variables.')
  bstack_credentials = (bstack_username, bstack_access_key)

  return Setup(gfr_url, bstack_credentials)

# Running this rather really early than when the worker is initialized
# the first time. That way we get feedback when configuration is missing
# directly when the module is loaded. I.e. in this case directly on process
# start.
SETUP = getSetup();

class DiffbrowsersWorker(DiffWorkerBase):
  def __init__(self, logging, job, cache, persistence, queue, tmp_directory):
    self._workername = 'diffbrowsers'
    self._out_dir = os.path.join(self._tmp_directory, self._workername)
    os.mkdir(self._out_dir)
    super().__init__(logging, job, cache, persistence, queue, tmp_directory)

  def run(self):
    self._set_answer_timestamp('started')
    fonts = self._prepare(self._cache.get(self._job.cache_key).files)
    # all_fonts = reduce(lambda a,b: a+b, fonts.values(),[])
    all_files = [os.path.join(dp, f) for dp, dn, fn \
                          in os.walk(self._tmp_directory) for f in fn]
    self._log.debug('Files in Tempdir {}: {}'.format(
                                        self._tmp_directory, all_files))

    gfr_url = SETUP.gfr_url
    bstack_credentials = SETUP.bstack_credentials

    self._log.info('entering run_diffbrowsers …')
    # FIXME: should we collect stdout/stderr here???
    run_diffbrowsers(self._log, fonts['before'], fonts['after']
                            , self._out_dir, bstack_credentials, gfr_url)
    self._log.info('DONE! docid: %s', self._job.docid)
