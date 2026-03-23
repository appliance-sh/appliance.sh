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

# Build the Docker image (the CLI skips docker build when scripts.build is set)
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLATFORM="${APPLIANCE_PLATFORM:-linux/amd64}"
IMAGE_NAME="appliance-api-server"

echo "Building Docker image: $IMAGE_NAME (platform: $PLATFORM)..."
docker build --platform "$PLATFORM" --provenance=false -t "$IMAGE_NAME" "$SCRIPT_DIR"
