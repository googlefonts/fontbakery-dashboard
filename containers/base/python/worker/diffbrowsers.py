#!/usr/bin/env python
from __future__ import print_function, division, unicode_literals

import os

from .worker_base import WorkerError
from .diff_tools_shared import (
                                 DiffWorkerBase
                               , on_each_matching_or_new_font
                               )

from collections import namedtuple

from fontTools.ttLib import TTFont
import json

from diffbrowsers.diffbrowsers import DiffBrowsers
from diffbrowsers.browsers import test_browsers

from diffenator.font import DFont


def _repeated_mkdir(directory_path):
  try:
    os.mkdir(directory_path)
  except FileExistsError:
    pass

#################
# START taken from gftools-qa (and now modified!)
# https://github.com/googlefonts/gftools/blob/master/bin/gftools-qa.py
#################

def run_plot_glyphs(font_path, out):
    font_filename = os.path.basename(font_path)[:-4]
    dfont = DFont(font_path)
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

def run_browser_previews(font_path, out, auth, gfr_url):
    browsers_to_test = test_browsers["vf_browsers"]
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

def run_browser_diffs(font_before, font_after, out, auth, gfr_url):
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

@on_each_matching_or_new_font
def run_renderers(logger, font_before, font_after, out, auth, gfr_url):
    # CAUTION: font_before MAY be None if font_after is new and not an
    # update. Happens e.g. if a family is updated with new styles!
    if font_before is not None:
        # this is a "matching" font, an update (font_after) of an existing
        # font (font_before)
        logger.debug('run_browser_diffs with fonts before: %s after: %s'
                                                  , font_before, font_after)
        browser_diffs_out = os.path.join(out, "Browser_Diffs")
        _repeated_mkdir(out)
        _repeated_mkdir(browser_diffs_out)
        run_browser_diffs(font_before, font_after, browser_diffs_out, auth, gfr_url)

    else:
        # this is a new font, hence there's no font_before
        # but we can render previews for the font
        logger.debug('run_plot_glyphs with fonts: %s', font_after)
        plot_glyphs_out = os.path.join(out, "Plot_Glyphs")
        _repeated_mkdir(out)
        _repeated_mkdir(plot_glyphs_out)
        run_plot_glyphs(font_after, plot_glyphs_out)

        logger.debug('run_browser_previews with fonts: %s', font_after)
        browser_previews_out = os.path.join(out, "Browser_Previews")
        _repeated_mkdir(browser_previews_out)
        run_browser_previews(font_after, browser_previews_out, auth, gfr_url)

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
    super().__init__(logging, job, cache, persistence, queue, tmp_directory)

  def run(self):
    self._set_answer_timestamp('started')
    fonts = self._prepare(self._cache.get(self._job.cache_key).files, ['before', 'after'])
    # all_fonts = reduce(lambda a,b: a+b, fonts.values(),[])
    all_files = [os.path.join(dp, f) for dp, dn, fn \
                          in os.walk(self._tmp_directory) for f in fn]
    self._log.debug('Files in Tempdir {}: {}'.format(
                                        self._tmp_directory, all_files))

    gfr_url = SETUP.gfr_url
    bstack_credentials = SETUP.bstack_credentials

    self._log.info('entering run_renderers …')
    # FIXME: should we collect stdout/stderr here???
    run_renderers(self._log, fonts['before'], fonts['after']
                            , self._out_dir, bstack_credentials, gfr_url)
    self._log.info('DONE! docid: %s', self._job.docid)
