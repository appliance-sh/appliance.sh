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
