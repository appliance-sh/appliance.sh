FROM node:22-slim AS build

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10 --activate

# Disable husky git hooks (not needed in Docker)
ENV HUSKY=0

# Add the pulumi binary to the PATH
RUN curl -fsSL https://get.pulumi.com | sh
ENV PATH=$PATH:/root/.pulumi/bin

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
COPY src/ packages/api-server/src/
RUN pnpm --filter @appliance.sh/api-server run build

# --- Production stage ---
FROM node:22-slim

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10 --activate

# Disable husky git hooks (not needed in Docker)
ENV HUSKY=0

# Install the Pulumi binary and add it to the PATH
RUN curl -fsSL https://get.pulumi.com | sh
ENV PATH=$PATH:/root/.pulumi/bin

COPY .docker-deps/root-package.json package.json
COPY .docker-deps/pnpm-lock.yaml pnpm-lock.yaml
COPY .docker-deps/pnpm-workspace.yaml pnpm-workspace.yaml
COPY .docker-deps/sdk/package.json packages/sdk/
COPY .docker-deps/infra/package.json packages/infra/
COPY package.json packages/api-server/

RUN pnpm install --frozen-lockfile --prod --filter @appliance.sh/sdk --filter @appliance.sh/infra --filter @appliance.sh/api-server

# Copy built output
COPY --from=build /app/packages/sdk/dist/ packages/sdk/dist/
COPY --from=build /app/packages/infra/dist/ packages/infra/dist/
COPY --from=build /app/packages/api-server/dist/ packages/api-server/dist/

ENV PORT=3000
EXPOSE 3000

CMD ["node", "packages/api-server/dist/main.js"]
