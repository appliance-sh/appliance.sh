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
use std::io::Read;
use std::path::PathBuf;
use std::sync::mpsc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

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

/// Push the host's wall-clock time into the guest, at bring-up and
/// periodically, over the same vsock shell channel.
///
/// The guest verifies signed-request timestamps against its own clock,
/// which lags the host (no NTP under the cooperative-egress model). A
/// host clock ahead of the guest's makes host-signed requests look
/// future-dated → opaque 401s. This thread is the host-authoritative
/// fix: the first successful push corrects the boot offset; the periodic
/// re-push corrects pause/resume jumps and keeps drift far under the
/// signature tolerance. Detached and best-effort — any failure is logged,
/// never fatal, exactly like `spawn_relay`.
pub fn spawn_clock_sync(
    queue: &DispatchRetained<DispatchQueue>,
    vm: &Retained<VZVirtualMachine>,
) {
    let queue = queue.clone();
    let vm = QueueBound(vm.clone());
    std::thread::spawn(move || loop {
        let fd = match connect_vsock(&queue, &vm) {
            Ok(fd) => fd,
            Err(_) => {
                // Guest shell agent not up yet (or transient): retry
                // soon so the first push lands as early as possible.
                std::thread::sleep(Duration::from_secs(2));
                continue;
            }
        };
        if let Err(e) = push_clock(fd) {
            eprintln!("clock sync: {e}");
            // Fall through to the long sleep: a failed push is rare and
            // the next iteration reconnects with a fresh time anyway.
        }
        // Re-push periodically: corrects pause/resume jumps and keeps
        // drift far below the signature tolerance (~15s).
        std::thread::sleep(Duration::from_secs(30));
    });
}

/// Send the clock-set command over a connected shell vsock fd, then drain
/// to EOF so the command actually runs before the connection closes.
/// Takes ownership of `fd` and closes it on return.
fn push_clock(fd: RawFd) -> Result<(), String> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "host clock is before the Unix epoch".to_string())?
        .as_secs();
    let cmd = clock_set_command(now);

    let mut sock = unsafe { std::fs::File::from_raw_fd(fd) };
    // The agent reads ONE leading `rows R cols C` line as the PTY size,
    // then exec's a login shell running whatever follows on stdin.
    sock.write_all(b"rows 24 cols 80\n")
        .map_err(|e| format!("write size: {e}"))?;
    sock.write_all(cmd.as_bytes())
        .map_err(|e| format!("write command: {e}"))?;
    sock.write_all(b"\nexit\n")
        .map_err(|e| format!("write exit: {e}"))?;
    // Half-close our write side so the guest shell sees EOF on stdin and
    // exits, then drain its output to EOF — i.e. wait for the command to
    // have run before we drop the fd.
    unsafe { libc::shutdown(sock.as_raw_fd(), libc::SHUT_WR) };
    let mut sink = Vec::new();
    sock.read_to_end(&mut sink)
        .map_err(|e| format!("drain: {e}"))?;
    Ok(())
}

/// Build the busybox-compatible command that sets the guest clock to the
/// given Unix epoch seconds. Tries the epoch form first; on the busybox
/// builds where `date -s @EPOCH` isn't honoured, falls back to a
/// `-D`-typed formatted UTC string built from the same instant. Both are
/// UTC (`-u`) so the guest's timezone never enters into it.
fn clock_set_command(epoch_secs: u64) -> String {
    let formatted = format_utc(epoch_secs);
    format!(
        "date -u -s @{epoch_secs} 2>/dev/null \
         || date -u -D '%Y-%m-%d %H:%M:%S' -s '{formatted}' 2>/dev/null \
         || true"
    )
}

/// Convert Unix epoch seconds to a `YYYY-MM-DD HH:MM:SS` UTC string, with
/// no dependency: a Howard Hinnant civil-from-days calculation for the
/// date plus plain modular arithmetic for the time of day.
fn format_utc(epoch_secs: u64) -> String {
    let days = (epoch_secs / 86_400) as i64;
    let secs_of_day = epoch_secs % 86_400;
    let (hour, min, sec) = (secs_of_day / 3600, (secs_of_day % 3600) / 60, secs_of_day % 60);
    let (year, month, day) = civil_from_days(days);
    format!("{year:04}-{month:02}-{day:02} {hour:02}:{min:02}:{sec:02}")
}

/// Days since 1970-01-01 → (year, month, day), proleptic Gregorian.
/// Howard Hinnant's `civil_from_days` algorithm (public domain).
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365; // [0, 399]
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32; // [1, 12]
    (if m <= 2 { y + 1 } else { y }, m, d)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_known_epochs_as_utc() {
        assert_eq!(format_utc(0), "1970-01-01 00:00:00");
        // 2009-02-13T23:31:30Z — the classic 1234567890 timestamp.
        assert_eq!(format_utc(1_234_567_890), "2009-02-13 23:31:30");
        // A leap day: 2020-02-29T12:00:00Z.
        assert_eq!(format_utc(1_582_977_600), "2020-02-29 12:00:00");
        // End-of-year boundary: 2023-12-31T23:59:59Z.
        assert_eq!(format_utc(1_704_067_199), "2023-12-31 23:59:59");
    }

    #[test]
    fn command_tries_epoch_then_formatted_fallback() {
        let cmd = clock_set_command(1_234_567_890);
        assert!(cmd.contains("date -u -s @1234567890 2>/dev/null"));
        assert!(cmd.contains("date -u -D '%Y-%m-%d %H:%M:%S' -s '2009-02-13 23:31:30' 2>/dev/null"));
        assert!(cmd.ends_with("|| true"));
    }
}
