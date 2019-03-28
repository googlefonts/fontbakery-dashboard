#!/usr/bin/env python3

import logging
FORMAT = '%(asctime)s:%(name)s:%(levelname)s:%(message)s'
logging.basicConfig(format=FORMAT)

import sys
print('python version:', sys.version)

from worker.diffenator import main
main()
