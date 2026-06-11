# appliance-vm

Appliance's microVM manager: one Rust executable that boots and
manages isolated Linux microVMs for running workloads — the engine
behind the next-generation local runtime. See `docs/microvm.md` at the
repo root for the architecture.

## Backends

| Platform | Backend                                      | Status                         |
| -------- | -------------------------------------------- | ------------------------------ |
| macOS    | Virtualization.framework (in-process, objc2) | boots                          |
| Linux    | KVM                                          | scaffold (reports unavailable) |
| Windows  | WSL2                                         | scaffold (reports unavailable) |

## Build & run (macOS)

Creating VMs is entitlement-gated; sign after building:

```bash
cargo build && ./scripts/sign-dev.sh
./target/debug/appliance-vm doctor      # backend availability
./target/debug/appliance-vm start       # create-on-demand + boot
./target/debug/appliance-vm console -f  # follow the boot log
./target/debug/appliance-vm status
./target/debug/appliance-vm stop
./target/debug/appliance-vm delete
```

State lives under `~/.appliance/vm/<name>/` (definition, sparse data
disk, console log, pidfile); guest kernel/initramfs pairs are cached
under `~/.appliance/vm/images/<image>/` and unwrapped from EFI zboot
packaging automatically.

## The full Appliance flow

`appliance vm up` (in the main CLI) wraps this binary and layers the
control plane on top: in-VM image registry, api-server bootstrap, and
the `microvm` credentials profile. After that:

```bash
appliance vm up
appliance deploy <project> <env> --profile microvm
# → http://<project>-<env>.appliance.localhost:8081, served from the VM
```

## Connect & shell

```bash
appliance vm exec <pod> [cmd...]   # run in a workload pod (default: /bin/sh)
appliance vm shell [cmd...]        # root shell in the VM itself (kubectl debug node + chroot)
appliance vm kubeconfig            # path for `export KUBECONFIG=$(...)`
```

The desktop surfaces the same thing: a **Shell** button on running pods
in the Runtimes page opens an xterm terminal over a real PTY.

## Egress control (outbound traffic)

The VM routes workload egress through a proxy Appliance runs and the
desktop controls (Docker-sandbox style). The proxy starts with the VM;
a peer guard keeps it reachable by the guest but never an open LAN
proxy. See `docs/microvm.md` for the architecture.

```bash
appliance vm egress policy          # show the current policy
appliance vm egress default deny    # default-deny; then allowlist:
appliance vm egress allow github.com
appliance vm egress deny  gist.github.com   # deny wins over allow
appliance vm egress mitm on         # intercept TLS (decrypt) on allowed HTTPS
appliance vm egress gateway         # HTTPS_PROXY + CA values for workloads
appliance vm egress reset           # back to permissive default
```

With `mitm on`, workloads must trust the per-VM CA
(`~/.appliance/vm/<name>/egress-ca.pem`); the proxy then mints a leaf
per host on the fly and sees the decrypted request.
