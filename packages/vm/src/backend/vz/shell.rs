//! vsock shell relay: bridges a per-VM Unix socket to a fresh guest
//! vsock connection — the socat PTY agent the guest runs — so
//! `appliance-vm shell` gets an interactive shell with no SSH, no TCP
//! exposure, and no dependency on k3s being up. VZ-specific: it drives
//! the live VM's `VZVirtioSocketDevice` on the VM's dispatch queue.

use super::{error_text, QueueBound};
use crate::guest::SHELL_VSOCK_PORT;
use block2::RcBlock;
use dispatch2::{DispatchQueue, DispatchRetained};
use objc2::rc::Retained;
use objc2_foundation::NSError;
use objc2_virtualization::{VZVirtioSocketConnection, VZVirtioSocketDevice, VZVirtualMachine};
use std::io::Write;
use std::net::Shutdown;
use std::os::fd::{AsRawFd, FromRawFd, RawFd};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::sync::mpsc;
use std::time::Duration;

/// Serve the per-VM Unix socket that bridges to guest vsock shells, for
/// the lifetime of the running VM. Detached; any failure is logged, not
/// fatal — the VM (and every other channel) keeps running.
pub fn spawn_relay(
    queue: &DispatchRetained<DispatchQueue>,
    vm: &Retained<VZVirtualMachine>,
    sock_path: PathBuf,
) {
    let queue = queue.clone();
    let vm = QueueBound(vm.clone());
    std::thread::spawn(move || {
        let _ = std::fs::remove_file(&sock_path);
        let listener = match UnixListener::bind(&sock_path) {
            Ok(l) => l,
            Err(e) => {
                eprintln!("shell relay: bind {}: {e}", sock_path.display());
                return;
            }
        };
        // Owner-only: this socket is a direct line to a root shell.
        let _ = std::fs::set_permissions(&sock_path, std::fs::Permissions::from_mode(0o600));
        for stream in listener.incoming() {
            let Ok(stream) = stream else { continue };
            match connect_vsock(&queue, &vm) {
                Ok(fd) => spawn_session(stream, fd),
                Err(e) => {
                    let _ = (&stream).write_all(format!("appliance shell: {e}\r\n").as_bytes());
                }
            }
        }
    });
}

/// Open a fresh vsock connection to the guest shell port and hand back a
/// dup'd, independently-owned fd. The connect rides the VM's dispatch
/// queue (Virtualization.framework requires it); the completion fires
/// asynchronously, so we block on a channel for it.
fn connect_vsock(
    queue: &DispatchRetained<DispatchQueue>,
    vm: &QueueBound<Retained<VZVirtualMachine>>,
) -> Result<RawFd, String> {
    let (tx, rx) = mpsc::channel::<Result<RawFd, String>>();
    let vm = QueueBound(vm.0.clone());
    queue.exec_sync(move || {
        let vm = vm;
        let Some(device) = (unsafe { vm.0.socketDevices() }).firstObject() else {
            let _ = tx.send(Err("VM has no vsock device".into()));
            return;
        };
        let device = match device.downcast::<VZVirtioSocketDevice>() {
            Ok(d) => d,
            Err(_) => {
                let _ = tx.send(Err("vsock device is not virtio".into()));
                return;
            }
        };
        let tx = tx.clone();
        let handler = RcBlock::new(
            move |conn: *mut VZVirtioSocketConnection, err: *mut NSError| {
                if !err.is_null() {
                    let _ = tx.send(Err(error_text(unsafe { &*err })));
                    return;
                }
                if conn.is_null() {
                    let _ = tx.send(Err("guest is not listening on the shell port".into()));
                    return;
                }
                // dup so the fd outlives the framework releasing the
                // VZVirtioSocketConnection once this handler returns.
                let dup = unsafe { libc::dup((*conn).fileDescriptor()) };
                let _ = tx.send(if dup < 0 {
                    Err("dup vsock fd failed".into())
                } else {
                    Ok(dup)
                });
            },
        );
        unsafe { device.connectToPort_completionHandler(SHELL_VSOCK_PORT, &handler) };
    });
    rx.recv_timeout(Duration::from_secs(10))
        .map_err(|_| "vsock connect timed out (is the guest shell agent up?)".to_string())?
}

/// Pump bytes both ways between the client's Unix socket and the guest
/// vsock fd until either side closes, on two detached threads. EOF in
/// each direction is forwarded as a half-close so the peer's shell sees
/// it and exits cleanly.
fn spawn_session(stream: UnixStream, vsock_fd: RawFd) {
    let vsock_out = unsafe { std::fs::File::from_raw_fd(vsock_fd) };
    let (Ok(vsock_in), Ok(stream_in)) = (vsock_out.try_clone(), stream.try_clone()) else {
        return;
    };
    // client -> guest
    std::thread::spawn(move || {
        let mut r = stream_in;
        let mut w = vsock_out;
        let _ = std::io::copy(&mut r, &mut w);
        unsafe { libc::shutdown(w.as_raw_fd(), libc::SHUT_WR) };
    });
    // guest -> client
    std::thread::spawn(move || {
        let mut r = vsock_in;
        let mut w = stream;
        let _ = std::io::copy(&mut r, &mut w);
        let _ = w.shutdown(Shutdown::Write);
    });
}
