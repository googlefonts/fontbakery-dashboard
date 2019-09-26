
# 1.

Via https://console.cloud.google.com create a 3 Nodes cluster, nothing fancy so added

# 2. Connect to the cluster

From (https://console.cloud.google.com/kubernetes/list?project=fontbakery-168509) there's a "connect" button with the following information:

Configure kubectl command line access by running the following command:

```
$ gcloud container clusters get-credentials fontbakery-dashboard-1 \
    --zone us-central1-a --project fontbakery-168509
```

Then start a proxy to connect to the Kubernetes control plane:
```
$ kubectl proxy
```

Then open the Dashboard interface by navigating to the following location in your browser:

http://localhost:8001/ui


## set the right default project for `gcloud` selecting project "fontbakery-168509" in my case:

```
$  gcloud init
```


# 3. create a persitent disk for rethink-DB

```
$ gcloud compute disks create --size 200GB rethinkdb-disk
```

Asks to choose a zone: took `us-central1-a` as all of the cluster is there.


> New disks are unformatted. You must format and mount a disk before it
can be used. You can find instructions on how to do this at:
>
> https://cloud.google.com/compute/docs/disks/add-persistent-disk#formatting

Oh My!


For that I need to:

[attach it to any running or stopped instance](https://cloud.google.com/compute/docs/disks/add-persistent-disk)


using `gcloud compute instances attach-disk [INSTANCE_NAME] --disk [DISK_NAME]`:


```
$ gcloud compute instances attach-disk gke-fontbakery-cluster-1-default-pool-f369b09d-09ql --disk rethinkdb-disk
```

I formatted the disk in the node instances via the web interface ssh:

(Used `$ lsbk` to figure out that dev/sdb is my target disk.)

```
$ sudo mkfs.ext4 -m 0 -F -E lazy_itable_init=0,lazy_journal_init=0,discard /dev/sdb
```


Skipping mounting the disk now. I hobe the kubernetes yaml will be sufficient for this.


I even revert the attachment of the disk to a node, but I doubt that is a good idea. Much rather, the documentation is insufficient.

```
$ gcloud compute instances detach-disk gke-fontbakery-cluster-1-default-pool-f369b09d-09ql --disk rethinkdb-disk
```

*This guy* https://github.com/rosskukulinski/kubernetes-rethinkdb-cluster figured out how to do a proper cluster with gcloud.

We'll need ONE PERSISTANT DISK per replication!

> Due to the way persistent volumes are handled in Kubernetes, we have to have one RC per replica, each with its own persistent volume.


## U-turn

Because this is all very cumbersome, I revert to reuse stuff by: https://github.com/rosskukulinski/kubernetes-rethinkdb-cluster


for the first replica we need a disk called `rethinkdb-storage-1`

I deleted the pprior disk, then:



```
$ gcloud compute disks create --size 200GB rethinkdb-storage-1
Created [https://www.googleapis.com/compute/v1/projects/fontbakery-168509/zones/us-central1-a/disks/rethinkdb-storage-1].
NAME                 ZONE           SIZE_GB  TYPE         STATUS
rethinkdb-storage-1  us-central1-a  200      pd-standard  READY
```

Also do this, we'll use it later:

```
$ gcloud compute disks create --size 200GB rethinkdb-storage-2
NAME                 ZONE           SIZE_GB  TYPE         STATUS
rethinkdb-storage-2  us-central1-a  200      pd-standard  READY

```

It says new disks are unformatted and that I must format it. But I want to see it fail, because nobody
documented this well. Also, why is there a `fsType: ext4` in the volume setup (kubernetes yaml file
, probably that we mount it correctly...)


OK, no disk formatting, crash and burn:

```
$ kubectl apply -f kubernetes/gcloud-rethinkdb.yaml

```

Did some SSH testing, seems like the disk is working as ext4 without explicitly formating it.


After:

```
$ kubectl apply -f kubernetes/gcloud-rethinkdb-stage-2.yaml
```

and

```
$ kubectl proxy
Starting to serve on 127.0.0.1:8001
```

The admin interface can be accessed at:

http://localhost:8001/api/v1/namespaces/default/services/rethinkdb-admin:8080/proxy/

**WIN! this is not available form external IPs**



# rabbitmq:
```
$ kubectl apply -f kubernetes/gcloud-rabbitmq.yaml
```

http://localhost:8001/api/v1/namespaces/default/services/rabbitmq-management:8888/proxy/

**WIN! this is not available form external IPs**

user:pwd == guest:guest

**FAIL: Login fails!**

Apparently, "guest" can only connect via localhost


SSH into the rabbitmq pod:

```
$ kubectl get pods
NAME                                  READY     STATUS    RESTARTS   AGE
rabbitmq-560944786-j3d19              1/1       Running   0          24m
rethinkdb-admin-3880935612-xhkc9      1/1       Running   0          47m
rethinkdb-proxy-3423953141-xntbn      1/1       Running   0          49m
rethinkdb-replica-1-138896046-wkxqk   1/1       Running   0          2h
rethinkdb-replica-2-748053191-v2wzk   1/1       Running   0          49m

$ kubectl exec -it rabbitmq-560944786-j3d19 -- /bin/bash
```

Add user `admin` with the password `admin` (NOTE: we rely here on kubectl
proxy to access the admin interface, it **must not** be accessible from the outside)

```
root@rabbitmq-560944786-j3d19:/# rabbitmqctl add_user admin admin
# just "administrator" should suffice
root@rabbitmq-560944786-j3d19:/# rabbitmqctl set_user_tags admin administrator management
# did this, don't know if needed
root@rabbitmq-560944786-j3d19:/# rabbitmqctl set_permissions -p / admin ".*" ".*" ".*"
```

Still can't connect to the management interface


OK, after 3 hours trying I give up for now and proceed with something else.

It seems like I can't even authorize because a XHR HTTP GET to:
http://localhost:8001/api/v1/namespaces/default/services/rabbitmq-management:8888/proxy/api/whoami
returns no result and breaks the client because of unparseable json (empty data)

The static http server of that url works though.

going to: http://localhost:8001/api/v1/namespaces/default/services/rabbitmq-management:8888/proxy/api

even gives me a nice page documenting **RabbitMQ Management HTTP API**

going directly to:
http://localhost:8001/api/v1/namespaces/default/services/rabbitmq-management:8888/proxy/api/whoami
tries a basic authentciation, but it doesn't accept my credentials (neither guest nor admin).

NOTE: https://hub.docker.com/_/rabbitmq/

> If you wish to change the default username and password of guest / guest, you can do so with the RABBITMQ_DEFAULT_USER and RABBITMQ_DEFAULT_PASS environmental variables:

May be a good idea, also keep it a bit secret if feasible.

Did so for admin:admin didn't resolve the problem though :-(. Revisiting another time...

# Deploy worker-fontbakery (!now fontbakery-worker-checker)

```
$ docker build -t worker-fontbakery:1 containers/worker-fontbakery/
```

Having some problems here with Jessie Jessie dependencies :-/

Changed image from "python:2.7" to "ubuntu:trusty" ppa:fontforge/fontforge
does not support Debian Jessie, which is the base of "python:2.7", also
the package libicu-dev failed.

Turns out building `pyfontaine` with this: `RUN pip install --upgrade git+https://github.com/davelab6/pyfontaine.git;` is a pita.

```
$ docker tag worker-fontbakery:1 gcr.io/fontbakery-168509/worker-fontbakery:1
$ docker push gcr.io/fontbakery-168509/worker-fontbakery:1
$ kubectl apply -f kubernetes/gcloud-worker-fontbakery.yaml
```

Failing:

```
 2017-06-13T14:13:54.516792771Z INFO:pika.adapters.base_connection:Connecting to 10.43.254.133:5672
2017-06-13T14:13:57.533799882Z ERROR:pika.adapters.base_connection:Socket Error: 104
2017-06-13T14:13:57.533851093Z ERROR:pika.adapters.base_connection:Socket closed while authenticating indicating a probable authentication error
2017-06-13T14:13:57.533855882Z Traceback (most recent call last):
2017-06-13T14:13:57.533859412Z   File "fontbakery-dragandrop-worker.py", line 284, in <module>
2017-06-13T14:13:57.533864255Z     main()
2017-06-13T14:13:57.533867835Z   File "fontbakery-dragandrop-worker.py", line 267, in main
2017-06-13T14:13:57.533871155Z     connection = pika.BlockingConnection(pika.ConnectionParameters(host=msgqueue_host))
2017-06-13T14:13:57.533874835Z   File "/usr/local/lib/python2.7/dist-packages/pika/adapters/blocking_connection.py", line 339, in __init__
2017-06-13T14:13:57.533878123Z     self._process_io_for_connection_setup()
2017-06-13T14:13:57.533882101Z   File "/usr/local/lib/python2.7/dist-packages/pika/adapters/blocking_connection.py", line 374, in _process_io_for_connection_setup
2017-06-13T14:13:57.533887216Z     self._open_error_result.is_ready)
2017-06-13T14:13:57.533890261Z   File "/usr/local/lib/python2.7/dist-packages/pika/adapters/blocking_connection.py", line 410, in _flush_output
2017-06-13T14:13:57.533893746Z     self._impl.ioloop.poll()
2017-06-13T14:13:57.533897113Z   File "/usr/local/lib/python2.7/dist-packages/pika/adapters/select_connection.py", line 602, in poll
2017-06-13T14:13:57.533900491Z     self._process_fd_events(fd_event_map, write_only)
2017-06-13T14:13:57.533903708Z   File "/usr/local/lib/python2.7/dist-packages/pika/adapters/select_connection.py", line 443, in _process_fd_events
2017-06-13T14:13:57.533907191Z     handler(fileno, events, write_only=write_only)
2017-06-13T14:13:57.533910433Z   File "/usr/local/lib/python2.7/dist-packages/pika/adapters/base_connection.py", line 364, in _handle_events
2017-06-13T14:13:57.533916131Z     self._handle_read()
2017-06-13T14:13:57.533919255Z   File "/usr/local/lib/python2.7/dist-packages/pika/adapters/base_connection.py", line 407, in _handle_read
2017-06-13T14:13:57.533922598Z     return self._handle_error(error)
2017-06-13T14:13:57.533925716Z   File "/usr/local/lib/python2.7/dist-packages/pika/adapters/base_connection.py", line 338, in _handle_error
2017-06-13T14:13:57.533928891Z     self._handle_disconnect()
2017-06-13T14:13:57.533931949Z   File "/usr/local/lib/python2.7/dist-packages/pika/adapters/base_connection.py", line 288, in _handle_disconnect
2017-06-13T14:13:57.533935269Z     self._adapter_disconnect()
2017-06-13T14:13:57.533939165Z   File "/usr/local/lib/python2.7/dist-packages/pika/adapters/select_connection.py", line 95, in _adapter_disconnect
2017-06-13T14:13:57.533942528Z     super(SelectConnection, self)._adapter_disconnect()
2017-06-13T14:13:57.533947645Z   File "/usr/local/lib/python2.7/dist-packages/pika/adapters/base_connection.py", line 154, in _adapter_disconnect
2017-06-13T14:13:57.533969478Z     self._check_state_on_disconnect()
2017-06-13T14:13:57.533973691Z   File "/usr/local/lib/python2.7/dist-packages/pika/adapters/base_connection.py", line 173, in _check_state_on_disconnect
2017-06-13T14:13:57.533977015Z     raise exceptions.ProbableAuthenticationError
2017-06-13T14:13:57.533980139Z pika.exceptions.ProbableAuthenticationError
```


Debugging ...

having the start command n the yaml file set to:

```
command: ["python", "-u", "-c", "while True: import time;print 'hi';time.sleep(2);"]
```

So the pods keep on running and I can ssh into them.

```
$ kubectl exec -it worker-fontbakery-1263476394-6klw4 -- /bin/bash
```

Turns out it was the environment variables in the rabbitmq yaml I set yesterday:

```
        env:
        - name: RABBITMQ_DEFAULT_USER
          value: "admin"
        - name: RABBITMQ_DEFAULT_PASS
          value: "admin"
```
This must be reflected in the clients, otherwise they use guest:guest by default.
Commented these settings.


**WIN** `> 2017-06-13T15:24:42.365764894Z INFO:root:Waiting for messages... `


# Deploy www-fontbakery


```
$ docker build -t www-fontbakery:1.01 containers/www-fontbakery/;
$ docker tag www-fontbakery:1.01 gcr.io/fontbakery-168509/www-fontbakery:1.01
$ docker push gcr.io/fontbakery-168509/www-fontbakery:1.01
$ kubectl apply -f kubernetes/gcloud-www-fontbakery.yaml
```


In the meantime the worker-fontbakery image is at `gcr.io/fontbakery-168509/worker-fontbakery:1.03`

It's working now.


To debug the message queue, the service `rabbitmq-management` can be changed to `type: LoadBalancer` from the kubernetes management interface (edit the YAML).
Changing it back requires to delete `clientIP`, but the interface will complain about that, so it's easy to remember.


### upate


Just did the following to to access rabbitmq-management directly without service:

```
$ kubectl get pods
# > ...
# > rabbitmq-54365647-gvsgs                            1/1       Running   0          53d
# > ...
$ kubectl port-forward rabbitmq-54365647-gvsgs 8888:15672
```

user:passwd = guest:guest




# Latest deployment (end of 2018)

## Access the rethinkdb admin interface

```
$ kubectl get pods
$ kubectl port-forward rethinkdb-admin-3880935612-p0kvj 8080:8080
```

I accessed this and deleted the 'draganddrop' database, which is no longer needed.

## Secrets

```bash
# we have some server side secrets for session cookies or similar
# this is how they can be created:

# using 33 bytes, we could use 32 bytes (which amounts to 256 bits, as much
# as is used for a sha256 hash, however, with 32 bytes base64 puts out
# a padding character (=) in the end and with 33 the padding is gone, the
# encoded result is as long and we have one extra byte of random, and
# we're using the resulting string probably, and not the bytes directly
# e.g. in salting|signing
$ head -c 33  /dev/urandom | base64 --wrap=0 ;echo ''
XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX

```

### set-gcloud-vars

Script Template:

```bash
#!/usr/bin/env bash
GOOGLE_API_KEY=AAAAAAAAABBBBBBXXXXXX{PRIVATE}XXXXAAAABBBB
GITHUB_API_TOKEN=AAAAAAAAABBBBBBXXXXXX{PRIVATE}QQQZZZSSSSS
GITHUB_OAUTH_CLIENT_ID=AAAAAAAAABBBBBBXXXXXX{PRIVATE}QQQZZZSSSSS
GITHUB_OAUTH_CLIENT_SECRET=AAAAAAAAABBBBBBXXXXXX{PRIVATE}QQQZZZSSSSS
# whitelist user login names on github to have the role "engineer"
GITHUB_AUTH_ENGINEERS="[\"userlogina\", \"userloginb\", \"userloginc\"]"
# generated like so: $ head -c 33  /dev/urandom | base64 --wrap=0 ;echo ''
WEB_SERVER_COOKIE_SECRET=AAAAAAAAABBBBBBXXXXXX{PRIVATE}QQQZZZSSSSSSSS
DISPATCHER_MANAGER_SECRET=AAAAAAAAABBBBBBXXXXXX{PRIVATE}QQQZZZSSSSSSSS

RETHINKDB_PASSWORD=AAAAAAAAABBBBBBXXXXXX{PRIVATE}QQQZZZSSSSSSSS

# Note: the "-n fontbakery" argument is only needed if kubectl must address
# a special namespace e.g. in minikube but not on gcloud

kubectl -n fontbakery delete secret external-resources
kubectl -n fontbakery create secret generic external-resources \
     --from-literal=google-api-key=$GOOGLE_API_KEY \
     --from-literal=github-api-token=$GITHUB_API_TOKEN\
     --from-literal=github-oauth-client-id=$GITHUB_OAUTH_CLIENT_ID\
     --from-literal=github-oauth-client-secret=$GITHUB_OAUTH_CLIENT_SECRET\
     --from-literal=github-auth-engineers="$GITHUB_AUTH_ENGINEERS"\
     --from-literal=web-server-cookie-secret=$WEB_SERVER_COOKIE_SECRET\
     --from-literal=dispatcher-manager-secret=$DISPATCHER_MANAGER_SECRET\
     --from-literal=rethinkdb-password=$RETHINKDB_PASSWORD\
      ;

ENVIRONMENT_VERSION="$(date)" # like: Mi 8. Nov 03:57:01 CET 2017
kubectl -n fontbakery delete configmap env-config
kubectl -n fontbakery create configmap env-config --from-literal=ENVIRONMENT_VERSION="$ENVIRONMENT_VERSION"
```

Insert secrets, then run it:

```
# This can be done in a not public file

$ set-minikube-vars

# or

$ set-gcloud-vars

```


## ENVIRONMENT_VERSION

This is to control when already checked family version should be re-tested.
E.g. when fontbakery changed.

```
ENVIRONMENT_VERSION="$(date)" # Mi 8. Nov 03:57:01 CET 2017
kubectl delete configmap env-config
kubectl create configmap env-config --from-literal=ENVIRONMENT_VERSION="$ENVIRONMENT_VERSION"
```

## Deployments in order:

1. gcloud-rabbitmq.yaml, gcloud-rethinkdb-stage-1.yaml
2. gcloud-rethinkdb-stage-2.yaml
3. gcloud-fontbakery-storage-cache.yaml
4. gcloud-fontbakery-worker-cleanup.yaml, gcloud-fontbakery-worker-checker.yaml,
   gcloud-fontbakery-worker-distributor.yaml, gcloud-fontbakery-manifest-master.yaml
5. gcloud-fontbakery-api.yaml
6. gcloud-fontbakery-manifest-gfapi.yaml
7. gcloud-fontbakery-manifest-githubgf.yaml

## Docker stuff

```
docker build -t fontbakery/rethinkdb:2.3.6-fontbakery-6 containers/rethinkdb
docker tag fontbakery/rethinkdb:2.3.6-fontbakery-6 gcr.io/fontbakery-168509/rethinkdb:2.3.6-fontbakery-6
docker push gcr.io/fontbakery-168509/rethinkdb:2.3.6-fontbakery-6

docker build -t fontbakery/base-javascript:11 containers/base/javascript;
docker tag fontbakery/base-javascript:11 gcr.io/fontbakery-168509/base-javascript:11
docker push gcr.io/fontbakery-168509/base-javascript:11

docker build -t fontbakery/base-python:5 containers/base/python;
docker tag fontbakery/base-python:5 gcr.io/fontbakery-168509/base-python:5
docker push gcr.io/fontbakery-168509/base-python:5
```

# Deploy

```

kubectl apply -f kubernetes/gcloud-rabbitmq.yaml

kubectl apply -f kubernetes/gcloud-rethinkdb-stage-1.yaml
kubectl apply -f kubernetes/gcloud-rethinkdb-proxy.yaml
kubectl apply -f kubernetes/gcloud-rethinkdb-stage-2.yaml

kubectl apply -f kubernetes/gcloud-fontbakery-storage-cache.yaml
kubectl apply -f kubernetes/gcloud-fontbakery-storage-persistence.yaml

kubectl apply -f kubernetes/gcloud-fontbakery-worker.yaml

kubectl apply -f kubernetes/gcloud-fontbakery-reports.yaml
kubectl apply -f kubernetes/minikube-fontbakery-init-workers.yaml
kubectl apply -f kubernetes/gcloud-fontbakery-manifest-master.yaml

kubectl apply -f kubernetes/minikube-fontbakery-github-auth.yaml
kubectl apply -f kubernetes/minikube-fontbakery-github-operations.yaml

kubectl apply -f kubernetes/gcloud-fontbakery-manifest-csvupstream.yaml
kubectl apply -f kubernetes/gcloud-fontbakery-manifest-gfapi.yaml
kubectl apply -f kubernetes/gcloud-fontbakery-manifest-githubgf.yaml

kubectl apply -f kubernetes/gcloud-dispatcher.yaml
kubectl apply -f kubernetes/gcloud-fontbakery-api.yaml
```
### delete deployments

```
kubectl delete deployment fontbakery-storage-cache;
kubectl delete deployment fontbakery-worker-cleanup
kubectl delete deployment fontbakery-worker-checker
kubectl delete deployment fontbakery-worker-distributor
kubectl delete deployment fontbakery-api
kubectl delete deployment fontbakery-manifest-master

kubectl delete deployment fontbakery-manifest-gfapi
kubectl delete deployment fontbakery-manifest-githubgf
kubectl delete deployment fontbakery-manifest-csvupstream
```

### autoscale

```
kubectl autoscale deployment fontbakery-worker-checker --cpu-percent=80 --min=1 --max=700
```


### update an image (roling update style)

```
kubectl set image deployments/fontbakery-api fontbakery-api=gcr.io/fontbakery-168509/base-javascript:1

kubectl set image deployments/fontbakery-worker-checker fontbakery-worker-checker=gcr.io/fontbakery-168509/base-python:1


```

https://github.com/kubernetes/kubernetes/issues/24330#issuecomment-265750353

> Thought this might help anyone looking at how to remove inactive replicasets
(spec.replicas set to zero by the deployment). You may want to add something to
filter for replicasets actually managed by a deployment as this might end up
destroying manually created replicasets:

```
kubectl get --all-namespaces rs -o json|jq -r '.items[] | select(.spec.replicas | contains(0)) | "kubectl delete rs --namespace=\(.metadata.namespace) \(.metadata.name)"'
```

### label a node

```
# this will always run
kubectl label nodes gke-fontbakery-dashboard-default-pool-146c1d02-4c6c determination=infrastructure
```

```
# this is fired up to run with many checkers for a short period of time
kubectl label nodes gke-fontbakery-dashboard-sprint-pool-146c1d02-4c6c determination=checker-sprinter
```
### Labeling Clusters

Is not needed:
Each node in the pool has a Kubernetes node label with the node pool's
name in the key cloud.google.com/gke-nodepool

i.e: for the pool "checker-pool-1"
each node has a label: "cloud.google.com/gke-nodepool=checker-pool"


Thus we can say a pod to only attach to that pool with:

```
    spec:
      nodeSelector:
        cloud.google.com/gke-nodepool: checker-pool-1
```


## rethink reboot See #78

```
kubectl delete deployment rethinkdb-admin rethinkdb-proxy rethinkdb-replica-1 rethinkdb-replica-2 rethinkdb-replica-3  rethinkdb-replica-4
kubectl apply -f kubernetes/gcloud-rethinkdb-stage-1.yaml
kubectl apply -f kubernetes/gcloud-rethinkdb-proxy.yaml
kubectl apply -f kubernetes/gcloud-rethinkdb-stage-2.yaml
```


## May 2019 deployment

### docker

```
# do once:
$ gcloud auth configure-docker
# instead of the old workflow
$ gcloud docker -- push gcr.io/fontbakery-168509/base-javascript:3
# we now use simply
$ docker push gcr.io/fontbakery-168509/base-javascript:3
# that's all
```


## just update all deployments of our own services:

````
# note the deployment: fontbakery-storage-persistence
# has trouble updating this way, I think the single disk dependency is blocking
# this. The brutal way is to delete the deployment first, yeah that's some
# downtime then ...
$ ~/fontbakery-dashboard> kubectl delete deployment fontbakery-storage-persistence
# this excludes rabbitmq and rethinkdb
$ ~/fontbakery-dashboard> find ./kubernetes -type f -name 'gcloud-fontbakery-*' -exec kubectl apply -f {} ';'

```


## kubectl contexts cheatsheet:

```
# classic use minikube context explicitly
$ kubectl --context=minikube -n fontbakery
# and via an alias:
$ alias kf="kubectl --context=minikube -n fontbakery"


# current gcloud:
$ kubectl --context=gke_fontbakery-168509_us-central1-a_fontbakery-dashboard-1
# and via an alias:
$ alias gk="kubectl --context=gke_fontbakery-168509_us-central1-a_fontbakery-dashboard-1"

$ kubectl config get-contexts
CURRENT   NAME                                                         CLUSTER                                                      AUTHINFO                                                     NAMESPACE
          gke_fontbakery-168509_us-central1-a_fontbakery-dashboard-1   gke_fontbakery-168509_us-central1-a_fontbakery-dashboard-1   gke_fontbakery-168509_us-central1-a_fontbakery-dashboard-1
*         minikube                                                     minikube                                                     minikube

# set the gcloud context as default
$ kubectl config set-context gke_fontbakery-168509_us-central1-a_fontbakery-dashboard-1



```
