This is a historically ordered document of useful commands when working with minikube,

See: googlefonts/fontbakery-dashboard#3

---

### Project Setup with Skaffold:

1. Install minikube + kubectl
2. Start minikube: `minikube start --memory 8000 --vm-driver=virtualbox`
3. Configure Docker for Minikube: `. <(minikube docker-env)`
4. Create a namespace for your environment: `kubectl create namespace fontbakery`
5. Set enviroment variables: `./set_minikube_vars` (Ask former developers for file)
6. Install [Skaffold](https://skaffold.dev/docs/install/).
7. From the root of the repo, run `skaffold dev -n fontbakery --port-forward`.

This will build all images and deploy to your local Minkube.
Additionally, it will watch your project for changes and rebuild and redeploy containers as needed.

[Skaffold file sync](https://skaffold.dev/docs/pipeline-stages/filesync/) is configured for the dashboard frontend.
This enables a faster development cycle, where changed files are automatically copied into the container without having to rebuild and redeploy the container.

[Skaffold port-forwarding](https://skaffold.dev/docs/pipeline-stages/port-forwarding/) is configured to forward `localhost:3000` to the `fontbakery-api` container.

### Project Setup (manual):

```
# 1. Install minikube + kubectl

# 2. Start minikube
$ minikube start --memory 8000 --vm-driver=virtualbox
$ . <(minikube docker-env)

# 3. Build docker images
$ docker build -t fontbakery/rethinkdb:2.3.6-fontbakery-1 containers/rethinkdb
$ docker build -t fontbakery/base-javascript:1 containers/base/javascript/
$ docker build -t fontbakery/base-python:1 containers/base/python/

# 4. Make your cluster easily accessible
$ kubectl create namespace fontbakery
$ alias kf="kubectl --context=minikube -n fontbakery"

# 5 Create a file named `set-minikube-vars.sh` in the root of the project and make it exacutable. Here the project secets are kept.
$ touch set_minikube_vars.sh
$ chmod +x ./set_minicube_vars.sh
$ ./set_minikube_vars

# 6. Start the Kubernetes pods
$ kf apply -f kubernetes/minikube-rabbitmq.yaml
$ kf apply -f kubernetes/minikube-rethinkdb.yaml
$ kf apply -f kubernetes/minikube-fontbakery-storage-cache.yaml
$ kf apply -f kubernetes/minikube-fontbakery-storage-persistence.yaml
$ kf apply -f kubernetes/minikube-fontbakery-init-workers.yaml
$ kf apply -f kubernetes/minikube-fontbakery-worker.yaml
$ kf apply -f kubernetes/minikube-fontbakery-manifest-master.yaml
$ kf apply -f kubernetes/minikube-fontbakery-github-auth.yaml
$ kf apply -f kubernetes/minikube-fontbakery-github-operations.yaml
$ kf apply -f kubernetes/minikube-fontbakery-reports.yaml
$ kf apply -f kubernetes/minikube-fontbakery-manifest-githubgf.yaml
$ kf apply -f kubernetes/minikube-fontbakery-manifest-gfapi.yaml
$ kf apply -f kubernetes/minikube-fontbakery-manifest-csvupstream.yaml
$ kf apply -f kubernetes/minikube-fontbakery-dispatcher.yaml
$ kf apply -f kubernetes/minikube-fontbakery-api.yaml

# 7. Check if the pods are running correctly 
$ watch kubectl -n fontbakery get pods 

# 8. Run the project and make sure the api-pod name is correct (use: $kf get pods)
$ kf port-forward fontbakery-api-0000000000-00000 3000:3000
```

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
# minikube-fontbakery-worker.yaml
[…]
    spec:
      containers:
      - name: fontbakery-worker
        image: fontbakery/base-python:1
        workingDir: /var/python
        command: ["python3",  "-u", "worker-launcher.py"]
[…]
```

This can be applied directly **without** `$ docker push`:

```
# NAMESPACE=fontbakery
$ kubectl -n $NAMESPACE apply -f minikube-fontbakery-worker.yaml
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
$ alias kf="kubectl --context=minikube  -n fontbakery"
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


### 2. set-minikube-vars
For the `set-minikube-vars` see the [script template](./DEPLOYLOG.md#set-gcloud-vars).



```
$ minikube start
$ . <(minikube docker-env)
$ docker build -t fontbakery/rethinkdb:2.3.6-fontbakery-1 containers/rethinkdb
$ docker build -t fontbakery/base-javascript:1 containers/base/javascript/
$ docker build -t fontbakery/base-python:1 containers/base/python/
$ kubectl create namespace fontbakery
$ alias kf="kubectl --context=minikube -n fontbakery"
# see script template link above
$ ./set-minikube-vars
# same order as in DEPLOY log
$ kf apply -f kubernetes/minikube-rabbitmq.yaml
$ kf apply -f kubernetes/minikube-rethinkdb.yaml
$ kf apply -f kubernetes/minikube-fontbakery-storage-cache.yaml
$ kf apply -f kubernetes/minikube-fontbakery-storage-persistence.yaml
$ kf apply -f kubernetes/minikube-fontbakery-init-workers.yaml
$ kf apply -f kubernetes/minikube-fontbakery-worker.yaml
# SKIP for now (don't want to kick of the checking at the moment!)
$ kf apply -f kubernetes/minikube-fontbakery-manifest-master.yaml
# new stuff
$ kf apply -f kubernetes/minikube-fontbakery-github-auth.yaml
$ kf apply -f kubernetes/minikube-fontbakery-github-operations.yaml
# end new stuff

$ kf apply -f kubernetes/minikube-fontbakery-reports.yaml
# SKIP: (do not need right now)
# $ kf apply -f kubernetes/minikube-fontbakery-manifest-githubgf.yaml
$ kf apply -f kubernetes/minikube-fontbakery-manifest-gfapi.yaml
$ kf apply -f kubernetes/minikube-fontbakery-manifest-csvupstream.yaml



$ kf apply -f kubernetes/minikube-fontbakery-dispatcher.yaml
$ kf apply -f kubernetes/minikube-fontbakery-api.yaml
# now: open web frontend: $ minikube -n fontbakery service fontbakery-api

```

# cheat sheet:

## Run with working github OATUH

The OAUTH setup is currently pointing at http://localhost:3000 as a
app adress, hence we need to make sure that exists:

```
$ kf port-forward service/fontbakery-api 3000:80
```
## Get a shell in a running pod

```
$ kf get pods
NAME                                               READY     STATUS    RESTARTS   AGE
[...]
fontbakery-worker-5b5f68fc48-g847t                 1/1       Running   0          1m
[...]
$ kf exec -it fontbakery-worker-5b5f68fc48-g847t -- /bin/bash
```

## Get the logs of a pod in a tail -f fashion

```
$ kf logs -f fontbakery-worker-5b5f68fc48-g847t
```

## services:

```
# rethinkdb admin interface in browser
$ minikube -n fontbakery service rethinkdb-admin

# web frontend in browser
$ minikube -n fontbakery service fontbakery-api

# rabbitmq admin interface; user: "guest" password: "guest"
$ minikube -n fontbakery service rabbitmq-management
```

### heapster resource monitoring
```
# activate
minikube addons enable heapster

# deactivate

# when active
$ minikube addons open heapster


```
