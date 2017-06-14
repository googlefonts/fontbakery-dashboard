FROM node:latest

RUN npm install -g bower requirejs browserify

ADD ./.bowerrc ./bower.json ./package.json /var/www-fontbakery/

RUN cd /var/www-fontbakery && npm install --unsafe-perm

# TODO: install with bower when:
# https://github.com/drudru/ansi_up/issues/39 is resolved
RUN mkdir -p /var/www-fontbakery/lib/static/js/bower_components/ansi_up/ \
    && curl -o /var/www-fontbakery/lib/static/js/bower_components/ansi_up/ansi_up.js \
               https://raw.githubusercontent.com/drudru/ansi_up/master/ansi_up.js

ADD . /var/www-fontbakery/

RUN cd /var/www-fontbakery;
