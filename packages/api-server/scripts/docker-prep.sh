#!/bin/bash
set -euo pipefail

# Build workspace dependencies from the monorepo root
REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"

pushd "$REPO_ROOT" > /dev/null

echo "Building SDK..."
pnpm --filter @appliance.sh/sdk run build

echo "Building infra..."
pnpm --filter @appliance.sh/infra run build

echo "Building api-server..."
pnpm --filter @appliance.sh/api-server run build

popd > /dev/null

# Stage workspace deps into .docker-deps/ so the Dockerfile can COPY them
STAGE_DIR="$(cd "$(dirname "$0")/.." && pwd)/.docker-deps"
rm -rf "$STAGE_DIR"
mkdir -p "$STAGE_DIR/sdk" "$STAGE_DIR/infra"

# Copy built output and package.json for each dep
cp "$REPO_ROOT/packages/sdk/package.json" "$STAGE_DIR/sdk/"
cp -r "$REPO_ROOT/packages/sdk/dist" "$STAGE_DIR/sdk/dist"

cp "$REPO_ROOT/packages/infra/package.json" "$STAGE_DIR/infra/"
cp -r "$REPO_ROOT/packages/infra/dist" "$STAGE_DIR/infra/dist"

# Copy root package files for workspace install
cp "$REPO_ROOT/package.json" "$STAGE_DIR/root-package.json"
cp "$REPO_ROOT/pnpm-lock.yaml" "$STAGE_DIR/pnpm-lock.yaml"
cp "$REPO_ROOT/pnpm-workspace.yaml" "$STAGE_DIR/pnpm-workspace.yaml"
cp "$REPO_ROOT/tsconfig.json" "$STAGE_DIR/root-tsconfig.json"

echo "Docker deps staged in .docker-deps/"

# Build a local Docker image as a dev-convenience after staging.
# Skipped in CI: the matrix release workflow runs its own per-shard
# `docker buildx build` with the right --platform, and a hardcoded
# `--platform linux/amd64` here would cross-compile to the wrong arch
# on a native arm64 runner (manifests as `exec /bin/sh: exec format
# error` in the base stage). Set APPLIANCE_FORCE_DOCKER_BUILD=1 to
# opt back in if you need the script to build inside CI for some
# reason.
if [ -z "${CI:-}" ] || [ -n "${APPLIANCE_FORCE_DOCKER_BUILD:-}" ]; then
  SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
  PLATFORM="${APPLIANCE_PLATFORM:-linux/amd64}"
  IMAGE_NAME="appliance-api-server"

  echo "Building Docker image: $IMAGE_NAME (platform: $PLATFORM)..."
  docker build --platform "$PLATFORM" --provenance=false -t "$IMAGE_NAME" "$SCRIPT_DIR"
else
  echo "CI detected — skipping local Docker image build (the workflow handles per-platform builds)."
fi
