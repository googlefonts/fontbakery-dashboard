FROM node:13.13.0-buster


RUN touch /tmp/cache_spoof_16

RUN apt-get update && apt-get upgrade -y \
    && apt-get install -y software-properties-common

# mentioned in https://github.com/nodegit/nodegit
RUN apt-get update \
    && apt-get install -y libssl-dev libpcre2-posix0 libkrb5-3 \
    libk5crypto3 libcomerr2 libpcre2-dev libkrb5-dev


RUN npm install -g bower browserify requirejs;

ADD ./.bowerrc ./bower.json ./package.json /var/javascript/

RUN touch /tmp/cache_spoof_2
ADD ./generated_modules /var/javascript/generated_modules

RUN touch /tmp/cache_spoof_2

# will also invoke bower install etc.
# --production: don't install dev-dependencies
RUN cd /var/javascript && npm install --unsafe-perm --production


# It seems to be most robust to read our METADATA.pb files using python
# that's the only reason for this dependency, used in manifestSources
# via the module /node/util/getMetadataPb
RUN apt-get update \
    && apt-get install -y build-essential cmake python3-dev git;
RUN curl -o /tmp/get-pip.py https://bootstrap.pypa.io/get-pip.py; python3 /tmp/get-pip.py;
RUN pip install --upgrade pip

# opentype-sanitizer needs ninja which did not build without these:
# related: https://github.com/scikit-build/ninja-python-distributions/issues/22
RUN pip install scikit-build
# help ninja build itself
ENV CXXFLAGS="-D_BSD_SOURCE"
# build ninja
RUN pip install ninja


RUN git clone --depth 1 -b main https://github.com/googlefonts/gftools.git /var/gftools;\
    pip install /var/gftools;

RUN cd /var/javascript \
     && bower install --allow-root \
     && browserify ./browser/js/bower_components/jiff/jiff.js -s jiff \
                         -o ./browser/js/bower_components/jiff/jiff.umd.js && browserify \
                   ./browser/js/bower_components/jiff/lib/jsonPointer -s jsonPointer \
                         -o ./browser/js/bower_components/jiff/jsonPointer.umd.js \
     && cp -r ./generated_modules/protocolbuffers ./node_modules/protocolbuffers \
     && mkdir -p ./browser/js/bower_components/protocolbuffers \
     && browserify ./node_modules/protocolbuffers/shared_pb.js -s  protocolbuffers/shared_pb \
                         -o ./browser/js/bower_components/protocolbuffers/shared_pb.js;

# TODO: install with bower when:
# https://github.com/drudru/ansi_up/issues/39 is resolved
RUN mkdir -p /var/javascript/browser/js/bower_components/ansi_up/ \
    && curl -o /var/javascript/browser/js/bower_components/ansi_up/ansi_up.js \
               https://raw.githubusercontent.com/drudru/ansi_up/master/ansi_up.js

# In the minikube development version it can be interesting to preload
# the image with a current version of the github google/fonts repository.
# If so in this directory (containers/base/javascript) do:
# $ git clone --bare https://github.com/google/fonts.git fontsgit
# Otherwise, if image file size is an issue:
# $ mkdir fontsgit
# Would be nice to have the ADD optional ...
# ADD ./fontsgit /var/git-repositories/github.com_google_fonts.git

# ADD ./fontsgit /var/fontsgit
# RUN ln -s /var/fontsgit /var/git-repositories

# This way we only need to rebuild the last intermediate container when
# code changed, especially the npm install can be skipped!
ADD ./browser /var/javascript/browser
ADD ./node /var/javascript/node
