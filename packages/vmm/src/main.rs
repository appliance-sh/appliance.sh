mod backend;
mod images;
mod spec;
mod store;

use anyhow::{bail, Context, Result};
use clap::{Parser, Subcommand};
use spec::{VmPaths, VmSpec, VmStatus};
use std::io::Read;
use std::process::Command;

/// Appliance microVM manager. One executable, one backend per
/// platform (Virtualization.framework / KVM / WSL2), one guest
/// contract. See docs/microvm.md in the repo for the architecture.
#[derive(Parser)]
#[command(name = "appliance-vmm", version, about)]
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
            let exe = std::env::current_exe().context("resolve current executable")?;
            let child = Command::new(exe)
                .args(["run", &name])
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
                .context("spawn VM host process")?;
            println!("starting VM '{name}' (host pid {})", child.id());
            println!("console: appliance-vmm console {name} -f");
            Ok(())
        }

        Cmd::Run { name } => {
            backend.availability()?;
            let spec = ensure_spec(&name)?;
            store::ensure_disk(&spec)?;
            images::ensure_image(&spec.image)?;
            store::write_pidfile(&name)?;
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
