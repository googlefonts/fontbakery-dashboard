FROM ubuntu:trusty

RUN apt-get update && apt-get upgrade -y \
    && apt-get install -y software-properties-common \
    && add-apt-repository ppa:fontforge/fontforge \
    && apt-get update \
    && apt-get install -y python-pip curl mono-complete libicu-dev \
                          fontforge-nox python-fontforge git build-essential \
                          libssl-dev libffi-dev python-dev libxmlsec1-dev \
                          libxml2 libxml2-dev;

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
RUN curl -o /tmp/fontbakery-microsoft-vendorlist.cache https://www.microsoft.com/typography/links/vendorlist.aspx


# This is taking forever to compile, so it slows down reiterations
# it's a dependency of fontbakery. Adding it early, so it is cached
# by the docker build
# This is bad: fontbakery requirements.txt needs a version and setup.py doesn't, we
# install from both ...
RUN pip install lxml==3.5.0


ADD requirements.txt /var/worker-fontbakery/requirements.txt
RUN pip install -r /var/worker-fontbakery/requirements.txt

RUN touch /tmp/cache_spoof_9

# FIXME: doesn't install all dependencies!
# RUN pip install git+https://github.com/graphicore/fontbakery@dashboard_related

RUN git clone --depth 1 -b master git://github.com/googlefonts/fontbakery /tmp/fontbakery;\
    pip install /tmp/fontbakery;pip install -r /tmp/fontbakery/requirements.txt;

ADD . /var/worker-fontbakery/
