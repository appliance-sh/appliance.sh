#!/usr/bin/env bash
#
# End-to-end demo of the local container runtime. Boots a k3d
# cluster, launches the api-server against an `appliance-base-local`
# config, then deploys + destroys both demo containers via the public
# API. Mirrors what the desktop would do interactively.
#
# Requirements: docker, k3d, kubectl, curl, jq, node.
#
# Usage:
#   ./examples/demo-local-runtime.sh                  # deploy + destroy both demos
#   ACTION=deploy ./examples/demo-local-runtime.sh    # leave them running
#   ACTION=destroy ./examples/demo-local-runtime.sh   # destroy without deploying

set -euo pipefail

ACTION="${ACTION:-cycle}"
CLUSTER_NAME="${CLUSTER_NAME:-appliance-local}"
NAMESPACE="${NAMESPACE:-appliance}"
HOST_PORT="${HOST_PORT:-8081}"
API_PORT="${API_PORT:-3030}"
DATA_DIR="${DATA_DIR:-$HOME/.appliance/local-runtime}"
BOOTSTRAP_TOKEN="${BOOTSTRAP_TOKEN:-demo-bootstrap-token}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "$DATA_DIR"

require() {
  command -v "$1" >/dev/null 2>&1 || { echo "missing dependency: $1" >&2; exit 1; }
}
require docker
require k3d
require kubectl
require curl
require jq
require node

TSX="$REPO_ROOT/node_modules/.bin/tsx"
[[ -x "$TSX" ]] || { echo "tsx missing — run pnpm install at repo root first" >&2; exit 1; }

base_config=$(jq -n \
  --arg name "demo-local" \
  --arg type "appliance-base-local" \
  --arg dataDir "$DATA_DIR" \
  --arg clusterName "$CLUSTER_NAME" \
  --arg namespace "$NAMESPACE" \
  --argjson hostPort "$HOST_PORT" \
  '{type: $type, name: $name, local: {dataDir: $dataDir, cluster: {clusterName: $clusterName, namespace: $namespace, hostPort: $hostPort}}}')

echo "==> base config: $base_config"

start_cluster() {
  if k3d cluster list -o json | jq -e ".[] | select(.name == \"$CLUSTER_NAME\")" >/dev/null; then
    if k3d cluster list -o json | jq -e ".[] | select(.name == \"$CLUSTER_NAME\") | .nodes | all(.State.Running == true)" >/dev/null; then
      echo "==> k3d cluster '$CLUSTER_NAME' already running"
    else
      echo "==> starting existing k3d cluster '$CLUSTER_NAME'"
      k3d cluster start "$CLUSTER_NAME"
    fi
  else
    echo "==> creating k3d cluster '$CLUSTER_NAME' (host :$HOST_PORT -> lb)"
    k3d cluster create "$CLUSTER_NAME" --agents 1 -p "$HOST_PORT:80@loadbalancer" --wait
  fi
}

build_demo_image() {
  local dir=$1
  local name=$2
  echo "==> docker build $name from $dir"
  docker build --platform linux/amd64 -t "$name:latest" "$dir"
  k3d image import -c "$CLUSTER_NAME" "$name:latest"
}

start_api_server() {
  cd "$REPO_ROOT"
  echo "==> starting api-server on :$API_PORT"
  APPLIANCE_MODE=server \
  APPLIANCE_BASE_CONFIG="$base_config" \
  BOOTSTRAP_TOKEN="$BOOTSTRAP_TOKEN" \
  PORT="$API_PORT" \
  "$TSX" packages/api-server/src/main.ts \
    >/tmp/appliance-api-server.log 2>&1 &
  API_PID=$!
  echo "$API_PID" >/tmp/appliance-api-server.pid

  # No /healthz route — the api-server's root path returns 200 once it's listening.
  for _ in $(seq 1 30); do
    if curl -fsS "http://localhost:$API_PORT/" >/dev/null 2>&1; then
      echo "==> api-server up (pid $API_PID)"
      return 0
    fi
    sleep 1
  done
  echo "api-server failed to start; logs:" >&2
  cat /tmp/appliance-api-server.log >&2
  exit 1
}

stop_api_server() {
  if [[ -f /tmp/appliance-api-server.pid ]]; then
    pid=$(cat /tmp/appliance-api-server.pid)
    if kill -0 "$pid" 2>/dev/null; then
      echo "==> stopping api-server (pid $pid)"
      kill "$pid" || true
    fi
    rm -f /tmp/appliance-api-server.pid
  fi
}
trap stop_api_server EXIT

create_api_key() {
  echo "==> minting initial api key"
  curl -fsS -X POST "http://localhost:$API_PORT/bootstrap/create-key" \
    -H "X-Bootstrap-Token: $BOOTSTRAP_TOKEN" \
    -H 'content-type: application/json' \
    -d '{"name":"demo"}'
}

# This demo bypasses the CLI's HTTP signing — easier to keep the
# example dependency-free. We mint a key, then disable auth for the
# remainder of the run by talking to /api/internal/* via the same
# signing helper the cli uses. For simplicity here we POST through
# the bootstrap key directly using node's signing helper.

sign_and_call() {
  local method=$1 path=$2 body=${3:-}
  # Drives the SDK's signRequest via tsx; the repo's workspace
  # symlinks make `@appliance.sh/sdk` resolvable from the repo root.
  # The async IIFE wrap is required because tsx -e transpiles to CJS,
  # which forbids top-level await.
  (
    cd "$REPO_ROOT"
    METHOD="$method" REQ_PATH="$path" REQ_BODY="$body" "$TSX" -e '
      import { signRequest } from "@appliance.sh/sdk";
      (async () => {
        const method = process.env.METHOD!;
        const path = process.env.REQ_PATH!;
        const body = process.env.REQ_BODY || undefined;
        const url = `http://localhost:${process.env.API_PORT}${path}`;
        const headers: Record<string, string> = body ? { "content-type": "application/json" } : {};
        const sig = await signRequest(
          { keyId: process.env.KEY_ID!, secret: process.env.KEY_SECRET! },
          { method, url, headers, body }
        );
        const res = await fetch(url, { method, headers: { ...headers, ...sig }, body });
        const text = await res.text();
        if (!res.ok) {
          console.error(`HTTP ${res.status}: ${text}`);
          process.exit(1);
        }
        process.stdout.write(text);
      })();
    '
  )
}

deploy_demo() {
  local image=$1 port=$2 project_name=$3 env_name=$4

  echo "==> creating project '$project_name'"
  project=$(API_PORT=$API_PORT KEY_ID=$KEY_ID KEY_SECRET=$KEY_SECRET \
    sign_and_call POST /api/v1/projects "{\"name\":\"$project_name\"}")
  project_id=$(jq -r .id <<<"$project")

  echo "==> creating environment '$env_name'"
  env_json=$(API_PORT=$API_PORT KEY_ID=$KEY_ID KEY_SECRET=$KEY_SECRET \
    sign_and_call POST "/api/v1/projects/$project_id/environments" "{\"name\":\"$env_name\"}")
  env_id=$(jq -r .id <<<"$env_json")

  echo "==> registering build pointing to local image '$image'"
  build=$(API_PORT=$API_PORT KEY_ID=$KEY_ID KEY_SECRET=$KEY_SECRET \
    sign_and_call POST /api/v1/builds "{\"type\":\"remote-image\",\"uploadUrl\":\"$image\"}")
  build_id=$(jq -r .buildId <<<"$build")

  echo "==> dispatching deploy"
  dep=$(API_PORT=$API_PORT KEY_ID=$KEY_ID KEY_SECRET=$KEY_SECRET \
    sign_and_call POST /api/v1/deployments "{\"environmentId\":\"$env_id\",\"action\":\"deploy\",\"buildId\":\"$build_id\"}")
  dep_id=$(jq -r .id <<<"$dep")

  echo "==> waiting for deploy to finish"
  for _ in $(seq 1 90); do
    sleep 2
    out=$(API_PORT=$API_PORT KEY_ID=$KEY_ID KEY_SECRET=$KEY_SECRET \
      sign_and_call GET "/api/v1/deployments/$dep_id")
    status=$(jq -r .status <<<"$out")
    case "$status" in
      succeeded) echo "==> deployed: $out"; break ;;
      failed) echo "==> deploy failed: $out" >&2; exit 1 ;;
    esac
  done

  echo "==> exposing service via kubectl port-forward (probe only)"
  kubectl -n "$NAMESPACE" wait --for=condition=available --timeout=60s "deployment/$project_name-$env_name"
  kubectl -n "$NAMESPACE" get svc "$project_name-$env_name" -o wide
  echo "DEMO_PROJECT_ID_$project_name=$project_id" >>/tmp/appliance-demo.env
  echo "DEMO_ENV_ID_$env_name=$env_id" >>/tmp/appliance-demo.env
  echo "DEMO_LAST_DEP=$dep_id" >>/tmp/appliance-demo.env
  echo "DEMO_LAST_BUILD=$build_id" >>/tmp/appliance-demo.env
  echo "DEMO_LAST_PROJECT=$project_id" >>/tmp/appliance-demo.env
  echo "DEMO_LAST_ENV=$env_id" >>/tmp/appliance-demo.env
}

destroy_demo() {
  local project_name=$1 env_name=$2
  # The simplest local-mode destroy: hit /api/v1/deployments with action=destroy
  # against any environment that has a deployment. We look up the env id
  # from the project name.
  projects=$(API_PORT=$API_PORT KEY_ID=$KEY_ID KEY_SECRET=$KEY_SECRET \
    sign_and_call GET /api/v1/projects)
  project_id=$(jq -r ".[] | select(.name == \"$project_name\") | .id" <<<"$projects")
  envs=$(API_PORT=$API_PORT KEY_ID=$KEY_ID KEY_SECRET=$KEY_SECRET \
    sign_and_call GET "/api/v1/projects/$project_id/environments")
  env_id=$(jq -r ".[] | select(.name == \"$env_name\") | .id" <<<"$envs")
  dep=$(API_PORT=$API_PORT KEY_ID=$KEY_ID KEY_SECRET=$KEY_SECRET \
    sign_and_call POST /api/v1/deployments "{\"environmentId\":\"$env_id\",\"action\":\"destroy\"}")
  dep_id=$(jq -r .id <<<"$dep")
  for _ in $(seq 1 90); do
    sleep 2
    out=$(API_PORT=$API_PORT KEY_ID=$KEY_ID KEY_SECRET=$KEY_SECRET \
      sign_and_call GET "/api/v1/deployments/$dep_id")
    status=$(jq -r .status <<<"$out")
    case "$status" in
      succeeded) echo "==> destroyed: $out"; break ;;
      failed) echo "==> destroy failed: $out" >&2; exit 1 ;;
    esac
  done
}

main() {
  start_cluster
  build_demo_image "$REPO_ROOT/examples/demo-node-container" demo-node-container
  build_demo_image "$REPO_ROOT/examples/demo-python-container" demo-python-container

  start_api_server
  key=$(create_api_key)
  # Bootstrap response: { id, name, secret, createdAt }. `id` is the
  # access-key id (apikey_...) the signature header carries; `secret`
  # is the raw secret (sk_...). Both are required by signRequest.
  KEY_ID=$(jq -r .id <<<"$key")
  KEY_SECRET=$(jq -r .secret <<<"$key")
  export KEY_ID KEY_SECRET API_PORT

  case "$ACTION" in
    deploy|cycle)
      deploy_demo demo-node-container:latest 3000 demo-node prod
      deploy_demo demo-python-container:latest 8080 demo-python prod
      ;;
  esac

  case "$ACTION" in
    destroy|cycle)
      destroy_demo demo-node prod
      destroy_demo demo-python prod
      ;;
  esac

  echo
  echo "==> done. cluster '$CLUSTER_NAME' is still running."
  echo "    delete it later with: k3d cluster delete $CLUSTER_NAME"
}

main "$@"
