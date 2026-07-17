# Appliance.sh Testing Guide

## Running Tests

### All automated tests

```bash
# SDK unit tests
npm run --workspace=packages/sdk test

# API server unit tests
npm run --workspace=packages/api-server test

# API server E2E tests
npm run --workspace=packages/api-server test:e2e

# Watch mode (api-server)
npm run --workspace=packages/api-server test:watch
```

### Test coverage

```bash
npm run --workspace=packages/api-server test:cov
```

---

## Test Architecture

### SDK Tests (`packages/sdk/src/**/*.spec.ts`)

| File                      | What it tests                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------------ |
| `models/models.spec.ts`   | Zod schema validation for all data models (project, environment, deployment, appliance, api-key) |
| `signing/signing.spec.ts` | HTTP message signing: `signRequest`, `verifySignedRequest`, `computeContentDigest`               |

### API Server Unit Tests (`packages/api-server/src/**/*.spec.ts`)

| File                                       | What it tests                                                                                                                                                                                                                                                      |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `services/api-key.service.spec.ts`         | API key creation, retrieval, existence check, lastUsed                                                                                                                                                                                                             |
| `services/project.service.spec.ts`         | Project CRUD with mocked storage                                                                                                                                                                                                                                   |
| `services/environment.service.spec.ts`     | Environment CRUD, status transitions, project filtering                                                                                                                                                                                                            |
| `middleware/auth.spec.ts`                  | Signature verification middleware (valid/invalid/missing signatures)                                                                                                                                                                                               |
| `app.controller.spec.ts`                   | Root route and unauthenticated 401 response                                                                                                                                                                                                                        |
| `routes/bootstrap/bootstrap.spec.ts`       | Bootstrap key creation and status routes                                                                                                                                                                                                                           |
| `routes/projects/projects.spec.ts`         | Project CRUD routes                                                                                                                                                                                                                                                |
| `routes/environments/environments.spec.ts` | Environment CRUD routes with project scoping                                                                                                                                                                                                                       |
| `routes/deployments/deployments.spec.ts`   | Deployment execution and retrieval routes                                                                                                                                                                                                                          |
| `services/image-build.service.spec.ts`     | Server-side image builds: the server-generated Dockerfile for `framework` apps (node/python/auto detection, lockfile-aware installs, start-command resolution), `ensureDockerfile` pass-through/escape-hatch rules for `container` apps, and build-zip path safety |
| `services/build-upload.service.spec.ts`    | Upload-URL minting: a self-URL + one-time token on Kubernetes bases with a builder; rejection without a builder; the removed docker base errors with migration guidance; `markUploaded` burns the token                                                            |
| `routes/builds/content.spec.ts`            | `PUT /api/v1/builds/:id/content?token=…` — the one-time upload token: a valid token writes the zip and is burned; wrong/missing tokens, unknown builds, remote-image builds, and re-uploads all 404; oversized content 413s and leaves no zip                      |

### E2E Tests (`packages/api-server/test/**/*.e2e-spec.ts`)

Full lifecycle tests using in-memory storage and real HTTP message signing:

- Bootstrap flow (create key, check status)
- Authenticated project CRUD
- Environment lifecycle under projects
- Cross-project isolation

### VM engine tests (`packages/vm`, `cargo test`)

Rust unit tests cover the guest provisioning that stages and launches the
in-VM api-server:

| Where                       | What it asserts                                                                                                                                                                                                                                                                                                                                    |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/guest.rs` (vz backend) | `apiserver_provisioned_on_k3s_vms_with_staged_assets_only` — the `__APISERVER_PROVISION__` marker is substituted, the guest binary is copied from the boot media to `/usr/local/bin/appliance-api-server`, and provisioning is skipped when no assets are staged; `apiserver_heredocs_terminate` — every heredoc in the generated bootstrap closes |
| `src/guest.rs`              | `bootstrap_token_persists_and_round_trips` — `ensure_bootstrap_token` generates the token once (32 random bytes, hex-encoded) into the VM dir (`~/.appliance/vm/<name>/bootstrap-token`) and returns the same value on every subsequent call                                                                                                       |
| `src/backend/wsl.rs`        | `bootstrap_substitutes_every_marker` — the WSL bootstrap substitutes the `__APISERVER_*__` markers (win-path copy, token, guest port, launch env) and writes the token + the `/persist/.apiserver-ready` handoff                                                                                                                                   |

Run with `cargo test` in `packages/vm` (no VM boot required — these are pure
script-generation assertions).

### Live no-docker smoke (manual)

The end-to-end proof that the pipeline is docker-free. With **no docker on
PATH** (e.g. `alias docker=false`):

1. `appliance vm up` — boots the managed VM; the api-server guest binary
   rides the boot media (no image pull), and the CLI mints an API key from
   the VM's bootstrap token into the `local` profile.
2. `cd examples/demo-stack-3tier && appliance deploy` — a bare deploy in a
   stack folder fans out to all members; each uploads a source zip via
   `PUT /api/v1/builds/:id/content?token=…` and is built server-side by the
   in-VM BuildKit.
3. `curl http://demo-frontend-dev.appliance.localhost:8081/` — the frontend
   answers through the VM's ingress.

PASS: all three members deploy and the curl returns the page without docker,
buildctl, or crane ever running on the host. (See also
`docs/live-test-runbook.md` §0.5.)

---

## Manual CLI Test Flows

### Prerequisites

```bash
# Build all packages
npm run build

# Set up CLI for local development
npm run dev:setup
```

### Flow 1: First-time Setup (Bootstrap)

1. Start the API server:

   ```bash
   BOOTSTRAP_TOKEN=my-secret-token \
   APPLIANCE_BASE_CONFIG='{"name":"local","type":"appliance-base-aws-public","stateBackendUrl":"s3://bucket/state","aws":{"region":"us-east-1","zoneId":"Z123","dataBucketName":"my-data-bucket"}}' \
   npm run --workspace=packages/api-server start:dev
   ```

2. Run the login flow:

   ```bash
   appliance login
   ```

3. Expected prompts:

   - **API URL**: Enter `http://localhost:3000` (default)
   - **Authentication method**: Select `Bootstrap (create new API key)`
   - **Bootstrap token**: Enter `my-secret-token`
   - **API key name**: Enter a name (default: `cli`)

4. Verify:
   - Should print `API key created: ak_...`
   - Should print `Credentials saved. You are now logged in.`
   - Check `~/.appliance/credentials.json` exists with correct permissions (`600`)

### Flow 2: Configure an Appliance

1. Navigate to an application directory or create a test one:

   ```bash
   mkdir /tmp/test-app && cd /tmp/test-app
   ```

2. Run configure:

   ```bash
   appliance configure
   ```

3. Expected prompts:

   - **Name**: Enter an appliance name or accept the random slug
   - **Type**: Select `framework` or `container`
   - If framework: select framework (auto/node/python)
   - If container: enter port number
   - Review JSON diff
   - **Save changes?**: Confirm

4. Verify:
   - `appliance.json` is created with the configured values
   - Re-running `appliance configure` loads existing values as defaults

### Flow 3: Existing API Key Login

1. With a running API server that has been bootstrapped:

   ```bash
   appliance login
   ```

2. Expected prompts:

   - **API URL**: Enter `http://localhost:3000`
   - **Authentication method**: Select `Existing API key`
   - **API key ID**: Enter `ak_...` (from a previous bootstrap)
   - **API key secret**: Enter `sk_...`

3. Verify:
   - Should print `Credentials saved. You are now logged in.`
   - Credentials file updated

### Flow 4: Version Check

```bash
appliance --version
```

Should output: `1.17.0`

---

## Manual API Test Flows (curl)

### Bootstrap

```bash
# Check initialization status
curl http://localhost:3000/bootstrap/status

# Create first API key
curl -X POST http://localhost:3000/bootstrap/create-key \
  -H "Content-Type: application/json" \
  -H "x-bootstrap-token: my-secret-token" \
  -d '{"name": "test-key"}'
```

### Authenticated requests

Authenticated requests require HTTP message signing. Use the SDK client or the E2E tests as reference. The signing process:

1. Compute `content-digest` header (SHA-256 of body, if present)
2. Sign `@method`, `@path`, `@authority` (and `content-type`, `content-digest` if body)
3. Add `signature` and `signature-input` headers

---

## Writing New Tests

### Service tests pattern

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock storage with Map-based in-memory store
const mockStore = new Map<string, string>();

vi.mock('./storage.service', () => ({
  getStorageService: () => ({
    get: async (_c: string, id: string) => {
      const val = mockStore.get(`${_c}/${id}.json`);
      return val ? JSON.parse(val) : null;
    },
    // ... other methods
  }),
}));

import { myService } from './my.service';
```

### Route tests pattern

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

// Use vi.hoisted() for mock objects referenced in vi.mock()
const mockService = vi.hoisted(() => ({
  create: vi.fn(),
  get: vi.fn(),
}));

vi.mock('../../services/my.service', () => ({
  myService: mockService,
}));

import { myRoutes } from './index';
```

### Key patterns

- **`vi.hoisted()`**: Required when mock variables are referenced inside `vi.mock()` factories (hoisting issue)
- **`vi.resetAllMocks()`**: Call in `beforeEach` to reset mock state between tests
- **Supertest**: Use `request(app).get/post/delete(path)` for HTTP testing
- **Storage mocking**: All services use `getStorageService()` singleton -- mock this module
