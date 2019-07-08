# This basically creates a hub.docker.com rethinkdb:2.3.6 but that one
# is based on Debian 8 Jessie, while Debian 9 Stretch is current.
# And the project doesn't support a stretch deb image :-/
# Then it mixes in a simplified yet inspired approach of rosskukulinski/rethinkdb-kubernetes
FROM debian:stretch

RUN apt-get update && apt-get upgrade -y \
    && apt-get install  -y procps sudo mg git \
    build-essential protobuf-compiler python \
    libprotobuf-dev libcurl4-openssl-dev libboost-all-dev \
    libncurses5-dev libjemalloc-dev wget m4 clang libssl1.0-dev \
    && rm -rf /var/lib/apt/lists/*;


RUN mkdir -p /tmp/build \
    && cd /tmp/build \
    && wget https://download.rethinkdb.com/dist/rethinkdb-2.3.6.tgz \
    && tar xf rethinkdb-2.3.6.tgz \
    && cd rethinkdb-2.3.6 \
    && ./configure --allow-fetch CXX=clang++ \
    && make -j8 \
    && make install \
    && cd / \
    && rm -rf /tmp/build;

ENV TINI_VERSION v0.18.0
ADD https://github.com/krallin/tini/releases/download/${TINI_VERSION}/tini /tini
RUN chmod +x /tini
ENTRYPOINT ["/tini", "--"]
# Now use "args" instead of "command" in the yaml file pod specs!!!
# because "command" in the yaml replaces the ENTRYPOINT in the container
# and we want the PID 1 to be tini

# some copy pasta
# from https://github.com/rethinkdb/rethinkdb-dockerfiles/blob/master/jessie/2.3.6/Dockerfile
VOLUME ["/data"]

WORKDIR /data

# process cluster webui
EXPOSE 28015 29015 8080

# now we can just do e.g.:
# CMD ["rethinkdb", "--bind", "all"]
# or in the pod spec:
# args: ["rethinkdb", "--bind", "all"]
# or actually in this case:
# args: ["run.sh", "--bind", "all"]


# stuff from https://github.com/helm/charts/blob/master/stable/rethinkdb/init/Dockerfile
# at Latest commit 465c9fb on Jun 13, 2017 "rethinkdb: Initial Commit (#1018)"

RUN apt-get update && \
    apt-get install -yq curl && \
    rm -rf /var/cache/apt/* && rm -rf /var/lib/apt/lists/*

ADD http://stedolan.github.io/jq/download/linux64/jq /usr/bin/jq
RUN chmod +x /usr/bin/jq

COPY ./files/run.sh ./rethinkdb-probe/rethinkdb-probe /
RUN chmod u+x /run.sh /rethinkdb-probe
