//! `appliance-vm shell` client: connects to a VM's per-VM Unix socket
//! (served by the resident host process, bridged to a guest vsock PTY),
//! puts the local terminal in raw mode, and relays bytes both ways —
//! an interactive shell with no SSH and no dependency on k3s.
//!
//! The guest agent reads one leading `rows R cols C` line and applies it
//! as the PTY size before exec'ing the login shell, so the shell starts
//! at the caller's terminal size.

use crate::spec::VmPaths;
use anyhow::{anyhow, bail, Result};
use std::fs::File;
use std::io::Write;
use std::net::Shutdown;
use std::os::fd::{FromRawFd, RawFd};
use std::os::unix::net::UnixStream;

/// Connect to the VM's shell socket and run a shell. With `command`,
/// run it and exit; otherwise an interactive login shell. Returns the
/// process exit code to propagate.
pub fn run_client(name: &str, command: Option<&str>) -> Result<i32> {
    let sock = VmPaths::for_name(name).shell_sock();
    let mut stream = UnixStream::connect(&sock).map_err(|e| {
        anyhow!(
            "no shell channel for VM '{name}' ({e}).\n\
             Is it running? (appliance vm up) — the vsock shell needs a VM booted with this engine."
        )
    })?;

    // The agent applies this as the guest PTY size before the shell.
    let (rows, cols) = term_size();
    writeln!(stream, "rows {rows} cols {cols}")?;
    if let Some(cmd) = command {
        // Run one command, then drop the login shell.
        writeln!(stream, "{cmd}\nexit")?;
    }

    let interactive = command.is_none() && is_tty(libc::STDIN_FILENO);
    let _raw = if interactive {
        Some(RawMode::enable()?)
    } else {
        None
    };

    // Own dup'd copies of stdin/stdout so the relay does unbuffered
    // read/write without ever closing the real std fds.
    let mut sock_to_out = stream.try_clone()?;
    let mut out = dup_file(libc::STDOUT_FILENO)?;
    let mut in_ = dup_file(libc::STDIN_FILENO)?;
    let mut in_to_sock = stream;

    // stdin -> guest, on a detached thread (it may block in read until
    // the process exits once the shell closes).
    std::thread::spawn(move || {
        let _ = std::io::copy(&mut in_, &mut in_to_sock);
        let _ = in_to_sock.shutdown(Shutdown::Write);
    });

    // guest -> stdout, on this thread: it returns when the shell exits
    // and the socket closes, at which point the terminal is restored.
    let _ = std::io::copy(&mut sock_to_out, &mut out);
    Ok(0)
}

/// dup a std fd into an owned `File` (unbuffered, and closing it never
/// touches the original descriptor).
fn dup_file(fd: RawFd) -> Result<File> {
    let dup = unsafe { libc::dup(fd) };
    if dup < 0 {
        bail!("dup fd {fd} failed");
    }
    Ok(unsafe { File::from_raw_fd(dup) })
}

fn is_tty(fd: RawFd) -> bool {
    unsafe { libc::isatty(fd) == 1 }
}

/// The controlling terminal's size, or a sane 24x80 fallback when stdout
/// isn't a tty (piped/CI).
fn term_size() -> (u16, u16) {
    let mut ws: libc::winsize = unsafe { std::mem::zeroed() };
    let rc = unsafe { libc::ioctl(libc::STDOUT_FILENO, libc::TIOCGWINSZ, &mut ws) };
    if rc == 0 && ws.ws_row > 0 && ws.ws_col > 0 {
        (ws.ws_row, ws.ws_col)
    } else {
        (24, 80)
    }
}

/// RAII raw-mode guard for the local terminal: restores the saved
/// termios on drop (clean exit, error, or panic).
struct RawMode {
    fd: RawFd,
    orig: libc::termios,
}

impl RawMode {
    fn enable() -> Result<Self> {
        let fd = libc::STDIN_FILENO;
        let mut orig: libc::termios = unsafe { std::mem::zeroed() };
        if unsafe { libc::tcgetattr(fd, &mut orig) } != 0 {
            bail!("tcgetattr failed — is stdin a terminal?");
        }
        let mut raw = orig;
        unsafe { libc::cfmakeraw(&mut raw) };
        if unsafe { libc::tcsetattr(fd, libc::TCSANOW, &raw) } != 0 {
            bail!("tcsetattr failed");
        }
        Ok(RawMode { fd, orig })
    }
}

impl Drop for RawMode {
    fn drop(&mut self) {
        unsafe { libc::tcsetattr(self.fd, libc::TCSANOW, &self.orig) };
    }
}
