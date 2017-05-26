FROM node:latest

RUN npm install -g bower

ADD . /var/www-fontbakery

RUN cd /var/www-fontbakery; npm install

RUN cd /var/www-fontbakery; bower install --allow-root
