# bionic == 18.04 LTS
FROM ubuntu:bionic

RUN touch /tmp/cache_spoof_1


# START TZCONFIG FIX suggested in:
# https://stackoverflow.com/a/47909037/1315369
# The tzdata package was expecting interaction to configure it

## for apt to be noninteractive
ENV DEBIAN_FRONTEND noninteractive
ENV DEBCONF_NONINTERACTIVE_SEEN true

## preesed tzdata, update package index, upgrade packages and install needed software
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
    && apt-get install -y curl mono-complete libicu-dev \
                          fontforge-nox python-fontforge git build-essential \
                          libssl-dev libffi-dev python-dev libxmlsec1-dev \
                          libxml2 libxml2-dev tzdata;

RUN curl -o /tmp/get-pip.py https://bootstrap.pypa.io/get-pip.py; python /tmp/get-pip.py;

run pip install --upgrade pip

# FIXME!
# Also, fontbakery should come with all requirements in it's setup.py
# how does fontTools or defcon handle this?
# ADD requirements.txt /
# RUN pip install --no-cache-dir -r requirements.txt

# FIXME: need all external dependencies
# ADD prebuilt/ot-sanitise /usr/local/bin/

# We don't want this to be fetched by every container run! (especially
# not in development) Though, now we have longer running containers
# it used to be a massive amount of single job containers before/
# FIXME: This is a hack, we need a proper way to do this
RUN curl -o tmp/fontbakery-microsoft-vendorlist.cache https://www.microsoft.com/typography/links/vendorlist.aspx

# This is taking forever to compile, so it slows down reiterations
# it's a dependency of fontbakery. Adding it early, so it is cached
# by the docker build
# This is bad: fontbakery requirements.txt needs a version and setup.py doesn't, we
# install from both ...
RUN pip install lxml==3.5.0


ADD requirements.txt /var/python/requirements.txt
RUN pip install -r /var/python/requirements.txt

RUN touch /tmp/cache_spoof_17

# FIXME: doesn't install all dependencies!
# RUN pip install git+https://github.com/graphicore/fontbakery@dashboard_related

# RUN git clone --depth 1 -b minor_fixes git://github.com/graphicore/fontbakery /var/fontbakery;\
RUN git clone --depth 1 -b master git://github.com/googlefonts/fontbakery /var/fontbakery;\
    pip install /var/fontbakery;pip install -r /var/fontbakery/requirements.txt;

RUN cp -r /var/fontbakery/prebuilt/ots-sanitize /bin/ots-sanitize; \
    echo "#! /bin/bash"  > /bin/ftxvalidator; \
    echo ">&2 echo 'ftxvalidator is not available!'; exit 1" >> /bin/ftxvalidator; \
    chmod +x /bin/ftxvalidator; \
    echo "#! /bin/bash"  > /bin/FontValidator.exe; \
    echo "mono /var/fontbakery/prebuilt/fval/FontValidator.exe \$@" >> /bin/FontValidator.exe; \
    chmod +x /bin/FontValidator.exe; \
    echo 'export LD_PRELOAD=/var/fontbakery/prebuilt/custom_freetype/lib/libfreetype.so' >> ~/.bashrc;

#RUN git clone --depth 1 -b master git://github.com/googlefonts/fontbakery /var/fontbakery;\
#    pip install /var/fontbakery;pip install -r /var/fontbakery/requirements.txt;



ADD . /var/python/
