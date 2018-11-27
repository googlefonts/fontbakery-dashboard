This is a historically ordered document of useful commands when working with minikube,

See: googlefonts/fontbakery-dashboard#3

---

Executing in the shell:
```
$ minikube service flaskapp-service
```
opens for me the local web frontend in the browser.

even though:

```
$ kubectl get services flaskapp-service
```

reports `EXTERNAL-IP` as `<pending>`

Similarly:

```
$ minikube dashboard
```

opens the Kubernetes Dashboard in the browser, very helpful thing.

---

One of the most annoying things with Minikube is establishing a local docker registry, where k8s can pull images from. We want to have it locally, so that we don't have to push and then pull images through the internet via a e.g. google hosted docker registry server.

This solution creates a registry server within the minikube vm images and persists the registry data between reboots of minikube `minikube stop; minikube start`:

## Minikube needs no docker registry


```
# start minikube normally:
$ minikube start

# use minikubes docker:
$ . <(minikube docker-env)

# build and tag an image as "fontbakery/base-python:1":
$ docker build -t fontbakery/base-python:1 containers/base-python/

```

In the yaml file, the container is referenced directly by its tag `fontbakery/base-python:1`:

```yaml
# minikube-fontbakery-worker-checker.yaml
[…]
    spec:
      containers:
      - name: fontbakery-worker-checker
        image: fontbakery/base-python:1
        workingDir: /var/python
        command: ["python3",  "-u", "fontbakery-worker-checker.py"]
[…]
```

This can be applied directly **without** `$ docker push`:

```
# NAMESPACE=fontbakery
$ kubectl -n $NAMESPACE apply -f minikube-fontbakery-worker-checker.yaml
```




### DEPRECATED! (see above "Minikube needs no docker registry") set up the docker registry

> ```
>
> # we'll always have to start minikube with the `--insecure-registry` option
> $ minikube start --insecure-registry localhost:5000
>
> # this will make the local `docker` command use the minikube vm as docker host
> # thus all commands starting with `docker` will affect the minikube vm not the host computer
> $ eval $(minikube docker-env)
>
> # "registry:2" is: https://github.com/docker/distribution
> #  `/data` within minikube is persisted, as documented per:
> # https://github.com/kubernetes/minikube/blob/master/docs/persistent_volumes.md#persistent-volumes
> docker run -d -p 5000:5000 --restart=always --name registry   -v /data/docker-registry:/var/lib/registry registry:2
> ```
>
> That's it, now we can use docker to build images, then tag them like in this example:
>
> ```
> docker tag rethinkdb-2.3.5 localhost:5000/fontbakery/rethinkdb-2.3.5
> docker push localhost:5000/fontbakery/rethinkdb-2.3.5
> ```
>
> To pull them in k8s, the `yml` `spec.containers.image` key looks like this:
>
> ```
> spec:
>   containers:
>   - image: localhost:5000/fontbakery/rethinkdb-2.3.5
>     name: rethinkdb
> ```
>
> After the registry setup, starting minikube always involves:
>
> ```
> $ minikube start --insecure-registry localhost:5000
> # AND *important*
> $ eval $(minikube docker-env)
> ```

---

Here are some more commands from the category **good to know**

```
# get a shell in the minikube vm:
$ minikube ssh

# this can be used to inspect the docker registry storage, so you know it works:
# within the minikube vm:
$ ls /data/docker-registry/docker/registry/v2/repositories/fontbakery/
rethinkdb-2.3.5
```

List all pods:

```
kubectl get pods
```
get a shell in a pod
```
kubectl  exec -it rethinkdb-rc-k1n4d -- /bin/bash
```

We can also get a shell in any of the running docker containers directly via docker. This requires that the docker host is the minikube vm, i.e. `$ eval $(minikube docker-env)` was executed in the current shell.

```
# by name
$ docker exec -it registry /bin/sh
# Instead of "registry", this could also be a docker id.
# Use `docker ps` to get a list of all containers with id and name.
```


## more nicer docker env:

before I was setting up the docker env with:

```
$ eval $(minikube docker-env)
```

but I actually think, **for bash users** this is nicer:
```
$ source <(minikube docker-env)
```
or, even shorter:

```
$ . <(minikube docker-env)
```

---


For local development, I'm using a k8s [namespace](https://kubernetes.io/docs/concepts/overview/working-with-objects/namespaces/) "fontbakery".
```
$ kubectl create namespace fontbakery
```


Despite the documentation stating:

>  For clusters with a few to tens of users, you should not need to create or think about namespaces at all.

The reason is that I can easily delete the whole namespace and thus wipe out all state in it. This is really interesting for development, e.g. when working on how to bootstrap the cluster from zero and resetting is needed frequently.

 delete with:

```
$ kubectl delete namespace fontbakery
```

If you try this with the `default` namespace you get:

```
$ kubectl delete namespace default
Error from server (Forbidden): namespaces "default" is forbidden: this namespace may not be deleted
```

Thus, you'd have to clean up the items of the namespace by hand.

To make `kubectl` use the namespace:

```
$  kubectl config set-context $(kubectl config current-context) --namespace=fontbakery
```
*NOTE:* It looks like this config setting does not persist across `minikube` reboots!

Alternatively, `kubectl` can be used with `--namespace=fontbakery`  on every `kubectl` command, like:

```
$ kubectl --namespace=fontbakery get pods
# or just do:
$ alias kf="kubectl -n fontbakery"
# now:
$ kf get pods
```

---

Get the logs of a pod live:

```
kubectl  --namespace=fontbakery  logs -f fontbakery-api-3811584483-6mpgg
```

---


* when developing in minikube
* while using `$ . <(minikube docker-env)`
* when minikube is up and running

It's sometimes good to run:

```
$ docker rmi $(docker images -q)
```

to remove unused docker images and release disk space.

IMPORTANT: minikube must be running, so that we don't delete docker images that are currently used. I wonder at this point if we even need a local docker registry when we build with `minikube docker-env`.

---



## just rebuilt everything from scratch:

### 1. protobufs:

```
$ /fontbakery-dashboard/containers/base$ ./update_protobufs.sh
```


```
$ minikube start
$ . <(minikube docker-env)
$ docker build -t fontbakery/base-javascript:4 containers/base/javascript/
$ docker build -t fontbakery/base-python:5 containers/base/python/
$ kubectl create namespace fontbakery
$ alias kf="kubectl -n fontbakery"
$ ENVIRONMENT_VERSION="$(date)"
$ kf create configmap env-config --from-literal=ENVIRONMENT_VERSION="$ENVIRONMENT_VERSION"
# same order as in DEPLOY log
$ kf apply -f kubernetes/minikube-rabbitmq.yaml
$ kf apply -f kubernetes/minikube-rethinkdb.yaml
$ kf apply -f kubernetes/minikube-fontbakery-cache.yaml
$ kf apply -f kubernetes/minikube-fontbakery-worker-cleanup.yaml
$ kf apply -f kubernetes/minikube-fontbakery-worker-checker.yaml
# SKIP for now (don't want to kick of the checking at the moment!)
# $ kf apply -f kubernetes/minikube-fontbakery-worker-distributor.yaml
$ kf apply -f kubernetes/minikube-fontbakery-manifest-master.yaml
$ kf apply -f kubernetes/minikube-fontbakery-api.yaml
# now: open web frontend: $ minikube -n fontbakery service fontbakery-api
# SKIP: (do not need right now)
# $ kf apply -f kubernetes/minikube-fontbakery-manifest-gfapi.yaml
# $ kf apply -f kubernetes/minikube-fontbakery-manifest-githubgf.yaml
$ kf apply -f kubernetes/minikube-fontbakery-manifest-csvupstream.yaml
$ kf apply -f kubernetes/minikube-fontbakery-reports.yaml



```


# cheat sheet:

## services:

```
# rethinkdb admin interface in browser
$ minikube -n fontbakery service rethinkdb-admin

# web frontend in browser
$ minikube -n fontbakery service fontbakery-api

# rabbitmq admin interface; user: "guest" password: "guest"
$ minikube -n fontbakery service rabbitmq-management
```
