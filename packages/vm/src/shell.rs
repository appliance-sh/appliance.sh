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
use std::io::{Read, Write};
use std::net::Shutdown;
use std::os::fd::{FromRawFd, RawFd};
use std::os::unix::net::UnixStream;

/// Connect to a VM's shell socket, or a clear error when the relay isn't
/// up (VM down, or booted by a non-vsock engine).
fn connect(name: &str) -> Result<UnixStream> {
    let sock = VmPaths::for_name(name).shell_sock();
    UnixStream::connect(&sock).map_err(|e| {
        anyhow!(
            "no shell channel for VM '{name}' ({e}).\n\
             Is it running? (appliance vm up) — the vsock shell needs a VM booted with this engine."
        )
    })
}

/// Connect to the VM's shell socket and run a shell. With `command`,
/// run it and exit; otherwise an interactive login shell. `root` lands a
/// root shell (the escape hatch) instead of dropping to the non-root
/// `appliance` user. `session` attaches to (or creates) a reattachable
/// tmux session `<id>` that survives this client disconnecting — an
/// interactive-only addition, so it's silently dropped when a one-shot
/// `command` is given (that path must stay the byte-for-byte sentinel
/// shell). Returns the process exit code to propagate.
pub fn run_client(name: &str, command: Option<&str>, root: bool, session: Option<&str>) -> Result<i32> {
    let mut stream = connect(name)?;

    // The agent applies this as the guest PTY size before the shell. A
    // trailing `root` token requests a root shell; the agent strips it
    // and skips the `su` drop to the appliance user. An optional `attach
    // <id>` verb (interactive only) routes to a reattachable tmux session
    // instead — never on the one-shot path, which keeps the pristine
    // sentinel shell.
    let (rows, cols) = term_size();
    let verb = match (command, session) {
        (None, Some(id)) => {
            validate_session_id(id)?;
            format!(" attach {id}")
        }
        _ => String::new(),
    };
    writeln!(stream, "rows {rows} cols {cols}{}{}", if root { " root" } else { "" }, verb)?;
    if let Some(cmd) = command {
        // The vsock relay is a raw byte pipe with no status channel, so
        // carry the command's exit code back in-band: run it, print a
        // sentinel holding `$?`, then drop the login shell. The client
        // parses the sentinel below to propagate the real exit code (a
        // bare `exit` would only ever surface the login shell's status,
        // which the relay then discards).
        writeln!(stream, "{}; printf '\\n{}%d__END__\\n' \"$?\"\nexit", cmd, RC_MARK)?;
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
    if command.is_some() {
        // One-shot: stream output through, but intercept the exit-code
        // sentinel and propagate the command's real exit code.
        return Ok(pump_until_sentinel(&mut sock_to_out, &mut out));
    }
    let _ = std::io::copy(&mut sock_to_out, &mut out);
    Ok(0)
}

/// A reattachable tmux session, as reported by `sessions list`.
#[derive(Debug, PartialEq, Eq, serde::Serialize)]
pub struct SessionInfo {
    /// The host-minted id (the in-guest `appliance-` prefix stripped).
    pub id: String,
    /// tmux `session_activity` (Unix epoch seconds), when parseable.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_activity: Option<i64>,
}

/// List the VM's reattachable sessions on the appliance-user socket. A
/// short-lived connection: send the `list` verb, read the agent's
/// `appliance-<id> <activity>` lines to EOF, parse them clean. No raw
/// mode, no sentinel — the connection closing is the whole protocol.
pub fn list_sessions(name: &str) -> Result<Vec<SessionInfo>> {
    let mut stream = connect(name)?;
    let (rows, cols) = term_size();
    writeln!(stream, "rows {rows} cols {cols} list")?;
    stream.shutdown(Shutdown::Write)?;
    let mut out = String::new();
    stream.read_to_string(&mut out)?;
    Ok(parse_session_list(&out))
}

/// Kill one reattachable session by id on the appliance-user socket.
pub fn kill_session(name: &str, id: &str) -> Result<()> {
    validate_session_id(id)?;
    let mut stream = connect(name)?;
    let (rows, cols) = term_size();
    writeln!(stream, "rows {rows} cols {cols} kill {id}")?;
    stream.shutdown(Shutdown::Write)?;
    // Drain to EOF so the kill actually runs before we drop the socket.
    let mut sink = Vec::new();
    stream.read_to_end(&mut sink)?;
    Ok(())
}

/// Parse the agent's `list` output — one `appliance-<id> <activity>` line
/// per session — into clean `SessionInfo`s. The PTY translates `\n` to
/// `\r\n`, so trim the carriage return; lines without the `appliance-`
/// prefix (a blank line, a stray banner) are dropped.
fn parse_session_list(raw: &str) -> Vec<SessionInfo> {
    raw.lines()
        .filter_map(|line| {
            let line = line.trim_end_matches('\r').trim();
            let (sess_name, activity) = match line.split_once(' ') {
                Some((n, a)) => (n, Some(a)),
                None => (line, None),
            };
            let id = sess_name.strip_prefix("appliance-")?;
            if id.is_empty() {
                return None;
            }
            Some(SessionInfo {
                id: id.to_string(),
                last_activity: activity.and_then(|s| s.trim().parse::<i64>().ok()),
            })
        })
        .collect()
}

/// Session ids ride verbatim into the single-line handshake and the
/// in-guest `appliance-<id>` tmux session name. Restrict the charset so a
/// stray space (which would split the handshake) or newline (which would
/// inject a second line onto the agent's stdin) can never get through.
/// Host-minted ids — desktop tab uuids, CLI names — already satisfy this.
fn validate_session_id(id: &str) -> Result<()> {
    if id.is_empty() {
        bail!("session id must not be empty");
    }
    if !id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    {
        bail!("invalid session id '{id}': use only letters, digits, '-', '_', '.'");
    }
    Ok(())
}

/// Marker the one-shot command appends as `\n<RC_MARK><n>__END__\n`.
const RC_MARK: &str = "__APPLIANCE_VM_RC__";

/// Stream guest output to `w`, watching for the exit-code sentinel. Lines
/// carrying the marker are withheld — both the echoed command line (which
/// keeps a literal `%d`, so it won't parse) and the real sentinel — and
/// the parsed code is returned. Streams line-by-line so long-running
/// commands (`logs -f`, builds) still show progress as it arrives.
///
/// This is the one-shot path only (`command.is_some()`). If the stream
/// hits EOF without ever yielding the sentinel, the shell died before the
/// command's exit code could be reported — e.g. the `su -l appliance`
/// drop failed — so return a non-zero code (255) rather than a silent
/// success-with-empty-output that would mask such breakage.
fn pump_until_sentinel(r: &mut impl Read, w: &mut impl Write) -> i32 {
    let mut buf: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        let n = match r.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        buf.extend_from_slice(&chunk[..n]);
        while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = buf.drain(..=pos).collect();
            let text = String::from_utf8_lossy(&line);
            if text.contains(RC_MARK) {
                if let Some(code) = parse_rc(&text) {
                    return code;
                }
                continue; // echoed command line — drop it
            }
            let _ = w.write_all(&line);
            let _ = w.flush();
        }
    }
    if !buf.is_empty() {
        let text = String::from_utf8_lossy(&buf);
        if let Some(code) = parse_rc(&text) {
            return code;
        }
        if !text.contains(RC_MARK) {
            let _ = w.write_all(&buf);
        }
    }
    // EOF without a sentinel: the shell never reported the command's exit
    // code (it died first). Surface failure, not silent success.
    255
}

/// Parse `<RC_MARK><digits>__END__` out of a line, if the code is present
/// and expanded (the echoed command keeps a literal `%d` and won't parse).
fn parse_rc(line: &str) -> Option<i32> {
    let start = line.find(RC_MARK)? + RC_MARK.len();
    let rest = &line[start..];
    let end = rest.find("__END__")?;
    rest[..end].trim().parse::<i32>().ok()
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_expanded_exit_code() {
        assert_eq!(parse_rc("__APPLIANCE_VM_RC__0__END__\r\n"), Some(0));
        assert_eq!(parse_rc("__APPLIANCE_VM_RC__7__END__"), Some(7));
        assert_eq!(parse_rc("x __APPLIANCE_VM_RC__42__END__ y"), Some(42));
    }

    #[test]
    fn ignores_echoed_literal_marker() {
        // The echoed command keeps a literal `%d`, which must not parse.
        assert_eq!(parse_rc("printf '__APPLIANCE_VM_RC__%d__END__' \"$?\""), None);
        assert_eq!(parse_rc("plain output line"), None);
    }

    #[test]
    fn pump_returns_code_and_withholds_sentinel() {
        let input = b"hello\n__APPLIANCE_VM_RC__3__END__\nlogout\n";
        let mut out: Vec<u8> = Vec::new();
        let code = pump_until_sentinel(&mut &input[..], &mut out);
        assert_eq!(code, 3);
        // The sentinel line (and anything after it) is withheld.
        assert_eq!(out, b"hello\n");
    }

    #[test]
    fn pump_eof_without_sentinel_is_failure() {
        // A shell that dies before the sentinel prints (e.g. the `su -l`
        // drop failed) must surface as failure, not silent success — any
        // partial output is still flushed through.
        let input = b"partial output, no sentinel\n";
        let mut out: Vec<u8> = Vec::new();
        let code = pump_until_sentinel(&mut &input[..], &mut out);
        assert_eq!(code, 255);
        assert_eq!(out, b"partial output, no sentinel\n");

        // Empty stream (shell died immediately) is failure too.
        let mut out: Vec<u8> = Vec::new();
        let code = pump_until_sentinel(&mut &b""[..], &mut out);
        assert_eq!(code, 255);
        assert!(out.is_empty());
    }

    #[test]
    fn parses_session_list_stripping_prefix_and_cr() {
        // PTY output: `appliance-<id> <activity>\r\n` per session.
        let raw = "appliance-build 1700000000\r\nappliance-notes 1700000123\r\n";
        let got = parse_session_list(raw);
        assert_eq!(
            got,
            vec![
                SessionInfo { id: "build".into(), last_activity: Some(1_700_000_000) },
                SessionInfo { id: "notes".into(), last_activity: Some(1_700_000_123) },
            ]
        );
    }

    #[test]
    fn session_list_drops_noise_and_tolerates_missing_activity() {
        // Blank lines, a non-appliance banner, and a bare name (no
        // activity field) must not crash or leak — only real sessions
        // survive, with a missing activity left as None.
        let raw = "\nno server running on /tmp/tmux-1000/appliance\nappliance-solo\n\r\n";
        let got = parse_session_list(raw);
        assert_eq!(got, vec![SessionInfo { id: "solo".into(), last_activity: None }]);
        // Empty input → empty list.
        assert!(parse_session_list("").is_empty());
    }

    #[test]
    fn session_info_serializes_compactly() {
        // The desktop/CLI consume this as JSON; a missing activity is
        // omitted rather than serialized as null.
        let with = serde_json::to_string(&SessionInfo { id: "a".into(), last_activity: Some(42) }).unwrap();
        assert_eq!(with, r#"{"id":"a","last_activity":42}"#);
        let without = serde_json::to_string(&SessionInfo { id: "a".into(), last_activity: None }).unwrap();
        assert_eq!(without, r#"{"id":"a"}"#);
    }

    #[test]
    fn validates_session_ids() {
        // Safe ids: uuids, names, dotted/underscored.
        for ok in ["build", "tab-1", "a_b.c", "550e8400-e29b-41d4-a716-446655440000"] {
            assert!(validate_session_id(ok).is_ok(), "{ok} should be valid");
        }
        // Rejected: empty, and anything that could break the single-line
        // handshake (space, newline) or the tmux target (slash, colon).
        for bad in ["", "has space", "two\nlines", "a/b", "a:b", "semi;rm"] {
            assert!(validate_session_id(bad).is_err(), "{bad:?} should be rejected");
        }
    }
}
