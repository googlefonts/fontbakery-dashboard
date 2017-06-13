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


# FIXME: should be git+https://github.com/googlefonts/fontbakery
RUN pip install git+https://github.com/graphicore/fontbakery@hotfix-dependencies
RUN pip install --upgrade git+https://github.com/davelab6/pyfontaine.git;

ADD requirements.txt /var/worker-fontbakery/requirements.txt
RUN pip install -r /var/worker-fontbakery/requirements.txt

ADD fontbakery-dragandrop-worker.py /var/worker-fontbakery/fontbakery-dragandrop-worker.py
