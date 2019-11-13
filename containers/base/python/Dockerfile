# disco == 19.04 LTS
FROM ubuntu:disco

RUN touch /tmp/cache_spoof_18


# START TZCONFIG FIX suggested in:
# https://stackoverflow.com/a/47909037/1315369
# The tzdata package was expecting interaction to configure it

## for apt to be noninteractive
ENV DEBIAN_FRONTEND noninteractive
ENV DEBCONF_NONINTERACTIVE_SEEN true

## preset tzdata, update package index, upgrade packages and install needed software
RUN echo "tzdata tzdata/Areas select Europe" > /tmp/preseed.txt; \
    echo "tzdata tzdata/Zones/Europe select Berlin" >> /tmp/preseed.txt; \
    debconf-set-selections /tmp/preseed.txt && \
    rm -f /etc/timezone && \
    rm -f /etc/localtime && \
    apt-get update && \
    apt-get install -y tzdata

## cleanup of files from setup
RUN rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*
# END TZCONFIG FIX

# universe in bionic has a Package: fontforge (1:20170731~dfsg-1)
# while the ppa currently has no newer version and no bionic version yet
# TODO: re-check and insrt the following line before the "&& apt-get update \" line
#     && add-apt-repository ppa:fontforge/fontforge \

RUN apt-get update && apt-get upgrade -y \
    && apt-get install -y software-properties-common \
    && apt-get update \
    && apt-get install -y curl libicu-dev \
                          fontforge-nox python-fontforge git build-essential \
                          libssl-dev libffi-dev python-dev libxmlsec1-dev \
                          libxml2 libxml2-dev tzdata  python3-minimal;

# diffenator dependencies, to install pycairo
RUN apt-get install -y python3-dev libcairo2 libcairo2-dev libharfbuzz-bin


# RUN curl -o /tmp/get-pip.py https://bootstrap.pypa.io/get-pip.py; python /tmp/get-pip.py;
RUN curl -o /tmp/get-pip.py https://bootstrap.pypa.io/get-pip.py; python3 /tmp/get-pip.py;

run pip3 install --upgrade pip

# FIXME!
# Also, fontbakery should come with all requirements in it's setup.py
# how does fontTools or defcon handle this?
# ADD requirements.txt /
# RUN pip3 install --no-cache-dir -r requirements.txt

# FIXME: need all external dependencies
# ADD prebuilt/ot-sanitise /usr/local/bin/

# This is taking forever to compile, so it slows down reiterations
# it's a dependency of fontbakery. Adding it early, so it is cached
# by the docker build
# This is bad: fontbakery requirements.txt needs a version and setup.py doesn't, we
# install from both ...
RUN pip3 install lxml; # ==3.5.0

ADD requirements.txt /var/python/requirements.txt
RUN pip3 install -r /var/python/requirements.txt

RUN touch /tmp/cache_spoof_20

# FIXME: doesn't install all dependencies!
# RUN pip3 install git+https://github.com/graphicore/fontbakery@dashboard_related

#RUN git clone --depth 1 -b p3_fixes git://github.com/graphicore/fontbakery /var/fontbakery;\
#RUN git clone --depth 1 -b master git://github.com/googlefonts/fontbakery /var/fontbakery;\
#    pip3 install /var/fontbakery;

# FIXME: probably all `pip3 install dependencies should be in requirements.txt
RUN pip3 install fontbakery;

# tools used for live debugging and profiling
# RUN pip3 install memory-profiler
# RUN apt-get install -y vim tmux htop
# RUN touch /tmp/cache_spoof_16
# RUN pip3 install remote-pdb
# RUN git clone --depth 1 -b fb_dashboard_bughunt_issue100_OOM https://github.com/graphicore/fontdiffenator.git /var/fontdiffenator;\
#     pip3 install -e /var/fontdiffenator;
RUN pip3 install fontdiffenator;

RUN pip3 install gfdiffbrowsers

RUN touch /tmp/cache_spoof_2

# in update_protobufs.sh the command `python -m grpc_tools.protoc`
# doesn't create python 3 ready relative imports
# see: https://github.com/protocolbuffers/protobuf/issues/1491
# setting PYTHONPATH ths way helps.
ENV PYTHONPATH="/var/python/protocolbuffers/:${PYTHONPATH}"

# Solves isses raising errors like:
#     UnicodeEncodeError: 'ascii' codec can't encode characters in position 0-8: ordinal not in range(128)
# See e.g.: https://github.com/docker-library/python/issues/13
# also an option: ENV PYTHONIOENCODING=UTF-8
ENV LANG C.UTF-8


ADD . /var/python/
