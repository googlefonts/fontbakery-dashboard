FROM node:latest

RUN npm install -g bower browserify requirejs;


ADD ./.bowerrc ./bower.json ./package.json /var/javascript/
ADD ./generated_modules/protocolbuffers /var/javascript/node_modules/protocolbuffers

# will also invoke bower install etc.
# --production: don't install dev-dependencies
RUN cd /var/javascript && npm install --unsafe-perm  --production

# TODO: install with bower when:
# https://github.com/drudru/ansi_up/issues/39 is resolved
RUN mkdir -p /var/javascript/browser/js/bower_components/ansi_up/ \
    && curl -o /var/javascript/browser/js/bower_components/ansi_up/ansi_up.js \
               https://raw.githubusercontent.com/drudru/ansi_up/master/ansi_up.js

# This way we only need to rebuild the last intermediate container when
# code changed, especially the npm install can be skipped!
ADD . /var/javascript
