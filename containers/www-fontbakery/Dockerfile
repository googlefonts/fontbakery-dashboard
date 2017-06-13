FROM node:latest

RUN npm install -g bower requirejs browserify

ADD ./.bowerrc ./bower.json ./package.json /var/www-fontbakery/

RUN cd /var/www-fontbakery && npm install --unsafe-perm

ADD . /var/www-fontbakery/

RUN cd /var/www-fontbakery;
