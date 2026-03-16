FROM node:22-slim AS build

WORKDIR /app

# Copy root workspace config (staged by docker-prep.sh)
COPY .docker-deps/root-package.json package.json
COPY .docker-deps/root-package-lock.json package-lock.json

# Copy workspace package.json files for install
COPY .docker-deps/sdk/package.json packages/sdk/
COPY .docker-deps/infra/package.json packages/infra/
COPY package.json packages/api-server/

# Install api-server dependencies via workspace
RUN npm ci --ignore-scripts --workspace=packages/sdk --workspace=packages/infra --workspace=packages/api-server

# Copy pre-built SDK and infra
COPY .docker-deps/sdk/dist/ packages/sdk/dist/
COPY .docker-deps/infra/dist/ packages/infra/dist/

# Copy api-server source and build
COPY .docker-deps/root-tsconfig.json tsconfig.json
COPY tsconfig.json packages/api-server/
COPY src/ packages/api-server/src/
RUN npm run --workspace=packages/api-server build

# --- Production stage ---
FROM node:22-slim

WORKDIR /app

COPY .docker-deps/root-package.json package.json
COPY .docker-deps/root-package-lock.json package-lock.json
COPY .docker-deps/sdk/package.json packages/sdk/
COPY .docker-deps/infra/package.json packages/infra/
COPY package.json packages/api-server/

RUN npm ci --ignore-scripts --omit=dev --workspace=packages/sdk --workspace=packages/infra --workspace=packages/api-server

# Copy built output
COPY --from=build /app/packages/sdk/dist/ packages/sdk/dist/
COPY --from=build /app/packages/infra/dist/ packages/infra/dist/
COPY --from=build /app/packages/api-server/dist/ packages/api-server/dist/

ENV PORT=3000
EXPOSE 3000

CMD ["node", "packages/api-server/dist/main.js"]
