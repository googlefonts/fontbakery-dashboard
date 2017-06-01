FROM python:2.7

RUN apt-get update
RUN apt-get install -y mono-complete libicu-dev


# FIXME!
# Also, fontbakery should come with all requirements in it's setup.py
# how does fontTools or defcon handle this?
# ADD requirements.txt /
# RUN pip install --no-cache-dir -r requirements.txt

# FIXME: need all external dependencies
# ADD prebuilt/ot-sanitise /usr/local/bin/

# We don't want this to be fetched by every container run!
# FIXME: This is a hack, we need a proper way to do this
RUN curl -o /tmp/fontbakery-microsoft-vendorlist.cache https://www.microsoft.com/typography/links/vendorlist.aspx

## Install fontforge.
# RUN apt-get install -y software-properties-common
# RUN add-apt-repository ppa:fontforge/fontforge
# RUN apt-get update
# RUN apt-get install -y fontforge-nox python-fontforge

# FIXME: should be git+https://github.com/googlefonts/fontbakery
RUN pip install git+https://github.com/graphicore/fontbakery@hotfix-dependencies

RUN pip install --upgrade git+https://github.com/davelab6/pyfontaine.git;

ADD requirements.txt /
RUN pip install -r requirements.txt

ADD fontbakery-dragandrop-worker.py /

CMD ["python2",  "-u", "fontbakery-dragandrop-worker.py"]
