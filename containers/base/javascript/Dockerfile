# :latest as pointing to: 10.4.0-jessie, 10.4-jessie, 10-jessie, jessie, 10.4.0, 10.4, 10, latest
# https://github.com/nodejs/docker-node/blob/8efaa064853a2f866481f162eb4e424c5ee8ac9e/10/jessie/Dockerfile
# does currently not build node-git: https://github.com/nodegit/nodegit/issues/1490
# FROM node:latest
# FIXME: use :latest when it builds again
FROM node:9

RUN touch /tmp/cache_spoof_1

RUN npm install -g bower browserify requirejs;


ADD ./.bowerrc ./bower.json ./package.json /var/javascript/

RUN touch /tmp/cache_spoof_1
ADD ./generated_modules /var/javascript/generated_modules


# will also invoke bower install etc.
# --production: don't install dev-dependencies
RUN cd /var/javascript && npm install --unsafe-perm  --production


# It seems to be moost roust to read our METADATA.pb files using python
# that's the only reason for this dependency, used in manifestSources
# via the module /node/util/getMetadataPb
RUN apt-get update && apt-get upgrade -y \
    && apt-get install -y software-properties-common \
    && apt-get update \
    && apt-get install -y python-dev git;
RUN curl -o /tmp/get-pip.py https://bootstrap.pypa.io/get-pip.py; python /tmp/get-pip.py;
RUN pip install --upgrade pip

RUN git clone --depth 1 -b master https://github.com/googlefonts/gftools.git /var/gftools;\
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

ADD ./fontsgit /var/fontsgit
# This way we only need to rebuild the last intermediate container when
# code changed, especially the npm install can be skipped!
ADD ./browser /var/javascript/browser
ADD ./node /var/javascript/node
