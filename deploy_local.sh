# envvars_setup.sh
PROJECT="fontbakery"
REGISTRY="localhost:5000"
DOCKER="docker"
DOCKER_PUSH="$DOCKER_PUSH"

# update_database:
$DOCKER build -t rethinkdb-2.3.5 containers/rethinkdb
$DOCKER tag rethinkdb-2.3.5 $REGISTRY/$PROJECT/rethinkdb-2.3.5
$DOCKER_PUSH $REGISTRY/$PROJECT/rethinkdb-2.3.5

kubectl delete rc rethinkdb-rc
kubectl create -f services/rethinkdb-driver-service.yaml
kubectl create -f services/rethinkdb-rc.yaml
kubectl create -f services/rethinkdb-admin-service.yaml

kubectl create -f services/rethinkdb-admin-pod.yaml

# update flask service
# Note: This will affect the publicly accessinble IP address.
kubectl delete svc flaskapp-service
kubectl create -f services/flask-service.yaml

# update_frontend:
$DOCKER build -t fb-dashboard-1 containers/web
$DOCKER tag fb-dashboard-1 $REGISTRY/$PROJECT/fb-dashboard-1
$DOCKER_PUSH $REGISTRY/$PROJECT/fb-dashboard-1
kubectl delete rc dashboard-rc
kubectl create -f services/dashboard-rc.yaml


#   -> "kill all":
kubectl delete svc rabbitmq-service
kubectl delete rc rabbitmq-controller
kubectl delete job job-fb-worker-1
kubectl delete job job-fb-dispatcher-1

# update_queue_service:
kubectl delete svc rabbitmq-service
kubectl delete rc rabbitmq-controller
kubectl create -f services/rabbitmq-service.yaml
kubectl create -f services/rabbitmq-controller.yaml

# update_workers:
$DOCKER build -t job-fb-worker-1 ..
$DOCKER tag job-fb-worker-1 $REGISTRY/$PROJECT/job-fb-worker-1
$DOCKER_PUSH $REGISTRY/$PROJECT/job-fb-worker-1
kubectl delete job job-fb-worker-1
kubectl create -f jobs/worker_local.yaml

# update_dispatcher:
$DOCKER build -t job-fb-dispatcher-1 containers/dispatcher
$DOCKER tag job-fb-dispatcher-1 $REGISTRY/$PROJECT/job-fb-dispatcher-1
$DOCKER_PUSH $REGISTRY/$PROJECT/job-fb-dispatcher-1
kubectl delete job job-fb-dispatcher-1
kubectl create -f jobs/dispatcher_local.yaml


$DOCKER build -t www-fontbakery:1 containers/fbdraganddrop/
$DOCKER tag www-fontbakery:1 $REGISTRY/$PROJECT/www-fontbakery:1
$DOCKER_PUSH $REGISTRY/$PROJECT/www-fontbakery:1
kubectl create -f kubernetes/web-fontbakery-deployment.yaml


# NOTE apply -f instead of create is better, because it can do incremental updates!

# update_workers:
$DOCKER build -t fontbakery-draganddrop-worker:1 containers/fbworker/
$DOCKER tag fontbakery-draganddrop-worker:1 $REGISTRY/$PROJECT/fontbakery-draganddrop-worker:1
$DOCKER push $REGISTRY/$PROJECT/fontbakery-draganddrop-worker:1
kubectl apply -f kubernetes/worker-fontbakery-deployment.yaml


kubectl delete job job-fb-worker-1
kubectl create -f jobs/worker_local.yaml


# > deployment "web-fonbakery" created
# > service "www-fontbakery-service" created
kubectl delete deployment web-fonbakery
kubectl delete service www-fontbakery-service

# overall status:
kubectl get jobs
kubectl get pods
kubectl get svc
kubectl get rc




