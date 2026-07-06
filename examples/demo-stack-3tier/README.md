# demo-stack-3tier — frontend → bff → backend

A three-service stack showing how stack members find each other. The
browser talks to the **frontend**, which proxies API calls to the
**bff**, which aggregates data from the **backend** — two
service-to-service hops, wired entirely from the stack file:

```json
"apps": [
  { "dir": "backend" },
  { "dir": "bff", "env": { "BACKEND_URL": "{{service:backend}}" } },
  { "dir": "frontend", "env": { "BFF_URL": "{{service:bff}}" } }
]
```

`{{service:<dir>}}` resolves to the member's in-network address,
`http://<project>-<environment>:<port>` — served by a docker network
alias on the local server and by the Service DNS name on Kubernetes
bases, so the same stack file works on both. `{{url:<dir>}}` resolves
to a member's host-facing URL (it must appear earlier in `apps`), for
values that end up in a browser.

Run it:

```bash
appliance server start           # or: appliance vm up
cd examples/demo-stack-3tier
appliance stack deploy --profile local
# open the frontend URL from the summary table

appliance stack deploy demo2 --profile local   # clone: wiring follows the environment
appliance stack destroy --yes --profile local  # tear down
```

Because references are interpolated per deploy, cloning the stack into
a fresh environment (`stack deploy demo2`) rewires every member with no
file edits.
