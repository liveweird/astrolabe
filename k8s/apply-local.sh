#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
    echo "usage: $0 <local-image-tag>" >&2
    exit 2
fi

image_tag=$1
case "$image_tag" in
    "" | [.-]* | *[!A-Za-z0-9_.-]*)
        echo "invalid Docker image tag: $image_tag" >&2
        exit 2
        ;;
esac
if [ "${#image_tag}" -gt 128 ]; then
    echo "Docker image tag is longer than 128 characters" >&2
    exit 2
fi

# The overlay runs development mode behind no proxy (k8s/local/front-door.yaml): it must only ever reach the
# local OrbStack cluster. Without an override the current-context must be `orbstack`; a person who really means
# another cluster sets ASTROLABE_KUBE_CONTEXT=<name> on purpose (it then names the target, whatever the
# current-context is). Every kubectl call below passes --context, so a context switch mid-run cannot redirect it.
if [ -n "${ASTROLABE_KUBE_CONTEXT:-}" ]; then
    kube_context=$ASTROLABE_KUBE_CONTEXT
else
    kube_context=orbstack
    current_context=$(kubectl config current-context)
    if [ "$current_context" != "$kube_context" ]; then
        echo "refusing: kubectl current-context is '$current_context', not '$kube_context' (the local overlay is development mode)." >&2
        echo "Run 'kubectl config use-context $kube_context', or set ASTROLABE_KUBE_CONTEXT=<name> on purpose." >&2
        exit 2
    fi
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
rendered_dir=$(mktemp -d)
trap 'rm -rf "$rendered_dir"' EXIT HUP INT TERM

# The Secret is intentionally excluded: create it out of band using secret.yaml's header.
# The app Deployment carries the `image: astrolabe-app:local-build` render placeholder, which the
# tag substitution below replaces.
# front-door.yaml (the production-posture ConfigMap) is excluded too: local/front-door.yaml, the OrbStack
# overlay with the SAME ConfigMap name, is rendered in its place, so exactly one `astrolabe-front-door`
# ConfigMap is applied. It is copied as 00-front-door.yaml so `kubectl apply -f <dir>` (filename order)
# creates it before the Deployment that reads it. The pod takes the values when its container starts:
# the unique image tag rolls the pod on every run (re-running with an unchanged tag after editing only the
# overlay does not restart it).
for manifest in "$script_dir"/*.yaml; do
    case "$(basename -- "$manifest")" in
        secret.yaml | app-deployment.yaml | front-door.yaml) continue ;;
    esac
    cp "$manifest" "$rendered_dir/"
done
cp "$script_dir/local/front-door.yaml" "$rendered_dir/00-front-door.yaml"

sed "s|image: astrolabe-app:local-build|image: astrolabe-app:$image_tag|" \
    "$script_dir/app-deployment.yaml" >"$rendered_dir/app-deployment.yaml"

kubectl --context "$kube_context" -n astrolabe get secret astrolabe-secrets >/dev/null
kubectl --context "$kube_context" apply -f "$rendered_dir"
