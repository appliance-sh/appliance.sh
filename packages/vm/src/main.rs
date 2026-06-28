mod backend;
mod bringup;
mod creds;
mod egress;
mod guest;
mod images;
mod mitm;
mod net;
mod shell;
mod spec;
mod store;
mod traffic;

use anyhow::{bail, Context, Result};
use clap::{Parser, Subcommand};
use spec::{VmPaths, VmSpec, VmStatus};
use std::io::Read;
use std::net::SocketAddr;
use std::process::Command;

/// Appliance microVM manager. One executable, one backend per
/// platform (Virtualization.framework / KVM / WSL2), one guest
/// contract. See docs/microvm.md in the repo for the architecture.
#[derive(Parser)]
#[command(name = "appliance-vm", version, about)]
struct Cli {
    #[command(subcommand)]
    command: Cmd,
}

const DEFAULT_VM: &str = "appliance";

#[derive(Subcommand)]
enum Cmd {
    /// Probe whether this machine can run microVMs.
    Doctor,
    /// List all defined VMs with their ports and running state (JSON).
    List,
    /// Create (or update) a VM definition and its data disk.
    Create {
        #[arg(default_value = DEFAULT_VM)]
        name: String,
        #[arg(long, default_value_t = spec::DEFAULT_CPUS)]
        cpus: usize,
        #[arg(long, default_value_t = spec::DEFAULT_MEMORY_MIB)]
        memory: u64,
        #[arg(long, default_value_t = spec::DEFAULT_DISK_GIB)]
        disk: u64,
        /// Provision this VM as a development environment (dev toolchain
        /// + persistent /persist/workspace you shell into).
        #[arg(long, default_value_t = false)]
        dev: bool,
        /// Share a host folder into the guest over VirtioFS, mounted at
        /// /persist/workspace (implies --dev).
        #[arg(long)]
        mount: Option<String>,
        /// Provision an in-guest Docker engine (dockerd) alongside k3s.
        #[arg(long, default_value_t = false)]
        docker: bool,
    },
    /// Start a VM in the background (creates it with defaults first if needed).
    Start {
        #[arg(default_value = DEFAULT_VM)]
        name: String,
    },
    /// Start the VM and wait until its Kubernetes endpoint is ready:
    /// kubeconfig fetched and the API answering on the forwarded port.
    Up {
        #[arg(default_value = DEFAULT_VM)]
        name: String,
        /// Seconds to wait for readiness before giving up.
        #[arg(long, default_value_t = 600)]
        timeout: u64,
        /// Virtual CPUs (persisted; defaults to the VM's current value,
        /// or 2 for a new VM). Takes effect on the next boot.
        #[arg(long)]
        cpus: Option<usize>,
        /// Guest memory in MiB (persisted; defaults to the VM's current
        /// value, or 4096 for a new VM). Takes effect on the next boot.
        #[arg(long)]
        memory: Option<u64>,
        /// Provision this VM as a development environment (persisted):
        /// installs a dev toolchain and a persistent /persist/workspace
        /// you shell into. Takes effect on the next boot; never silently
        /// turned back off.
        #[arg(long, default_value_t = false)]
        dev: bool,
        /// Share a host folder into the guest over VirtioFS, mounted at
        /// /persist/workspace ("edit on the host, run in the VM").
        /// Implies --dev. Persisted; applies on the next boot.
        #[arg(long)]
        mount: Option<String>,
        /// Stop sharing a previously-set host folder; the workspace
        /// reverts to the data disk on the next boot.
        #[arg(long, default_value_t = false)]
        no_mount: bool,
        /// Provision an in-guest Docker engine (dockerd) alongside k3s, so
        /// the VM can build and run containers / compose / devcontainers.
        /// Persisted; applies on the next boot; never silently turned off.
        #[arg(long, default_value_t = false)]
        docker: bool,
    },
    /// Host a VM in the foreground until it stops. Used internally by
    /// `start`; handy directly when debugging a guest boot.
    Run {
        #[arg(default_value = DEFAULT_VM)]
        name: String,
    },
    /// Gracefully stop a running VM.
    Stop {
        #[arg(default_value = DEFAULT_VM)]
        name: String,
    },
    /// Report VM state as JSON.
    Status {
        #[arg(default_value = DEFAULT_VM)]
        name: String,
    },
    /// Open an interactive shell in the guest over vsock (no SSH, no
    /// k3s) — or run a single command with `-- <cmd>`. Lands as the
    /// non-root `appliance` user; `--root` lands a root shell.
    Shell {
        #[arg(default_value = DEFAULT_VM)]
        name: String,
        /// Land a root shell instead of dropping to the `appliance` user.
        #[arg(long, default_value_t = false)]
        root: bool,
        /// Command to run instead of an interactive shell.
        #[arg(trailing_var_arg = true)]
        command: Vec<String>,
    },
    /// Print the VM's console log (boot log, kernel messages).
    Console {
        #[arg(default_value = DEFAULT_VM)]
        name: String,
        /// Follow the log as it grows.
        #[arg(long, short = 'f', default_value_t = false)]
        follow: bool,
    },
    /// Delete a VM definition, its disk, and logs.
    Delete {
        #[arg(default_value = DEFAULT_VM)]
        name: String,
    },
    /// Control the VM's outbound traffic (egress proxy + policy).
    Egress {
        #[command(subcommand)]
        action: EgressCmd,
    },
    /// Manage per-host credential capture/injection (apiKeyHelper).
    Creds {
        #[command(subcommand)]
        action: CredsCmd,
    },
}

#[derive(Subcommand)]
enum CredsCmd {
    /// Print credential rules + stored secrets (masked) as JSON.
    List {
        #[arg(default_value = DEFAULT_VM)]
        name: String,
    },
    /// Add or update a per-host credential rule.
    Add {
        /// Host suffix (e.g. api.openai.com).
        host: String,
        #[arg(long, default_value = DEFAULT_VM)]
        name: String,
        /// Capture the credential header off requests into the store.
        #[arg(long, default_value_t = false)]
        capture: bool,
        /// Inject the credential header onto outbound requests.
        #[arg(long, default_value_t = false)]
        inject: bool,
        /// Header to capture/inject (default: authorization).
        #[arg(long)]
        header: Option<String>,
        /// Command whose stdout is the credential to inject (apiKeyHelper).
        #[arg(long)]
        helper: Option<String>,
    },
    /// Remove a host's credential rule.
    Rm {
        host: String,
        #[arg(long, default_value = DEFAULT_VM)]
        name: String,
    },
    /// Manually store a secret for a host (e.g. paste an API key).
    Set {
        host: String,
        value: String,
        #[arg(long, default_value = DEFAULT_VM)]
        name: String,
        #[arg(long)]
        header: Option<String>,
    },
    /// Forget all stored secrets (rules are kept).
    Forget {
        #[arg(default_value = DEFAULT_VM)]
        name: String,
    },
}

#[derive(Subcommand)]
enum EgressCmd {
    /// Run the egress proxy in the foreground until killed.
    Proxy {
        #[arg(default_value = DEFAULT_VM)]
        name: String,
        /// Address to listen on (host:port).
        #[arg(long)]
        addr: Option<String>,
        /// Log every allow/deny decision to stderr.
        #[arg(long, default_value_t = false)]
        log: bool,
    },
    /// Print the VM's current egress policy as JSON.
    Policy {
        #[arg(default_value = DEFAULT_VM)]
        name: String,
    },
    /// Set the default action when no rule matches (allow | deny).
    Default {
        action: String,
        #[arg(long, default_value = DEFAULT_VM)]
        name: String,
    },
    /// Add an allow rule (host suffix, e.g. github.com).
    Allow {
        host: String,
        #[arg(long, default_value = DEFAULT_VM)]
        name: String,
    },
    /// Add a deny rule (host suffix). Deny wins over allow.
    Deny {
        host: String,
        #[arg(long, default_value = DEFAULT_VM)]
        name: String,
    },
    /// Clear all rules and reset to the permissive default.
    Reset {
        #[arg(default_value = DEFAULT_VM)]
        name: String,
    },
    /// Print the path to the VM's egress CA cert (generating it on
    /// first use). Inject this into the guest trust store to let the
    /// proxy intercept TLS.
    Ca {
        #[arg(default_value = DEFAULT_VM)]
        name: String,
    },
    /// Enable or disable TLS interception (MITM) on allowed HTTPS.
    Mitm {
        /// on | off
        state: String,
        #[arg(long, default_value = DEFAULT_VM)]
        name: String,
    },
    /// Print the proxy URL guest workloads should use (and the CA path
    /// when interception is on) — the values to inject as HTTPS_PROXY
    /// + trusted CA so the VM's egress flows through the proxy.
    Gateway {
        #[arg(default_value = DEFAULT_VM)]
        name: String,
    },
    /// Publish the current policy into the cluster (the api-server
    /// reads it to inject proxy + CA into workloads). Runs
    /// automatically after policy changes and on `vm up`.
    Sync {
        #[arg(default_value = DEFAULT_VM)]
        name: String,
    },
    /// Print recorded egress traffic (one JSON event per line / array)
    /// — the live feed the desktop traffic view consumes.
    Log {
        #[arg(default_value = DEFAULT_VM)]
        name: String,
        /// Maximum number of most-recent events to print.
        #[arg(long, default_value_t = 200)]
        tail: usize,
        /// Forget all recorded traffic instead of printing.
        #[arg(long, default_value_t = false)]
        clear: bool,
    },
}

fn main() {
    if let Err(err) = run() {
        eprintln!("error: {err:#}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let cli = Cli::parse();
    let backend = backend::platform_backend();

    match cli.command {
        Cmd::Doctor => {
            match backend.availability() {
                Ok(()) => println!("ok: backend '{}' is available", backend.name()),
                Err(err) => {
                    println!("unavailable: {err:#}");
                    std::process::exit(1);
                }
            }
            Ok(())
        }

        Cmd::Create {
            name,
            cpus,
            memory,
            disk,
            dev,
            mount,
            docker,
        } => {
            // A shared host folder only makes sense in a dev environment,
            // so --mount implies --dev.
            let dev_mount = match mount.as_deref() {
                Some(path) => Some(resolve_mount(path)?),
                None => None,
            };
            let dev = dev || dev_mount.is_some();
            // Allocate a non-colliding port block so this VM can run
            // alongside others (the default VM keeps the canonical
            // 8081/6443/5052/5053; an existing VM keeps its ports).
            let (host_port, api_port, registry_port, egress_port) = VmSpec::allocate_ports(&name);
            let spec = VmSpec {
                cpus,
                memory_mib: memory,
                disk_gib: disk,
                host_port,
                api_port,
                registry_port,
                egress_port,
                dev,
                dev_mount,
                docker,
                ..VmSpec::defaults(&name)
            };
            store::save_spec(&spec)?;
            store::ensure_disk(&spec)?;
            images::ensure_image(&spec.image)?;
            println!(
                "created VM '{name}' ({cpus} cpus, {memory} MiB, {disk} GiB disk{})",
                if dev { ", dev environment" } else { "" }
            );
            println!("  ingress :{host_port}  kubernetes :{api_port}  registry :{registry_port}  egress :{egress_port}");
            Ok(())
        }

        Cmd::Start { name } => {
            backend.availability()?;
            if let Some(pid) = store::read_live_pid(&name) {
                println!("VM '{name}' is already running (pid {pid})");
                return Ok(());
            }
            let spec = ensure_spec(&name)?;
            store::ensure_disk(&spec)?;
            images::ensure_image(&spec.image)?;

            // Re-exec ourselves detached to host the VM: the hypervisor
            // session lives inside a process, so something must stay
            // resident. Spawning the same binary keeps it to one
            // executable, and gives every backend identical daemon
            // semantics.
            let child = spawn_host_process(&name)?;
            println!("starting VM '{name}' (host pid {})", child.id());
            println!("console: appliance-vm console {name} -f");
            Ok(())
        }

        Cmd::Up {
            name,
            timeout,
            cpus,
            memory,
            dev,
            mount,
            no_mount,
            docker,
        } => {
            backend.availability()?;
            let mut spec = ensure_spec(&name)?;
            // Persist resource overrides into the spec *before* spawning
            // the host process — `run` reads sizing from disk, and a
            // persisted spec is what makes the new sizing survive a
            // restart. A running VM keeps its current sizing until the
            // next boot, so warn rather than silently mislead.
            let resized = spec.apply_resource_overrides(cpus, memory)?;
            // `--dev` is a one-way toggle: it promotes a VM to a dev
            // environment but its absence never demotes one, mirroring
            // the "None preserves" semantics of the resource overrides.
            let was_dev = spec.dev;
            if dev {
                spec.dev = true;
            }
            // `--docker` is a one-way toggle too: it provisions dockerd but
            // its absence never deprovisions, matching --dev's semantics.
            let was_docker = spec.docker;
            if docker {
                spec.docker = true;
            }
            // Mount override: --no-mount stops sharing; --mount sets or
            // replaces the shared host folder (and implies a dev env).
            let mount_changed = if no_mount {
                spec.dev_mount.take().is_some()
            } else if let Some(path) = mount.as_deref() {
                let abs = resolve_mount(path)?;
                let changed = spec.dev_mount.as_deref() != Some(abs.as_str());
                spec.dev_mount = Some(abs);
                spec.dev = true;
                changed
            } else {
                false
            };
            let dev_enabled = spec.dev && !was_dev;
            let docker_enabled = spec.docker && !was_docker;
            if resized || dev_enabled || mount_changed || docker_enabled {
                store::save_spec(&spec)?;
                if store::read_live_pid(&name).is_some() {
                    if resized {
                        println!(
                            "note: VM '{name}' is already running — new sizing ({} cpus, {} MiB) applies on its next boot",
                            spec.cpus, spec.memory_mib
                        );
                    }
                    if dev_enabled {
                        println!(
                            "note: VM '{name}' is already running — dev provisioning applies on its next boot"
                        );
                    }
                    if docker_enabled {
                        println!(
                            "note: VM '{name}' is already running — docker provisioning applies on its next boot"
                        );
                    }
                    if mount_changed {
                        println!(
                            "note: VM '{name}' is already running — the shared folder applies on its next boot"
                        );
                    }
                }
            }
            let paths = VmPaths::for_name(&name);
            if store::read_live_pid(&name).is_none() {
                // Clear stale readiness markers from a previous boot
                // *before* spawning — the poll below must only ever
                // observe files written by this boot.
                let _ = std::fs::remove_file(paths.kubeconfig());
                let _ = std::fs::remove_file(paths.guest_ip());
                bringup::clear(&paths.dir);
                let child = spawn_host_process(&name)?;
                println!("starting VM '{name}' (host pid {})", child.id());
            }

            // The resident host process publishes its bring-up phase as it
            // goes (boot media → booting → network → k3s → ready) and writes
            // kubeconfig.yaml once the cluster answers. Render the phases as
            // live progress, surface a failed stage immediately rather than
            // waiting out the timeout, and confirm the forwarded API endpoint.
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(timeout);
            println!("bringing up VM '{name}'…");
            // The spawned host process needs a beat to write its
            // pidfile — only treat "no live pid" as fatal after the
            // grace period, or `up` races its own child.
            let liveness_grace = std::time::Instant::now() + std::time::Duration::from_secs(10);
            let mut shown: Option<bringup::Phase> = None;
            loop {
                if paths.kubeconfig().exists() {
                    break;
                }
                // Reflect the current phase: a new stage starts a fresh
                // line; staying in one appends dots so progress is visible.
                if let Some(b) = bringup::read(&paths.dir) {
                    if shown != Some(b.phase) {
                        if shown.is_some() {
                            println!();
                        }
                        let detail = b
                            .detail
                            .as_deref()
                            .map(|d| format!(" ({d})"))
                            .unwrap_or_default();
                        print!("  {}{}", b.phase.label(), detail);
                        std::io::Write::flush(&mut std::io::stdout())?;
                        shown = Some(b.phase);
                    }
                    if b.phase == bringup::Phase::Failed {
                        println!();
                        bail!(
                            "VM bring-up failed: {}\n(boot log: `appliance-vm console {name}`)",
                            b.detail.as_deref().unwrap_or("see host log"),
                        );
                    }
                }
                if std::time::Instant::now() > liveness_grace && store::read_live_pid(&name).is_none() {
                    println!();
                    bail!(
                        "VM host process exited during startup:\n{}",
                        tail_of(&paths.host_log(), 8)
                    );
                }
                if std::time::Instant::now() >= deadline {
                    println!();
                    let stuck = shown.map(|p| p.label()).unwrap_or("starting up");
                    bail!(
                        "timed out after {timeout}s — still {stuck}.\nHost log tail:\n{}\n(boot log: `appliance-vm console {name}`)",
                        tail_of(&paths.host_log(), 8)
                    );
                }
                print!(".");
                std::io::Write::flush(&mut std::io::stdout())?;
                std::thread::sleep(std::time::Duration::from_secs(2));
            }
            println!();
            net::wait_tcp(
                std::net::SocketAddr::from(([127, 0, 0, 1], spec.api_port)),
                std::time::Duration::from_secs(60),
            )?;
            println!("VM '{name}' is up");
            println!("  kubeconfig:  {}", paths.kubeconfig().display());
            println!("  kubernetes:  https://127.0.0.1:{}", spec.api_port);
            println!("  ingress:     http://*.appliance.localhost:{}", spec.host_port);
            println!();
            println!("try: KUBECONFIG={} kubectl get nodes", paths.kubeconfig().display());
            Ok(())
        }

        Cmd::Run { name } => {
            backend.availability()?;
            let spec = ensure_spec(&name)?;
            store::ensure_disk(&spec)?;
            images::ensure_image(&spec.image)?;
            store::write_pidfile(&name)?;
            // Start the egress proxy alongside the VM so the desktop's
            // outbound-traffic policy takes effect without a separate
            // command. Bound where the guest can reach it (the peer
            // guard refuses anything off the VM subnet, so this is not
            // an open LAN proxy). Best-effort: a bind clash must not
            // stop the VM from booting.
            let egress_addr = SocketAddr::from(([0, 0, 0, 0], spec.egress_port));
            if let Err(e) = egress::spawn(&name, egress_addr, false) {
                eprintln!("warn: egress proxy not started ({e:#}); `appliance vm egress proxy` still works");
            }
            let result = backend.run_foreground(&spec);
            store::clear_pidfile(&name);
            result
        }

        Cmd::Stop { name } => {
            match store::read_live_pid(&name) {
                Some(pid) => {
                    // SIGTERM → the host process's signal handler asks the
                    // hypervisor for a guest stop, then exits.
                    let rc = unsafe { libc::kill(pid, libc::SIGTERM) };
                    if rc != 0 {
                        bail!("failed to signal pid {pid}");
                    }
                    println!("stop requested for VM '{name}' (pid {pid})");
                }
                None => println!("VM '{name}' is not running"),
            }
            Ok(())
        }

        Cmd::Status { name } => {
            let spec = store::load_spec(&name)?;
            let pid = store::read_live_pid(&name);
            let paths = VmPaths::for_name(&name);
            // Cluster readiness is gated on the host process being alive:
            // the kubeconfig file lingers on disk after a stop, so the
            // file alone would falsely report a stopped VM as "ready".
            let cluster_ready = pid.is_some() && paths.kubeconfig().exists();
            let phase = if pid.is_some() {
                bringup::read(&paths.dir).map(|b| b.phase)
            } else {
                None
            };
            let status = VmStatus {
                name: name.clone(),
                exists: spec.is_some(),
                running: pid.is_some(),
                pid,
                backend: backend.name(),
                cluster_ready,
                phase,
                message: backend.availability().err().map(|e| format!("{e:#}")),
                host_port: spec.as_ref().map(|s| s.host_port),
                api_port: spec.as_ref().map(|s| s.api_port),
                registry_port: spec.as_ref().map(|s| s.registry_port),
                egress_port: spec.as_ref().map(|s| s.egress_port),
                dev: spec.as_ref().map(|s| s.dev).unwrap_or(false),
            };
            println!("{}", serde_json::to_string_pretty(&status)?);
            Ok(())
        }

        Cmd::List => {
            #[derive(serde::Serialize)]
            #[serde(rename_all = "camelCase")]
            struct VmEntry {
                name: String,
                running: bool,
                /// Cluster answers (kubeconfig present) while running —
                /// lets the switcher show "starting" vs "ready" per VM.
                cluster_ready: bool,
                #[serde(skip_serializing_if = "Option::is_none")]
                phase: Option<bringup::Phase>,
                #[serde(skip_serializing_if = "Option::is_none")]
                pid: Option<i32>,
                host_port: u16,
                api_port: u16,
                registry_port: u16,
                egress_port: u16,
                dev: bool,
            }
            let entries: Vec<VmEntry> = store::list_specs()
                .into_iter()
                .map(|spec| {
                    let pid = store::read_live_pid(&spec.name);
                    let paths = VmPaths::for_name(&spec.name);
                    let cluster_ready = pid.is_some() && paths.kubeconfig().exists();
                    let phase = if pid.is_some() {
                        bringup::read(&paths.dir).map(|b| b.phase)
                    } else {
                        None
                    };
                    VmEntry {
                        running: pid.is_some(),
                        cluster_ready,
                        phase,
                        pid,
                        host_port: spec.host_port,
                        api_port: spec.api_port,
                        registry_port: spec.registry_port,
                        egress_port: spec.egress_port,
                        dev: spec.dev,
                        name: spec.name,
                    }
                })
                .collect();
            println!("{}", serde_json::to_string_pretty(&entries)?);
            Ok(())
        }

        Cmd::Shell { name, root, command } => {
            let cmd = (!command.is_empty()).then(|| command.join(" "));
            let code = shell::run_client(&name, cmd.as_deref(), root)?;
            std::process::exit(code);
        }

        Cmd::Console { name, follow } => {
            let paths = VmPaths::for_name(&name);
            let path = paths.console_log();
            if !path.exists() {
                bail!("no console log at {} — has the VM been started?", path.display());
            }
            let mut file = std::fs::File::open(&path)?;
            let mut buf = String::new();
            file.read_to_string(&mut buf)?;
            print!("{buf}");
            if follow {
                loop {
                    std::thread::sleep(std::time::Duration::from_millis(500));
                    let mut chunk = String::new();
                    file.read_to_string(&mut chunk)?;
                    if !chunk.is_empty() {
                        print!("{chunk}");
                        use std::io::Write;
                        std::io::stdout().flush().ok();
                    }
                }
            }
            Ok(())
        }

        Cmd::Delete { name } => {
            if let Some(pid) = store::read_live_pid(&name) {
                bail!("VM '{name}' is running (pid {pid}) — stop it first");
            }
            store::delete_vm_dir(&name)?;
            println!("deleted VM '{name}'");
            Ok(())
        }

        Cmd::Egress { action } => run_egress(action),

        Cmd::Creds { action } => run_creds(action),
    }
}

fn run_creds(action: CredsCmd) -> Result<()> {
    use creds::CredentialRule;
    match action {
        CredsCmd::List { name } => {
            #[derive(serde::Serialize)]
            struct Listing {
                rules: Vec<CredentialRule>,
                secrets: Vec<creds::StoredSecret>,
            }
            let listing = Listing {
                rules: creds::load_config(&name).rules,
                secrets: creds::list_secrets(&name),
            };
            println!("{}", serde_json::to_string_pretty(&listing)?);
            Ok(())
        }
        CredsCmd::Add { host, name, capture, inject, header, helper } => {
            let rule = CredentialRule {
                host: host.clone(),
                capture,
                inject,
                header: header.unwrap_or_else(|| "authorization".to_string()).to_ascii_lowercase(),
                helper,
            };
            creds::upsert_rule(&name, rule)?;
            println!("credential rule for '{host}' saved (capture={capture}, inject={inject})");
            Ok(())
        }
        CredsCmd::Rm { host, name } => {
            let removed = creds::remove_rule(&name, &host)?;
            println!(
                "{}",
                if removed {
                    format!("removed credential rule for '{host}'")
                } else {
                    format!("no credential rule for '{host}'")
                }
            );
            Ok(())
        }
        CredsCmd::Set { host, value, name, header } => {
            let header = header.unwrap_or_else(|| "authorization".to_string()).to_ascii_lowercase();
            creds::store_secret(&name, &host, &header, &value)?;
            println!("stored secret for '{host}' ({header})");
            Ok(())
        }
        CredsCmd::Forget { name } => {
            creds::forget_secrets(&name);
            println!("forgot all stored secrets for '{name}'");
            Ok(())
        }
    }
}

fn run_egress(action: EgressCmd) -> Result<()> {
    match action {
        EgressCmd::Proxy { name, addr, log } => {
            let addr: SocketAddr = match addr {
                Some(a) => a.parse().with_context(|| format!("invalid --addr '{a}'"))?,
                None => SocketAddr::from(([127, 0, 0, 1], egress::vm_egress_port(&name))),
            };
            egress::run_proxy(&name, addr, log)
        }
        EgressCmd::Policy { name } => {
            let policy = egress::load_policy(&name);
            println!("{}", serde_json::to_string_pretty(&policy)?);
            Ok(())
        }
        EgressCmd::Default { action, name } => {
            let parsed = match action.to_ascii_lowercase().as_str() {
                "allow" => egress::Action::Allow,
                "deny" => egress::Action::Deny,
                other => bail!("default action must be 'allow' or 'deny', got '{other}'"),
            };
            let mut policy = egress::load_policy(&name);
            policy.default = parsed;
            egress::save_policy(&name, &policy)?;
            let _ = egress::publish_configmap(&name);
            println!("egress default for '{name}' set to {:?}", parsed);
            Ok(())
        }
        EgressCmd::Allow { host, name } => {
            let mut policy = egress::load_policy(&name);
            if !policy.allow.iter().any(|h| h == &host) {
                policy.allow.push(host.clone());
            }
            policy.deny.retain(|h| h != &host);
            egress::save_policy(&name, &policy)?;
            let _ = egress::publish_configmap(&name);
            println!("egress: allow {host}");
            Ok(())
        }
        EgressCmd::Deny { host, name } => {
            let mut policy = egress::load_policy(&name);
            if !policy.deny.iter().any(|h| h == &host) {
                policy.deny.push(host.clone());
            }
            policy.allow.retain(|h| h != &host);
            egress::save_policy(&name, &policy)?;
            let _ = egress::publish_configmap(&name);
            println!("egress: deny {host}");
            Ok(())
        }
        EgressCmd::Reset { name } => {
            egress::save_policy(&name, &egress::EgressPolicy::default())?;
            let _ = egress::publish_configmap(&name);
            println!("egress policy for '{name}' reset (default allow, no rules)");
            Ok(())
        }
        EgressCmd::Ca { name } => {
            mitm::ensure_ca(&name)?;
            println!("{}", mitm::ca_cert_path(&name).display());
            Ok(())
        }
        EgressCmd::Mitm { state, name } => {
            let on = match state.to_ascii_lowercase().as_str() {
                "on" | "true" | "enable" | "enabled" => true,
                "off" | "false" | "disable" | "disabled" => false,
                other => bail!("mitm state must be 'on' or 'off', got '{other}'"),
            };
            if on {
                // Ensure the CA exists so the operator can fetch + trust
                // it before sending traffic through the interceptor.
                mitm::ensure_ca(&name)?;
            }
            let mut policy = egress::load_policy(&name);
            policy.mitm = on;
            egress::save_policy(&name, &policy)?;
            let _ = egress::publish_configmap(&name);
            println!("egress TLS interception for '{name}': {}", if on { "on" } else { "off" });
            if on {
                println!("CA: {}", mitm::ca_cert_path(&name).display());
            }
            Ok(())
        }
        EgressCmd::Gateway { name } => {
            let policy = egress::load_policy(&name);
            let port = egress::vm_egress_port(&name);
            let url = egress::guest_proxy_url(&name, port);
            println!("HTTPS_PROXY={url}");
            println!("HTTP_PROXY={url}");
            if policy.mitm {
                println!("CA={}", mitm::ca_cert_path(&name).display());
            } else {
                println!("# TLS interception is off — workloads need no CA (blind tunnel).");
            }
            println!(
                "# The egress proxy starts automatically with the VM. To run it standalone: appliance-vm egress proxy {name} --addr 0.0.0.0:{port}"
            );
            Ok(())
        }
        EgressCmd::Sync { name } => {
            egress::publish_configmap(&name)?;
            println!("egress policy published to the cluster for '{name}'");
            Ok(())
        }
        EgressCmd::Log { name, tail, clear } => {
            if clear {
                traffic::clear(&name);
                println!("egress traffic log cleared for '{name}'");
                return Ok(());
            }
            let events = traffic::tail(&name, tail);
            println!("{}", serde_json::to_string(&events)?);
            Ok(())
        }
    }
}

/// Canonicalize + validate a host path for `--mount`: it must exist and
/// be a directory. Returns the absolute path persisted into the spec —
/// the VirtioFS share needs a real, stable path, and resolving it
/// host-side fails fast with a clear message instead of a cryptic boot
/// error.
fn resolve_mount(path: &str) -> Result<String> {
    let abs = std::fs::canonicalize(path).with_context(|| format!("--mount path '{path}' not found"))?;
    if !abs.is_dir() {
        bail!("--mount path '{}' is not a directory", abs.display());
    }
    Ok(abs.to_string_lossy().into_owned())
}

fn ensure_spec(name: &str) -> Result<VmSpec> {
    if let Some(spec) = store::load_spec(name)? {
        return Ok(spec);
    }
    // A VM started without an explicit `create` still needs a
    // non-colliding port block so it can run beside existing VMs.
    let (host_port, api_port, registry_port, egress_port) = VmSpec::allocate_ports(name);
    let spec = VmSpec {
        host_port,
        api_port,
        registry_port,
        egress_port,
        ..VmSpec::defaults(name)
    };
    store::save_spec(&spec)?;
    Ok(spec)
}

/// Spawn the resident VM host process (this same binary, `run`),
/// detached, with its output captured in the per-VM host.log — a
/// silently discarded stderr turns every host-side failure (a proxy
/// port already taken, a lease that never appears) into an
/// undebuggable timeout.
fn spawn_host_process(name: &str) -> Result<std::process::Child> {
    let paths = VmPaths::for_name(name);
    std::fs::create_dir_all(&paths.dir)?;
    let log = std::fs::File::create(paths.host_log()).context("create host.log")?;
    let log_err = log.try_clone()?;
    let exe = std::env::current_exe().context("resolve current executable")?;
    Command::new(exe)
        .args(["run", name])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::from(log))
        .stderr(std::process::Stdio::from(log_err))
        .spawn()
        .context("spawn VM host process")
}

/// Last `n` lines of a log file, or a placeholder when unreadable.
fn tail_of(path: &std::path::Path, n: usize) -> String {
    match std::fs::read_to_string(path) {
        Ok(raw) => {
            let lines: Vec<&str> = raw.lines().collect();
            let start = lines.len().saturating_sub(n);
            lines[start..].join("\n")
        }
        Err(_) => format!("(no host log at {})", path.display()),
    }
}
