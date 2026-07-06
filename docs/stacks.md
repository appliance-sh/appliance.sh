# Stacks: collections of appliances

**Status:** Implemented (`appliance stack init|deploy|status|destroy`).

## Premise

The unit of work everywhere else in Appliance is one app rooted at one
directory. That's right for production ownership, but local testing,
demos, and prototyping want a _set_: "bring up all four demos",
"stand up the same fixture fleet in the cloud". Before stacks that was
N `cd` + `appliance deploy` ceremonies and no combined view.

A **stack** is a client-side collection manifest, `appliance.stack.json`,
naming member appliance directories. It never crosses the API: each
member still becomes an ordinary Project + Environment on whichever
api-server the active profile points at. That is precisely what makes a
stack portable — the same file drives the local microVM runtime and a
cloud installation, switched by `--profile` / `APPLIANCE_PROFILE`.

## File format

Schema: `stackInput` in `packages/sdk/src/models/stack.ts` (shared
contract; loading/resolution in `packages/cli/src/utils/stack.ts`).

```jsonc
{
  "manifest": "v1",
  "type": "stack",
  "name": "demos", // dnsName
  "environment": "dev", // optional default for every member
  "apps": [
    { "dir": "demo-node-framework" }, // project = manifest name
    { "dir": "api", "project": "api-server" }, // explicit project pin
    { "dir": "worker", "environment": "staging" }, // per-app env pin
  ],
}
```

- `dir` is relative to the stack file.
- `project` defaults to the member manifest's `name` (evaluated in the
  member directory, same trust rules as `appliance deploy` there).
- Environment precedence per app: **CLI argument > `app.environment` >
  `stack.environment` > `dev`**. The CLI argument deliberately beats
  per-app pins so `appliance stack deploy demo2` clones the whole
  collection into a fresh environment — the "identical set" move.
- Two entries resolving to the same project + environment are rejected
  at load time (they would stomp each other's deploys).

## Execution semantics

- **deploy** runs members **sequentially in file order** (later members
  may depend on earlier ones), driving the same engine as `appliance
deploy` (`utils/deploy-core.ts` `runDeploy`) with cwd switched into
  each member — manifest detection, `.env.<env>` lookup, docker build
  context, and `link.json` writes behave exactly as a hand-run deploy
  in that folder. Fail-fast: the first failure stops the run; the
  summary table shows what deployed, what failed, and what was never
  attempted. Non-interactive by construction (targets are fully
  resolved up front), so it's CI-safe.
- **status** is read-only: per member, find the project/environment and
  print status + URL (falling back to a deployment scan for
  environments predating `env.url`).
- **destroy** confirms **once** for the whole set (non-TTY requires
  `--yes`, mirroring `appliance destroy`), then proceeds best-effort:
  missing projects/environments are skipped, one wedged environment
  doesn't strand the rest, and any failure exits non-zero.
- **init** scaffolds the file by scanning immediate subdirectories for
  appliance manifests (`MANIFEST_FILENAMES` in `utils/common.ts`).

## Wiring members together

A stack entry may declare deploy-time env (`env` on `stackAppInput`)
whose values reference sibling members by `dir`:

```jsonc
{
  "apps": [{ "dir": "api" }, { "dir": "web", "env": { "API_URL": "{{service:api}}" } }],
}
```

- `{{service:<dir>}}` → `http://<project>-<environment>:<port>`, the
  member's in-network address. Deterministic (no deploy-order
  dependency): the docker base serves it via a shared-network DNS alias
  (`DockerDeploymentService`), Kubernetes bases via the Service name —
  the same value works on both.
- `{{url:<dir>}}` → the member's host-facing URL from its deploy this
  run; requires the member to appear **earlier in `apps`** (members
  deploy in file order). For values that end up in a browser.

Interpolation happens per deploy (`resolveStackAppEnv` in
`utils/stack.ts`), so `stack deploy demo2` rewires the clone with no
file edits. Precedence: manifest `env` < stack `env` < `.env.<env>`
file in the member directory. A bad reference fails that member's
deploy with the known dirs listed. `examples/demo-stack-3tier` is the
living demo (frontend → bff → backend).

## Relation to `appliance up` compose services

`docs/up.md` §5 models N _services inside one project_ (a compose file)
promotable to a single Environment. A stack is the layer above: N
_projects_, each its own Environment. The two compose: a stack member
can itself be a compose project once the multi-service promotion path
lands (`docs/cloud-promotion-contract.md`).

## Scaling members

Kubernetes-based targets honor a `replicas` field in each member's
manifest runtime config (`applianceRuntimeConfig`, forwarded on the
deploy payload; rendered by `LocalContainerDeploymentService`). Omitted
→ redeploys preserve the environment's live scale. Lambda bases ignore
it.
