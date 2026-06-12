//! Outbound-traffic control for a microVM.
//!
//! Borrowing Docker's sandbox model: all of the guest's egress is
//! routed through a forward proxy that Appliance runs and the desktop
//! controls. The proxy enforces an allow/deny policy by destination
//! host, so a workload can be confined to a known set of endpoints —
//! the desktop edits the policy file, the proxy picks it up live.
//!
//! This module is the policy + proxy core. It handles HTTP `CONNECT`
//! (the HTTPS path: decide by the tunnel host, then splice or refuse)
//! and plain-HTTP forwarding (decide by the Host header). It does not
//! yet decrypt TLS — host-level control needs only the CONNECT target
//! and SNI, which travel in the clear. TLS interception (a generated
//! CA + per-host leaf certs, for payload inspection) layers on top in
//! a later pass; the CA scaffolding lives alongside this.
//!
//! Routing the guest's traffic into the proxy (HTTP(S)_PROXY in the
//! workloads, or a transparent redirect) is a separate wiring step —
//! the proxy is independently runnable and testable on the host
//! (`curl -x http://127.0.0.1:<port> https://example.com`).

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::Arc;

use crate::mitm;
use crate::spec::VmPaths;

/// What the proxy does with a connection no explicit rule covers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Action {
    Allow,
    Deny,
}

fn default_action() -> Action {
    // Allow by default: the policy is opt-in confinement, not a
    // breaking change to existing workloads. A user (or the desktop)
    // tightens it by switching the default to "deny" + an allowlist.
    Action::Allow
}

/// Desktop-controlled outbound policy. Persisted as JSON next to the
/// VM's other state; reloaded per connection so edits apply live.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EgressPolicy {
    #[serde(default = "default_action")]
    pub default: Action,
    /// Host suffixes to allow (e.g. `github.com` matches `github.com`
    /// and `api.github.com`).
    #[serde(default)]
    pub allow: Vec<String>,
    /// Host suffixes to deny. Deny wins over allow.
    #[serde(default)]
    pub deny: Vec<String>,
    /// Intercept TLS on allowed HTTPS connections — terminate with a
    /// minted leaf (guest trusts the VM CA), inspect/log the decrypted
    /// request, re-originate upstream. Off by default: blind tunnel.
    #[serde(default)]
    pub mitm: bool,
}

impl Default for EgressPolicy {
    fn default() -> Self {
        Self {
            default: default_action(),
            allow: Vec::new(),
            deny: Vec::new(),
            mitm: false,
        }
    }
}

fn host_matches(host: &str, suffix: &str) -> bool {
    let host = host.trim().trim_end_matches('.').to_ascii_lowercase();
    let suffix = suffix.trim().trim_start_matches('.').trim_end_matches('.').to_ascii_lowercase();
    if suffix.is_empty() {
        return false;
    }
    host == suffix || host.ends_with(&format!(".{suffix}"))
}

impl EgressPolicy {
    /// Is this policy doing anything? A permissive default with no
    /// rules and no interception is inert — workloads need not be
    /// routed through the proxy at all.
    pub fn is_active(&self) -> bool {
        self.default == Action::Deny || !self.allow.is_empty() || !self.deny.is_empty() || self.mitm
    }

    /// Allow this destination host? Deny rules win, then allow rules,
    /// then the default. `host` may carry a `:port` — it's stripped.
    pub fn allows(&self, host_port: &str) -> bool {
        let host = host_port.rsplit_once(':').map_or(host_port, |(h, _)| h);
        // An IPv6 literal arrives bracketed (`[::1]`); the rsplit above
        // also trims a trailing `:port`, leaving the brackets — fine
        // for suffix matching, which only cares about names.
        if self.deny.iter().any(|s| host_matches(host, s)) {
            return false;
        }
        if self.allow.iter().any(|s| host_matches(host, s)) {
            return true;
        }
        self.default == Action::Allow
    }
}

fn policy_path(name: &str) -> PathBuf {
    VmPaths::for_name(name).dir.join("egress-policy.json")
}

/// Load the VM's policy, or a permissive default when none is set.
pub fn load_policy(name: &str) -> EgressPolicy {
    let path = policy_path(name);
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

/// Persist the VM's policy (creating the state dir if needed).
pub fn save_policy(name: &str, policy: &EgressPolicy) -> Result<()> {
    let path = policy_path(name);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_string_pretty(policy)?;
    std::fs::write(&path, json).with_context(|| format!("write {}", path.display()))?;
    Ok(())
}

/// Run the forward proxy until killed. Reloads the policy per
/// connection so the desktop's edits take effect without a restart.
pub fn run_proxy(name: &str, addr: SocketAddr, log: bool) -> Result<()> {
    let (listener, ctx) = build(name, addr, log)?;
    let policy = load_policy(name);
    println!(
        "egress proxy for VM '{name}' listening on {}",
        listener.local_addr().unwrap_or(addr)
    );
    println!(
        "policy: default={:?}, {} allow, {} deny rules, mitm={}",
        policy.default,
        policy.allow.len(),
        policy.deny.len(),
        policy.mitm
    );
    accept_loop(listener, ctx); // blocks until the listener dies
    Ok(())
}

/// Start the proxy on a background thread (used by `vm run`, so the
/// proxy lives exactly as long as the VM host process). Returns once
/// it's bound; the accept loop runs detached.
pub fn spawn(name: &str, addr: SocketAddr, log: bool) -> Result<()> {
    let (listener, ctx) = build(name, addr, log)?;
    std::thread::spawn(move || accept_loop(listener, ctx));
    Ok(())
}

/// Bind the listener and assemble the per-connection context (policy
/// name + TLS material). The CA is generated on first use so an
/// intercepted connection doesn't pay for it; it's harmless (unused)
/// when MITM is off.
fn build(name: &str, addr: SocketAddr, log: bool) -> Result<(TcpListener, Arc<ProxyCtx>)> {
    let listener = TcpListener::bind(addr).with_context(|| format!("bind {addr}"))?;
    let ca = Arc::new(mitm::ensure_ca(name)?);
    let ctx = Arc::new(ProxyCtx {
        name: name.to_string(),
        log,
        server_cfg: mitm::server_config(ca)?,
        client_cfg: mitm::client_config()?,
    });
    Ok((listener, ctx))
}

fn accept_loop(listener: TcpListener, ctx: Arc<ProxyCtx>) {
    for stream in listener.incoming() {
        let Ok(stream) = stream else { continue };
        let ctx = ctx.clone();
        std::thread::spawn(move || {
            if let Err(e) = handle_conn(stream, &ctx) {
                if ctx.log {
                    eprintln!("egress: connection error: {e:#}");
                }
            }
        });
    }
}

struct ProxyCtx {
    name: String,
    log: bool,
    server_cfg: Arc<rustls::ServerConfig>,
    client_cfg: Arc<rustls::ClientConfig>,
}

/// Read an HTTP request head (up to and including the blank line).
/// Byte-at-a-time so we don't over-read into a CONNECT tunnel's body.
fn read_head(stream: &mut TcpStream) -> Result<String> {
    let mut buf = Vec::with_capacity(256);
    let mut byte = [0u8; 1];
    loop {
        let n = stream.read(&mut byte)?;
        if n == 0 {
            break;
        }
        buf.push(byte[0]);
        if buf.ends_with(b"\r\n\r\n") {
            break;
        }
        if buf.len() > 64 * 1024 {
            anyhow::bail!("request head too large");
        }
    }
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

fn handle_conn(mut client: TcpStream, ctx: &ProxyCtx) -> Result<()> {
    let log = ctx.log;
    // Guard against being an open proxy: only the guest (the VM's
    // subnet) and the local host may use it. This matters because the
    // proxy is meant to be bound where the guest can reach it
    // (0.0.0.0 / the gateway), which would otherwise expose an
    // allow-by-default forward proxy to the whole LAN.
    if let Ok(peer) = client.peer_addr() {
        if !peer_allowed(peer.ip(), &ctx.name) {
            if log {
                eprintln!("egress: refusing non-guest peer {}", peer.ip());
            }
            return Ok(());
        }
    }
    let head = read_head(&mut client)?;
    let mut lines = head.lines();
    let request_line = lines.next().unwrap_or_default();
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or_default().to_string();
    let target = parts.next().unwrap_or_default().to_string();
    let policy = load_policy(&ctx.name);

    if method.eq_ignore_ascii_case("CONNECT") {
        // target is `host:port`.
        let allowed = policy.allows(&target);
        let intercept = allowed && policy.mitm;
        if log {
            let action = if !allowed {
                "deny"
            } else if intercept {
                "allow+mitm"
            } else {
                "allow"
            };
            eprintln!("egress: CONNECT {target} -> {action}");
        }
        if !allowed {
            return refuse(&mut client, &target);
        }
        if intercept {
            let (host, port) = split_host_port(&target);
            // The client expects the tunnel up before its TLS hello.
            client.write_all(b"HTTP/1.1 200 Connection established\r\n\r\n")?;
            return mitm::intercept(
                client,
                &host,
                port,
                ctx.server_cfg.clone(),
                ctx.client_cfg.clone(),
                log,
            );
        }
        let upstream = TcpStream::connect(&target).with_context(|| format!("connect {target}"))?;
        client.write_all(b"HTTP/1.1 200 Connection established\r\n\r\n")?;
        splice(client, upstream)
    } else {
        // Plain HTTP: decide by the Host header (or the absolute-URI
        // authority in the request line).
        let host = header_value(&head, "host")
            .or_else(|| authority_of(&target))
            .unwrap_or_default();
        let allowed = !host.is_empty() && policy.allows(&host);
        if log {
            eprintln!("egress: {method} {host} -> {}", if allowed { "allow" } else { "deny" });
        }
        if !allowed {
            return refuse(&mut client, &host);
        }
        let port = 80;
        let dest = format!("{host}:{port}");
        let mut upstream = TcpStream::connect(&dest).with_context(|| format!("connect {dest}"))?;
        // Replay the head verbatim, then splice the rest both ways.
        upstream.write_all(head.as_bytes())?;
        splice(client, upstream)
    }
}

fn refuse(client: &mut TcpStream, host: &str) -> Result<()> {
    let body = format!("egress blocked by policy: {host}\n");
    let resp = format!(
        "HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    client.write_all(resp.as_bytes())?;
    Ok(())
}

/// Pump bytes both directions until either side closes.
fn splice(client: TcpStream, upstream: TcpStream) -> Result<()> {
    let mut c_read = client.try_clone()?;
    let mut u_write = upstream.try_clone()?;
    let up = std::thread::spawn(move || {
        let _ = std::io::copy(&mut c_read, &mut u_write);
        let _ = u_write.shutdown(std::net::Shutdown::Write);
    });
    let mut u_read = upstream;
    let mut c_write = client;
    let _ = std::io::copy(&mut u_read, &mut c_write);
    let _ = c_write.shutdown(std::net::Shutdown::Write);
    let _ = up.join();
    Ok(())
}

fn header_value(head: &str, name: &str) -> Option<String> {
    head.lines()
        .skip(1)
        .filter_map(|line| line.split_once(':'))
        .find(|(k, _)| k.trim().eq_ignore_ascii_case(name))
        .map(|(_, v)| v.trim().to_string())
}

/// Pull the authority out of an absolute request URI
/// (`http://host:port/path` → `host:port` → `host`).
fn authority_of(target: &str) -> Option<String> {
    let rest = target.strip_prefix("http://").or_else(|| target.strip_prefix("https://"))?;
    let authority = rest.split('/').next().unwrap_or(rest);
    let host = authority.rsplit_once(':').map_or(authority, |(h, _)| h);
    (!host.is_empty()).then(|| host.to_string())
}

/// May this peer use the proxy? Loopback (local testing) always; the
/// guest otherwise — its address shares the VM subnet's /24 (the host
/// sits on the `.1`). Everything else (the wider LAN) is refused so a
/// gateway/0.0.0.0 bind can't become an open forward proxy.
fn peer_allowed(peer: std::net::IpAddr, name: &str) -> bool {
    if peer.is_loopback() {
        return true;
    }
    let std::net::IpAddr::V4(peer) = peer else {
        return false; // vz NAT is IPv4-only
    };
    let subnet = guest_subnet_v3(name);
    let o = peer.octets();
    [o[0], o[1], o[2]] == subnet
}

/// First three octets of the VM's subnet, from the guest's leased IP
/// (defaults to vz's 192.168.64.x when not yet known).
fn guest_subnet_v3(name: &str) -> [u8; 3] {
    std::fs::read_to_string(VmPaths::for_name(name).guest_ip())
        .ok()
        .and_then(|raw| raw.trim().parse::<std::net::Ipv4Addr>().ok())
        .map(|ip| {
            let o = ip.octets();
            [o[0], o[1], o[2]]
        })
        .unwrap_or([192, 168, 64])
}

/// The proxy URL a guest workload should point `HTTPS_PROXY` at,
/// derived from the VM's subnet gateway (the `.1` of the guest's /24,
/// where the host sits on the vz NAT) and the egress port. Falls back
/// to the vz default subnet when the guest IP isn't known yet.
pub fn guest_proxy_url(name: &str, port: u16) -> String {
    let gw = std::fs::read_to_string(VmPaths::for_name(name).guest_ip())
        .ok()
        .and_then(|raw| raw.trim().parse::<std::net::Ipv4Addr>().ok())
        .map(|ip| {
            let o = ip.octets();
            std::net::Ipv4Addr::new(o[0], o[1], o[2], 1)
        })
        .unwrap_or(std::net::Ipv4Addr::new(192, 168, 64, 1));
    format!("http://{gw}:{port}")
}

/// Split a CONNECT `host:port` target, defaulting to 443.
fn split_host_port(target: &str) -> (String, u16) {
    match target.rsplit_once(':') {
        Some((h, p)) => (h.to_string(), p.parse().unwrap_or(443)),
        None => (target.to_string(), 443),
    }
}

/// Default proxy port — clear of the k3d (5050) and microVM (5052)
/// registry ports and the ingress/api forwards.
pub const DEFAULT_EGRESS_PORT: u16 = 5053;

/// Kubernetes namespace the api-server + workloads live in (mirrors
/// DEFAULT_LOCAL_NAMESPACE in @appliance.sh/infra).
const CLUSTER_NAMESPACE: &str = "appliance";

/// NO_PROXY value for confined workloads: bypass the proxy for
/// cluster-internal destinations (kube API, services, the k3s pod/
/// service CIDRs) so only real outbound traffic is policed.
fn default_no_proxy() -> &'static str {
    "localhost,127.0.0.1,::1,.svc,.svc.cluster.local,.cluster.local,10.42.0.0/16,10.43.0.0/16,kubernetes.default"
}

fn which_kubectl() -> Option<PathBuf> {
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        let managed = home.join(".appliance").join("bin").join("kubectl");
        if managed.is_file() {
            return Some(managed);
        }
    }
    // Fall back to PATH resolution by name.
    Some(PathBuf::from("kubectl"))
}

/// Render the `appliance-egress` ConfigMap the in-VM api-server reads
/// to inject proxy + CA into workloads. `ca` (PEM) is embedded only
/// when interception is on.
fn render_configmap(proxy_url: &str, no_proxy: &str, mitm: bool, ca: Option<&str>) -> String {
    let mut out = format!(
        "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: appliance-egress\n  namespace: {CLUSTER_NAMESPACE}\n  labels:\n    app.kubernetes.io/managed-by: appliance.sh\ndata:\n  proxyUrl: {proxy_url:?}\n  noProxy: {no_proxy:?}\n  mitm: {:?}\n",
        if mitm { "true" } else { "false" }
    );
    if let Some(pem) = ca {
        out.push_str("  ca.crt: |\n");
        for line in pem.lines() {
            out.push_str("    ");
            out.push_str(line);
            out.push('\n');
        }
    }
    out
}

/// Publish the current egress policy into the cluster as the
/// `appliance-egress` ConfigMap. Best-effort: needs the VM up
/// (kubeconfig present) and kubectl available; silently no-ops
/// otherwise so policy edits never fail on a down cluster.
pub fn publish_configmap(name: &str) -> Result<()> {
    let kubeconfig = VmPaths::for_name(name).kubeconfig();
    if !kubeconfig.exists() {
        return Ok(());
    }
    let Some(kubectl) = which_kubectl() else {
        return Ok(());
    };
    let kc = kubeconfig.to_string_lossy();
    let policy = load_policy(name);

    // Inert policy → no confinement: remove any prior ConfigMap so the
    // api-server stops routing workloads through the proxy.
    if !policy.is_active() {
        let _ = Command::new(&kubectl)
            .args([
                "--kubeconfig",
                &kc,
                "-n",
                CLUSTER_NAMESPACE,
                "delete",
                "configmap",
                "appliance-egress",
                "--ignore-not-found",
            ])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        return Ok(());
    }

    let proxy_url = guest_proxy_url(name, DEFAULT_EGRESS_PORT);
    let ca = if policy.mitm {
        std::fs::read_to_string(mitm::ca_cert_path(name)).ok()
    } else {
        None
    };
    let manifest = render_configmap(&proxy_url, default_no_proxy(), policy.mitm, ca.as_deref());

    let mut child = match Command::new(&kubectl)
        .args(["--kubeconfig", &kc, "apply", "-f", "-"])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(c) => c,
        Err(_) => return Ok(()), // kubectl missing → skip
    };
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(manifest.as_bytes());
    }
    let _ = child.wait();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy(default: Action, allow: &[&str], deny: &[&str]) -> EgressPolicy {
        EgressPolicy {
            default,
            allow: allow.iter().map(|s| s.to_string()).collect(),
            deny: deny.iter().map(|s| s.to_string()).collect(),
            mitm: false,
        }
    }

    #[test]
    fn default_allow_passes_everything() {
        let p = policy(Action::Allow, &[], &[]);
        assert!(p.allows("example.com:443"));
        assert!(p.allows("anything.test:80"));
    }

    #[test]
    fn default_deny_blocks_unless_allowlisted() {
        let p = policy(Action::Deny, &["github.com"], &[]);
        assert!(p.allows("github.com:443"));
        assert!(p.allows("api.github.com:443"));
        assert!(!p.allows("evil.test:443"));
    }

    #[test]
    fn deny_wins_over_allow() {
        let p = policy(Action::Allow, &["github.com"], &["gist.github.com"]);
        assert!(p.allows("github.com:443"));
        assert!(!p.allows("gist.github.com:443"));
    }

    #[test]
    fn suffix_does_not_match_substring() {
        let p = policy(Action::Deny, &["github.com"], &[]);
        // notgithub.com must NOT be treated as a subdomain of github.com
        assert!(!p.allows("notgithub.com:443"));
    }

    #[test]
    fn host_without_port_is_handled() {
        let p = policy(Action::Deny, &["example.com"], &[]);
        assert!(p.allows("example.com"));
    }

    #[test]
    fn peer_guard_allows_loopback_and_guest_subnet() {
        // No guest-ip file for this fake name → default vz subnet.
        let name = "egress-peer-test-unused";
        assert!(peer_allowed("127.0.0.1".parse().unwrap(), name));
        assert!(peer_allowed("::1".parse().unwrap(), name));
        assert!(peer_allowed("192.168.64.7".parse().unwrap(), name));
    }

    #[test]
    fn peer_guard_refuses_lan_and_ipv6() {
        let name = "egress-peer-test-unused";
        // A typical home-LAN address must not be able to use the proxy.
        assert!(!peer_allowed("192.168.1.50".parse().unwrap(), name));
        assert!(!peer_allowed("10.0.0.5".parse().unwrap(), name));
        // Non-loopback IPv6 isn't on the vz NAT.
        assert!(!peer_allowed("fd00::1".parse().unwrap(), name));
    }

    #[test]
    fn authority_of_extracts_host() {
        assert_eq!(authority_of("http://example.com/path").as_deref(), Some("example.com"));
        assert_eq!(authority_of("http://example.com:8080/p").as_deref(), Some("example.com"));
        assert_eq!(authority_of("https://api.test").as_deref(), Some("api.test"));
        assert_eq!(authority_of("/just/a/path"), None);
    }

    #[test]
    fn configmap_embeds_policy_and_quotes_values() {
        let cm = render_configmap("http://192.168.64.1:5053", "localhost,.svc", true, Some("PEMDATA"));
        assert!(cm.contains("kind: ConfigMap"));
        assert!(cm.contains("name: appliance-egress"));
        assert!(cm.contains("namespace: appliance"));
        assert!(cm.contains("proxyUrl: \"http://192.168.64.1:5053\""));
        assert!(cm.contains("noProxy: \"localhost,.svc\""));
        assert!(cm.contains("mitm: \"true\""));
        // CA embedded as an indented block scalar.
        assert!(cm.contains("ca.crt: |\n    PEMDATA"));
    }

    #[test]
    fn configmap_omits_ca_when_mitm_off() {
        let cm = render_configmap("http://x:5053", "localhost", false, None);
        assert!(cm.contains("mitm: \"false\""));
        assert!(!cm.contains("ca.crt"));
    }

    #[test]
    fn split_host_port_defaults_to_443() {
        assert_eq!(split_host_port("example.com:8443"), ("example.com".to_string(), 8443));
        assert_eq!(split_host_port("example.com"), ("example.com".to_string(), 443));
        // Garbage port falls back to 443 rather than panicking.
        assert_eq!(split_host_port("example.com:notaport"), ("example.com".to_string(), 443));
    }
}
