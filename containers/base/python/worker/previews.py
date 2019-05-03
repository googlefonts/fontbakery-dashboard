#!/usr/bin/env python
from __future__ import print_function, division, unicode_literals

import os

from .worker_base import WorkerError
from .diff_tools_shared import (
                                 DiffWorkerBase
                               )

from collections import namedtuple

import json

from diffenator.font import DFont
from diffbrowsers.diffbrowsers import DiffBrowsers
from diffbrowsers.browsers import test_browsers


#################
# START taken from gftools-qa
# https://github.com/googlefonts/gftools/blob/master/bin/gftools-qa.py
#################

def run_plot_glyphs(fonts, out):
    for font in fonts:
        font_filename = os.path.basename(font)[:-4]
        dfont = DFont(font)
        if dfont.is_variable:
            for coords in dfont.instances_coordinates:
                dfont.set_variations(coords)
                img_out = os.path.join(out, "%s_%s.png" % (
                    font_filename, _instance_coords_to_filename(coords)
                    ))
                dfont.glyphs.to_png(img_out, limit=100000)
        else:
            img_out = os.path.join(out, font_filename + ".png")
            dfont.glyphs.to_png(dst=img_out)

def run_browser_previews(fonts, out, auth, gfr_url):
    browsers_to_test = test_browsers["vf_browsers"]
    for font_path in fonts:
        font_name = os.path.basename(font_path)[:-4]
        diff_browsers = DiffBrowsers(
                auth=auth,
                gfr_instance_url=gfr_url,
                dst_dir=os.path.join(out, font_name),
                browsers=browsers_to_test,
                gfr_is_local=False)
        diff_browsers.new_session([font_path], [font_path])
        diff_browsers.diff_view("waterfall")
        diff_browsers.diff_view("glyphs_all", pt=15)

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

class PreviewsWorker(DiffWorkerBase):
  def __init__(self, logging, job, cache, persistence, queue, tmp_directory):
    self._workername = 'previews'
    super().__init__(logging, job, cache, persistence, queue, tmp_directory)

  def run(self):
    self._set_answer_timestamp('started')
    fonts = self._prepare(self._cache.get(self._job.cache_key).files, ['files'])
    # all_fonts = reduce(lambda a,b: a+b, fonts.values(),[])
    all_files = [os.path.join(dp, f) for dp, dn, fn \
                          in os.walk(self._tmp_directory) for f in fn]
    self._log.debug('Files in Tempdir {}: {}'.format(
                                        self._tmp_directory, all_files))

    gfr_url = SETUP.gfr_url
    bstack_credentials = SETUP.bstack_credentials

    self._log.info('entering run_plot_glyphs …')
    glyphs_out_dir = os.path.join(self._out_dir, "Plot_Glyphs")
    os.mkdir(glyphs_out_dir)
    run_plot_glyphs(fonts['files'], glyphs_out_dir)

    self._log.info('entering run_browser_previews …')
    # FIXME: should we collect stdout/stderr here???
    browser_out_dir = os.path.join(self._out_dir, "Browser_Previews")
    os.mkdir(browser_out_dir)
    run_browser_previews(fonts['files'], browser_out_dir, bstack_credentials, gfr_url)
    self._log.info('DONE! docid: %s', self._job.docid)
