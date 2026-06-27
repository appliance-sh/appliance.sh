//! macOS backend: Virtualization.framework driven in-process via
//! objc2 bindings — the same foundation Docker Desktop / OrbStack
//! build on, without an external VM manager binary.
//!
//! Threading model: VZVirtualMachine demands that every operation
//! happen on the serial dispatch queue it was created with. We create
//! one queue per hosted VM, hop onto it with `exec_sync` for each
//! operation, and treat completion-handler blocks as channel sends
//! back to the hosting thread. `Retained<VZVirtualMachine>` is !Send
//! (correctly — it's queue-affine), so the small `QueueBound` wrapper
//! asserts the only kind of cross-thread movement we do: moving the
//! reference *onto its own queue*.
//!
//! Requires the `com.apple.security.virtualization` entitlement —
//! `scripts/sign-dev.sh` applies it ad-hoc for local builds.

mod shell;

use super::VmBackend;
use crate::spec::{VmPaths, VmSpec};
use anyhow::{anyhow, bail, Result};
use block2::RcBlock;
use dispatch2::{DispatchQueue, DispatchRetained};
use objc2::rc::Retained;
use objc2::AnyThread;
use objc2_foundation::{NSArray, NSError, NSString, NSURL};
use objc2_virtualization::{
    VZDirectorySharingDeviceConfiguration, VZDiskImageStorageDeviceAttachment, VZFileSerialPortAttachment,
    VZLinuxBootLoader, VZMACAddress, VZNATNetworkDeviceAttachment, VZNetworkDeviceConfiguration,
    VZSharedDirectory, VZSerialPortConfiguration, VZSingleDirectoryShare, VZSocketDeviceConfiguration,
    VZStorageDeviceConfiguration, VZVirtioBlockDeviceConfiguration,
    VZVirtioConsoleDeviceSerialPortConfiguration, VZVirtioEntropyDeviceConfiguration,
    VZVirtioFileSystemDeviceConfiguration, VZVirtioNetworkDeviceConfiguration,
    VZVirtioSocketDeviceConfiguration, VZVirtualMachine, VZVirtualMachineConfiguration,
    VZVirtualMachineState,
};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant};

pub struct VzBackend;

static STOP_REQUESTED: AtomicBool = AtomicBool::new(false);

extern "C" fn on_terminate(_sig: libc::c_int) {
    STOP_REQUESTED.store(true, Ordering::SeqCst);
}

/// Move a !Send objc reference across threads. Sound only because the
/// sole consumer is a closure executing on the VM's own dispatch
/// queue — the exact place Virtualization.framework requires the
/// reference to be used.
struct QueueBound<T>(T);
unsafe impl<T> Send for QueueBound<T> {}

impl VmBackend for VzBackend {
    fn name(&self) -> &'static str {
        "vz"
    }

    fn availability(&self) -> Result<()> {
        let supported = unsafe { VZVirtualMachine::isSupported() };
        if !supported {
            bail!("Virtualization.framework reports virtualization unsupported on this machine");
        }
        Ok(())
    }

    fn run_foreground(&self, spec: &VmSpec) -> Result<()> {
        self.availability()?;
        let paths = VmPaths::for_name(&spec.name);
        // First observable stage: any boot-media download happens here.
        // Clear any phase left by a previous boot before publishing ours.
        crate::bringup::clear(&paths.dir);
        crate::bringup::set(&paths.dir, crate::bringup::Phase::Media, None);
        let image = crate::images::ensure_image(&spec.image)?;
        eprintln!("assembling boot media");
        let boot_media = crate::guest::build_boot_media(
            &paths.dir,
            spec.registry_port,
            spec.dev,
            spec.dev_mount.is_some(),
            spec.docker,
            spec.egress_port,
        )?;

        // The console log is the VM's primary observable output —
        // truncate per boot so `console` shows the current boot, not
        // an append-forever scroll of every boot since creation.
        std::fs::write(paths.console_log(), b"")?;
        let _ = std::fs::remove_file(paths.kubeconfig());
        let _ = std::fs::remove_file(paths.guest_ip());

        let config =
            build_configuration(spec, &image.kernel, &image.initramfs, &boot_media.image, &paths)?;
        unsafe { config.validateWithError() }
            .map_err(|e| anyhow!("invalid VM configuration: {}", error_text(&e)))?;

        let queue = DispatchQueue::new(&format!("sh.appliance.vm.{}", spec.name), None);
        let vm = unsafe {
            VZVirtualMachine::initWithConfiguration_queue(VZVirtualMachine::alloc(), &config, &queue)
        };

        unsafe {
            libc::signal(libc::SIGTERM, on_terminate as *const () as usize);
            libc::signal(libc::SIGINT, on_terminate as *const () as usize);
        }

        start_vm(&queue, &vm)?;
        eprintln!("VM '{}' started", spec.name);
        // Guest is launching; host_services drives the rest of the phases.
        crate::bringup::set(&paths.dir, crate::bringup::Phase::Booting, None);

        // Serve the per-VM shell socket: each `appliance-vm shell`
        // connection bridges to a fresh guest vsock PTY. Best-effort and
        // independent of k3s.
        shell::spawn_relay(&queue, &vm, paths.shell_sock());

        // Guest-facing host services (IP discovery, port forwards,
        // kubeconfig handoff) run on a side thread so the parking loop
        // below stays the single owner of lifecycle decisions.
        {
            let spec = spec.clone();
            let paths_dir = paths.dir.clone();
            std::thread::spawn(move || {
                if let Err(err) = crate::guest::host_services(&spec, &paths_dir) {
                    eprintln!("host services: {err:#}");
                    // Record the failure so `up` can stop waiting and
                    // report what broke instead of timing out blind.
                    crate::bringup::set(
                        &paths_dir,
                        crate::bringup::Phase::Failed,
                        Some(format!("{err:#}")),
                    );
                }
            });
        }

        // Park until either the guest powers off on its own or a stop
        // is requested (SIGTERM from `appliance-vm stop`, or ^C).
        loop {
            std::thread::sleep(Duration::from_millis(200));
            let state = vm_state(&queue, &vm);
            if matches!(
                state,
                VZVirtualMachineState::Stopped | VZVirtualMachineState::Error
            ) {
                eprintln!("VM '{}' stopped (guest)", spec.name);
                return Ok(());
            }
            if STOP_REQUESTED.load(Ordering::SeqCst) {
                eprintln!("stop requested — shutting down VM '{}'", spec.name);
                return stop_vm(&queue, &vm);
            }
        }
    }
}

fn build_configuration(
    spec: &VmSpec,
    kernel: &Path,
    initramfs: &Path,
    boot_media: &Path,
    paths: &VmPaths,
) -> Result<Retained<VZVirtualMachineConfiguration>> {
    unsafe {
        let boot_loader =
            VZLinuxBootLoader::initWithKernelURL(VZLinuxBootLoader::alloc(), &file_url(kernel));
        boot_loader.setInitialRamdiskURL(Some(&file_url(initramfs)));
        boot_loader.setCommandLine(&NSString::from_str(&spec.cmdline));

        // Console: virtio console (hvc0) → file. Reading guest output
        // back is a follow-up (vsock agent); the boot log alone is the
        // debugging surface for a headless VM.
        let serial = VZVirtioConsoleDeviceSerialPortConfiguration::new();
        let attachment = VZFileSerialPortAttachment::initWithURL_append_error(
            VZFileSerialPortAttachment::alloc(),
            &file_url(&paths.console_log()),
            true,
        )
        .map_err(|e| anyhow!("console attachment: {}", error_text(&e)))?;
        serial.setAttachment(Some(&attachment));

        // Network: NAT through the host. DHCP inside the guest gets a
        // 192.168.64.0/24-style lease from the framework's own server.
        let net = VZVirtioNetworkDeviceConfiguration::new();
        let nat = VZNATNetworkDeviceAttachment::new();
        net.setAttachment(Some(&nat));
        // Fixed MAC: the host finds the guest's address by looking this
        // MAC up in macOS's DHCP lease table.
        let mac = VZMACAddress::initWithString(VZMACAddress::alloc(), &NSString::from_str(&spec.mac))
            .ok_or_else(|| anyhow!("invalid MAC address in spec: {}", spec.mac))?;
        net.setMACAddress(&mac);

        // Storage: the persistent data disk (sparse raw image).
        let disk_attachment = VZDiskImageStorageDeviceAttachment::initWithURL_readOnly_error(
            VZDiskImageStorageDeviceAttachment::alloc(),
            &file_url(&paths.disk()),
            false,
        )
        .map_err(|e| anyhow!("disk attachment: {}", error_text(&e)))?;
        let block_device = VZVirtioBlockDeviceConfiguration::initWithAttachment(
            VZVirtioBlockDeviceConfiguration::alloc(),
            &disk_attachment,
        );

        // Boot media (FAT volume with modloop + apkovl + k3s) as the
        // second disk (vdb). Read-only: it's regenerated host-side.
        let media_attachment = VZDiskImageStorageDeviceAttachment::initWithURL_readOnly_error(
            VZDiskImageStorageDeviceAttachment::alloc(),
            &file_url(boot_media),
            true,
        )
        .map_err(|e| anyhow!("boot media attachment: {}", error_text(&e)))?;
        let media_device = VZVirtioBlockDeviceConfiguration::initWithAttachment(
            VZVirtioBlockDeviceConfiguration::alloc(),
            &media_attachment,
        );

        let entropy = VZVirtioEntropyDeviceConfiguration::new();

        // virtio-vsock: the host↔guest control channel the shell agent
        // rides (no SSH, no TCP exposure). The resident process opens
        // connections to it on demand via `shell::spawn_relay`.
        let vsock = VZVirtioSocketDeviceConfiguration::new();

        let config = VZVirtualMachineConfiguration::new();
        config.setBootLoader(Some(&boot_loader));
        config.setCPUCount(spec.cpus);
        config.setMemorySize(spec.memory_mib * 1024 * 1024);
        config.setSerialPorts(&NSArray::from_retained_slice(&[Retained::into_super(
            serial,
        )
            as Retained<VZSerialPortConfiguration>]));
        config.setNetworkDevices(&NSArray::from_retained_slice(&[Retained::into_super(net)
            as Retained<VZNetworkDeviceConfiguration>]));
        config.setStorageDevices(&NSArray::from_retained_slice(&[
            Retained::into_super(block_device) as Retained<VZStorageDeviceConfiguration>,
            Retained::into_super(media_device) as Retained<VZStorageDeviceConfiguration>,
        ]));
        config.setEntropyDevices(&NSArray::from_retained_slice(&[Retained::into_super(
            entropy,
        )]));
        config.setSocketDevices(&NSArray::from_retained_slice(&[Retained::into_super(vsock)
            as Retained<VZSocketDeviceConfiguration>]));

        // Optional VirtioFS share: a host folder presented to the guest
        // under a fixed tag, which the bootstrap mounts at
        // /persist/workspace (dev bind-mount). Read-write — the whole
        // point is editing on the host and running in the VM.
        if let Some(mount) = spec.dev_mount.as_deref() {
            let shared = VZSharedDirectory::initWithURL_readOnly(
                VZSharedDirectory::alloc(),
                &file_url(Path::new(mount)),
                false,
            );
            let share =
                VZSingleDirectoryShare::initWithDirectory(VZSingleDirectoryShare::alloc(), &shared);
            let tag = NSString::from_str(crate::guest::WORKSPACE_VIRTIOFS_TAG);
            // The tag is a fixed short literal; validating it only guards
            // a future rename against the framework's <36-byte rule.
            VZVirtioFileSystemDeviceConfiguration::validateTag_error(&tag)
                .map_err(|e| anyhow!("invalid virtiofs tag: {}", error_text(&e)))?;
            let fs_device = VZVirtioFileSystemDeviceConfiguration::initWithTag(
                VZVirtioFileSystemDeviceConfiguration::alloc(),
                &tag,
            );
            fs_device.setShare(Some(&share));
            config.setDirectorySharingDevices(&NSArray::from_retained_slice(&[
                Retained::into_super(fs_device) as Retained<VZDirectorySharingDeviceConfiguration>,
            ]));
        }

        Ok(config)
    }
}

fn start_vm(queue: &DispatchRetained<DispatchQueue>, vm: &Retained<VZVirtualMachine>) -> Result<()> {
    let (tx, rx) = mpsc::channel::<Result<(), String>>();
    let bound = QueueBound(vm.clone());
    queue.exec_sync(move || {
        let vm = bound;
        let tx_done = tx.clone();
        let handler = RcBlock::new(move |err: *mut NSError| {
            let outcome = if err.is_null() {
                Ok(())
            } else {
                Err(error_text(unsafe { &*err }))
            };
            let _ = tx_done.send(outcome);
        });
        unsafe { vm.0.startWithCompletionHandler(&handler) };
    });
    match rx.recv_timeout(Duration::from_secs(60)) {
        Ok(Ok(())) => Ok(()),
        Ok(Err(message)) => bail!("VM start failed: {message}"),
        Err(_) => bail!("VM start timed out after 60s"),
    }
}

fn vm_state(
    queue: &DispatchRetained<DispatchQueue>,
    vm: &Retained<VZVirtualMachine>,
) -> VZVirtualMachineState {
    let (tx, rx) = mpsc::channel();
    let bound = QueueBound(vm.clone());
    queue.exec_sync(move || {
        // Capture the whole wrapper, not the projected field — edition
        // 2021's disjoint captures would otherwise grab the !Send
        // Retained directly and sidestep QueueBound.
        let vm = bound;
        let _ = tx.send(unsafe { vm.0.state() });
    });
    rx.recv().unwrap_or(VZVirtualMachineState::Error)
}

/// Graceful-then-forceful shutdown. `requestStop` asks the guest to
/// power down (it may not listen — our phase-1 initramfs has no ACPI
/// handling); after a short grace window we hard-stop, which is fine
/// for a guest whose persistent state is a journaled filesystem on
/// the data disk.
fn stop_vm(queue: &DispatchRetained<DispatchQueue>, vm: &Retained<VZVirtualMachine>) -> Result<()> {
    let bound = QueueBound(vm.clone());
    queue.exec_sync(move || {
        let vm = bound;
        unsafe {
            if vm.0.canRequestStop() {
                let _ = vm.0.requestStopWithError();
            }
        }
    });

    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        if vm_state(queue, vm) == VZVirtualMachineState::Stopped {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(200));
    }

    let (tx, rx) = mpsc::channel::<Result<(), String>>();
    let bound = QueueBound(vm.clone());
    queue.exec_sync(move || {
        let vm = bound;
        let tx_handler = tx.clone();
        let handler = RcBlock::new(move |err: *mut NSError| {
            let outcome = if err.is_null() {
                Ok(())
            } else {
                Err(error_text(unsafe { &*err }))
            };
            let _ = tx_handler.send(outcome);
        });
        unsafe {
            if vm.0.canStop() {
                vm.0.stopWithCompletionHandler(&handler);
            } else {
                let _ = tx.send(Ok(()));
            }
        }
    });
    match rx.recv_timeout(Duration::from_secs(15)) {
        Ok(Ok(())) => Ok(()),
        Ok(Err(message)) => bail!("VM stop failed: {message}"),
        Err(_) => bail!("VM stop timed out"),
    }
}

fn file_url(path: &Path) -> Retained<NSURL> {
    NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy()))
}

fn error_text(error: &NSError) -> String {
    error.localizedDescription().to_string()
}
