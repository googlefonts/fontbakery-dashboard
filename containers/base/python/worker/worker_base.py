#!/usr/bin/env python
from __future__ import print_function, division, unicode_literals



class WorkerError(Exception):
  pass

class PreparationError(WorkerError):
  pass

class WorkerBase:
  """In a sub-class define `__init__`, it's properties names are used
  for dependency injection. Have a look into worker-launcher to see how
  this is done.
  """

  def JobType():
    """JobType is expected to be a protocol buffers message constructor"""
    raise NotImplementedError('`JobType` method must be set as class '
                              'property by sub-class.');

  def run(self):
    """Run the job, exceptions will be caught and passed to`finalize`."""
    raise NotImplementedError('`run` method must be implemented by sub-class.');



  def finalize(self, tb_str, *exc):
    """If `run` failed and raised `tb_str` is a string of the traceback.
    If run finished regularly `tb_str` is None and there was no exception.

    return: If there was no exception, this is irrelevant.

    return: If there was an exception, return `Frue` if it has been dealt
    with in this method, otherwise return `False` to escalate the exception
    to the next level.
    """

    raise NotImplementedError('`finalize` method must be implemented by sub-class.');
