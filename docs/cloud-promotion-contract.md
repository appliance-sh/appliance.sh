# Cloud Promotion Contract: Multi-Service / Compose Mapping

**Status:** Decision (SPIKE). No implementation. Informs the `appliance up` local-sandbox UX so it stays cloud-promotable.

## Background: today's contract is one appliance per environment

The data plane is a strict chain: `Project` → `Environment` → `Deployment` → `Build` → one infra unit.

- An `Environment` carries exactly one `stackName` and one `url` (`packages/sdk/src/models/environment.ts:24-41`). The URL is a property _of the environment_, set per successful deploy.
- A `Deployment` references one optional `buildId` (`deployment.ts:25-53`).
- A `Build` is one artifact: `upload` (one zip + one `appliance.json`) or `remote-image` (one URI + one `port`) (`build.ts:25-72`).
- The `Appliance` manifest is a single discriminated-union value, not a list (`appliance.ts:112-120`).
- The executor resolves one build and produces one infra unit — on k8s, one Deployment + Service + Ingress at `<stackName>.<hostnameSuffix>` (`deployment-executor.service.ts:257-377`; `ARCHITECTURE.md:193-221`; `build.service.ts:65-83`).

Nothing in the SDK or routes models a relationship _between_ services.

## 1. Mapping: N appliances in one environment — RECOMMEND (a)

A compose project becomes **N appliances deployed into one Environment**, where the Environment is the unit of co-location, shared env scope, and lifecycle.

**Rationale.** The Environment already owns the things compose services must share: a namespace/stackName prefix, stored env vars (`env-var.service`), DNS suffix, and lifecycle gating (`EnvironmentBusyError`). A compose "project" _is_ an environment of co-deployed services. This requires no new top-level abstraction and preserves the existing `Project`/`Environment` semantics the CLI, desktop, and link.json all depend on.

**Rejected (b) multi-service manifest type:** a `type: 'compose'` appliance would smuggle N workloads behind one Build/Deployment/URL, breaking per-service builds, per-service scaling, and per-service URLs — the executor and k8s mapping are 1:1 with a workload. **Rejected (c) new project/stack abstraction above environment:** maximal disruption (every route, the CLI link model, the desktop) for a grouping the Environment already provides. Reserve "stack-above-environment" only if multi-environment topologies (staging+prod as one unit) ever arise — orthogonal to compose.

## 2. Builds: one Build per service, grouped by a buildSet — RECOMMEND

Keep `Build` as the per-service unit (it maps 1:1 to an image/artifact and a port). Generalize the _deploy_ to reference many builds. Introduce a lightweight **build set**: a deploy carries `services: [{ name, buildId }]` instead of a single `buildId`. Each service still goes through the unchanged `upload`/`remote-image` flow and `BuildService.resolve` per build.

**Rationale.** Builds stay atomic and cacheable; only the deploy fans out. No change to `POST /api/v1/builds`. Rejected: a "composite build" artifact (one zip containing N images) — defeats per-service caching, rebuild-one-service, and the existing port-on-build-record mechanism.

## 3. Deployments & URLs: one Deployment fans out; per-service URL map — RECOMMEND

A multi-service deploy stays **one Deployment** (one transactional unit, one busy-lock on the environment), but its result reports a **per-service URL map** rather than a single string. On k8s this is N Deployment+Service+Ingress trios at `<service>.<stackName>.<hostnameSuffix>`; on AWS, N Lambdas behind per-service routes.

**Rationale.** The environment's single `url` becomes a `urls: Record<service, url>` (keep `url` as a back-compat alias to the primary/ingress service). One Deployment preserves atomic rollout and the existing cancel/refresh machinery. Rejected: one Deployment per service — loses atomicity and races on the shared stack.

## 4. Minimal SDK model shapes (LATER, sketches only)

```
// deployment.ts — replace single buildId with a service list (buildId stays for single-service back-compat)
services: z.array(z.object({
  name: dnsName,          // service name, DNS-safe; also the subdomain label
  buildId: z.string(),
  port: portInput.optional(),
  exposed: z.boolean().optional().default(true), // false => internal-only (db, cache)
  dependsOn: z.array(dnsName).optional(),         // ordering hint
})).optional()

// environment.ts — generalize the reported address
urls: z.record(dnsName, z.string()).optional()   // service name -> url; `url` kept as primary alias
```

`Project`, `Build`, and `Appliance` need **no shape change**. The discriminated union stays per-service; a compose project is just multiple `applianceInput` values.

## 5. Compatibility checklist — constraints `appliance up` MUST honor now

To keep the chosen mapping (a)+per-service-build reachable, the local-sandbox spike must model compose projects so they translate 1:1 later:

1. **Model each compose service as its own workload with a DNS-safe name** (`dnsName`, `appliance.ts`). Use the compose service key as the canonical name; do not collapse services into one unit locally.
2. **Capture an explicit port per service** (and which are exposed vs. internal) — mirrors the per-build `port` that becomes the k8s Service target port (`build.ts:38-44`, `ARCHITECTURE.md:219`).
3. **Treat the compose project as one Environment, not one appliance.** Reuse the `<project>-<env>` stackName convention (`appliance-deploy.ts:61`); per-service identity is a label _under_ it, never a separate environment.
4. **Identify a compose project deterministically** (compose file dir/name) and persist project+env in `link.json` exactly as `appliance deploy` does — so promotion reuses the same target resolution.
5. **Keep one shared env scope per project** (compose `environment:`/`.env` → environment-level env vars), with per-service overrides layered on top — matches `env-var.service` + per-deploy override precedence.
6. **Do not assume a single public URL.** Surface a per-service URL/port map in `up` output now, so the UX doesn't bake in the single-`url` assumption the cloud side is dropping.
7. **Record inter-service dependencies/ordering** (compose `depends_on`) as data, even if local startup ignores it — it is the `dependsOn` hint cloud deploys will need.
8. **Keep each service independently buildable** (its own Dockerfile/context); never produce one fused artifact, preserving the one-Build-per-service model.
