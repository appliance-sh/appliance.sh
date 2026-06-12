mod backend;
mod egress;
mod guest;
mod images;
mod mitm;
mod net;
mod spec;
mod store;

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
    /// Create (or update) a VM definition and its data disk.
    Create {
        #[arg(default_value = DEFAULT_VM)]
        name: String,
        #[arg(long, default_value_t = 2)]
        cpus: usize,
        #[arg(long, default_value_t = 2048)]
        memory: u64,
        #[arg(long, default_value_t = 10)]
        disk: u64,
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
        } => {
            let spec = VmSpec {
                cpus,
                memory_mib: memory,
                disk_gib: disk,
                ..VmSpec::defaults(&name)
            };
            store::save_spec(&spec)?;
            store::ensure_disk(&spec)?;
            images::ensure_image(&spec.image)?;
            println!("created VM '{name}' ({cpus} cpus, {memory} MiB, {disk} GiB disk)");
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

        Cmd::Up { name, timeout } => {
            backend.availability()?;
            let spec = ensure_spec(&name)?;
            let paths = VmPaths::for_name(&name);
            if store::read_live_pid(&name).is_none() {
                // Clear stale readiness markers from a previous boot
                // *before* spawning — the poll below must only ever
                // observe files written by this boot.
                let _ = std::fs::remove_file(paths.kubeconfig());
                let _ = std::fs::remove_file(paths.guest_ip());
                let child = spawn_host_process(&name)?;
                println!("starting VM '{name}' (host pid {})", child.id());
            }

            // The resident host process writes guest-ip then
            // kubeconfig.yaml as the guest comes up — poll those, then
            // confirm the forwarded API endpoint actually answers.
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(timeout);
            print!("waiting for kubernetes endpoint");
            std::io::Write::flush(&mut std::io::stdout())?;
            // The spawned host process needs a beat to write its
            // pidfile — only treat "no live pid" as fatal after the
            // grace period, or `up` races its own child.
            let liveness_grace = std::time::Instant::now() + std::time::Duration::from_secs(10);
            loop {
                if paths.kubeconfig().exists() {
                    break;
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
                    bail!(
                        "timed out waiting for the kubeconfig. Host log tail:\n{}\n(boot log: `appliance-vm console {name}`)",
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
            let egress_addr =
                SocketAddr::from(([0, 0, 0, 0], egress::DEFAULT_EGRESS_PORT));
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
            let exists = store::load_spec(&name)?.is_some();
            let pid = store::read_live_pid(&name);
            let status = VmStatus {
                name: name.clone(),
                exists,
                running: pid.is_some(),
                pid,
                backend: backend.name(),
                message: backend.availability().err().map(|e| format!("{e:#}")),
            };
            println!("{}", serde_json::to_string_pretty(&status)?);
            Ok(())
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
    }
}

fn run_egress(action: EgressCmd) -> Result<()> {
    match action {
        EgressCmd::Proxy { name, addr, log } => {
            let addr: SocketAddr = match addr {
                Some(a) => a.parse().with_context(|| format!("invalid --addr '{a}'"))?,
                None => SocketAddr::from(([127, 0, 0, 1], egress::DEFAULT_EGRESS_PORT)),
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
            let url = egress::guest_proxy_url(&name, egress::DEFAULT_EGRESS_PORT);
            println!("HTTPS_PROXY={url}");
            println!("HTTP_PROXY={url}");
            if policy.mitm {
                println!("CA={}", mitm::ca_cert_path(&name).display());
            } else {
                println!("# TLS interception is off — workloads need no CA (blind tunnel).");
            }
            println!(
                "# The egress proxy starts automatically with the VM. To run it standalone: appliance-vm egress proxy {name} --addr 0.0.0.0:{}",
                egress::DEFAULT_EGRESS_PORT
            );
            Ok(())
        }
        EgressCmd::Sync { name } => {
            egress::publish_configmap(&name)?;
            println!("egress policy published to the cluster for '{name}'");
            Ok(())
        }
    }
}

fn ensure_spec(name: &str) -> Result<VmSpec> {
    if let Some(spec) = store::load_spec(name)? {
        return Ok(spec);
    }
    let spec = VmSpec::defaults(name);
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
