FROM node:22-slim AS build

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10 --activate

# Disable husky git hooks (not needed in Docker)
ENV HUSKY=0

# Install curl (not included in node:22-slim) and Pulumi (needed by postinstall).
# Pulumi installs into $HOME/.pulumi/bin (here, /root/.pulumi/bin). On Lambda
# the container runs as a non-root user that cannot traverse /root (mode 0700),
# so we copy the binaries into /usr/local/bin where they are world-executable.
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL https://get.pulumi.com | sh \
    && cp /root/.pulumi/bin/* /usr/local/bin/ \
    && rm -rf /root/.pulumi

# Copy root workspace config (staged by docker-prep.sh)
COPY .docker-deps/root-package.json package.json
COPY .docker-deps/pnpm-lock.yaml pnpm-lock.yaml
COPY .docker-deps/pnpm-workspace.yaml pnpm-workspace.yaml

# Copy workspace package.json files for install
COPY .docker-deps/sdk/package.json packages/sdk/
COPY .docker-deps/infra/package.json packages/infra/
COPY package.json packages/api-server/

# Install api-server dependencies via workspace
RUN pnpm install --frozen-lockfile --filter @appliance.sh/sdk --filter @appliance.sh/infra --filter @appliance.sh/api-server

# Copy pre-built SDK and infra
COPY .docker-deps/sdk/dist/ packages/sdk/dist/
COPY .docker-deps/infra/dist/ packages/infra/dist/

# Copy api-server source and build
COPY .docker-deps/root-tsconfig.json tsconfig.json
COPY tsconfig.json packages/api-server/
COPY tsconfig.build.json packages/api-server/
COPY src/ packages/api-server/src/
RUN pnpm --filter @appliance.sh/api-server run build

# --- Production stage ---
FROM public.ecr.aws/awsguru/aws-lambda-adapter:0.9.0 AS lwa

FROM node:22-slim

WORKDIR /app

# Lambda Web Adapter: copied in as an extension, inert outside Lambda
# (activates only when AWS_LAMBDA_RUNTIME_API is set). Lets this same
# image run as a regular HTTP container locally and as a Lambda
# container in AWS without code changes.
COPY --from=lwa /lambda-adapter /opt/extensions/lambda-adapter
ENV AWS_LWA_PORT=3000

RUN corepack enable && corepack prepare pnpm@10 --activate

# Disable husky git hooks (not needed in Docker)
ENV HUSKY=0

# Install curl and unzip (not included in node:22-slim), then Pulumi and crane.
# unzip provides both `unzip` and `zipinfo`, which build.service.ts uses to
# validate and extract uploaded appliance builds.
#
# Pulumi installs to /root/.pulumi/bin by default. On Lambda the container runs
# as a non-root user that cannot traverse /root (mode 0700), so we relocate the
# binaries to /usr/local/bin where they are world-executable.
#
# TARGETARCH is set automatically by buildx for multi-platform builds
# (amd64 / arm64). crane's release asset naming uses x86_64 / arm64 —
# map from Docker's TARGETARCH before pulling. Pulumi's installer
# picks the right binary on its own.
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates unzip \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL https://get.pulumi.com | sh \
    && cp /root/.pulumi/bin/* /usr/local/bin/ \
    && rm -rf /root/.pulumi \
    && case "${TARGETARCH:-amd64}" in \
         amd64) CRANE_ARCH=x86_64 ;; \
         arm64) CRANE_ARCH=arm64 ;; \
         *) echo "unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
       esac \
    && curl -sL "https://github.com/google/go-containerregistry/releases/latest/download/go-containerregistry_Linux_${CRANE_ARCH}.tar.gz" \
       | tar -xzf - -C /usr/local/bin crane

# Crane writes its auth config to $DOCKER_CONFIG (or $HOME/.docker by default).
# On Lambda $HOME points at a read-only sandbox dir, so we direct crane at /tmp
# which is the only writable filesystem in the Lambda execution environment.
ENV DOCKER_CONFIG=/tmp/.docker

COPY .docker-deps/root-package.json package.json
COPY .docker-deps/pnpm-lock.yaml pnpm-lock.yaml
COPY .docker-deps/pnpm-workspace.yaml pnpm-workspace.yaml
COPY .docker-deps/sdk/package.json packages/sdk/
COPY .docker-deps/infra/package.json packages/infra/
COPY package.json packages/api-server/

RUN pnpm install --frozen-lockfile --prod --filter @appliance.sh/sdk --filter @appliance.sh/infra --filter @appliance.sh/api-server

# Precache the Pulumi resource plugins that ApplianceDeploymentService uses.
# Versions are read from the installed node_modules so they track whatever
# pnpm resolved from the lockfile — no hardcoded list to drift. The plugin
# binaries land in /opt/pulumi-cache/plugins and are symlinked into the
# runtime PULUMI_HOME by ApplianceDeploymentService.ensurePluginCache at
# first use, avoiding a 150+ MB cold-start download.
RUN set -eux; \
    AWS_VERSION=$(node -p "require('./packages/infra/node_modules/@pulumi/aws/package.json').version"); \
    AWS_NATIVE_VERSION=$(node -p "require('./packages/infra/node_modules/@pulumi/aws-native/package.json').version"); \
    AWSX_VERSION=$(node -p "require('./packages/infra/node_modules/@pulumi/awsx/package.json').version"); \
    PULUMI_HOME=/opt/pulumi-cache pulumi plugin install resource aws "v$AWS_VERSION"; \
    PULUMI_HOME=/opt/pulumi-cache pulumi plugin install resource aws-native "v$AWS_NATIVE_VERSION"; \
    PULUMI_HOME=/opt/pulumi-cache pulumi plugin install resource awsx "v$AWSX_VERSION"

# Copy built output
COPY --from=build /app/packages/sdk/dist/ packages/sdk/dist/
COPY --from=build /app/packages/infra/dist/ packages/infra/dist/
COPY --from=build /app/packages/api-server/dist/ packages/api-server/dist/

ENV PORT=3000
EXPOSE 3000

CMD ["node", "packages/api-server/dist/main.js"]
