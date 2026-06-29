//! TLS interception for egress control.
//!
//! Docker's sandbox decrypts outbound TLS by presenting workloads a
//! certificate it minted from a CA the guest trusts; we do the same.
//! `appliance-vm` generates a per-VM CA once, injects it into the
//! guest trust store, and the egress proxy mints a short-lived leaf
//! per destination host on the fly — so it can see (and apply
//! policy to) the decrypted HTTP, then re-originate a real TLS
//! connection upstream.
//!
//! This module owns the crypto: CA generation/persistence and the
//! rustls cert resolver that mints leaves on demand. The proxy wiring
//! that uses it lives in egress.rs.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};

use anyhow::{Context, Result};
use rcgen::{BasicConstraints, Certificate, CertificateParams, DnType, IsCa, KeyPair, KeyUsagePurpose};
use rustls::pki_types::{PrivateKeyDer, ServerName};
use rustls::server::{ClientHello, ResolvesServerCert};
use rustls::sign::CertifiedKey;
use rustls::{ClientConfig, ClientConnection, RootCertStore, ServerConfig, ServerConnection, StreamOwned};

use crate::spec::VmPaths;

pub fn ca_cert_path(name: &str) -> PathBuf {
    VmPaths::for_name(name).dir.join("egress-ca.pem")
}

fn ca_key_path(name: &str) -> PathBuf {
    VmPaths::for_name(name).dir.join("egress-ca-key.pem")
}

/// The persisted CA, reconstructed as an rcgen `Certificate` +
/// `KeyPair` ready to sign leaf certs.
pub struct Ca {
    cert: Certificate,
    key: KeyPair,
}

/// Load the VM's egress CA, generating + persisting it on first use.
pub fn ensure_ca(name: &str) -> Result<Ca> {
    let cert_path = ca_cert_path(name);
    let key_path = ca_key_path(name);

    if cert_path.exists() && key_path.exists() {
        let cert_pem = std::fs::read_to_string(&cert_path)?;
        let key_pem = std::fs::read_to_string(&key_path)?;
        let key = KeyPair::from_pem(&key_pem).context("parse CA key")?;
        // Reconstruct the issuer cert from the persisted PEM. Leaves
        // are signed by `key` with this cert's DN as the issuer, so
        // they chain to the same trust anchor curl/the guest holds.
        let params = CertificateParams::from_ca_cert_pem(&cert_pem).context("parse CA cert")?;
        let cert = params.self_signed(&key).context("rebuild CA cert")?;
        return Ok(Ca { cert, key });
    }

    let mut params = CertificateParams::new(Vec::new())?;
    params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    params
        .distinguished_name
        .push(DnType::CommonName, "Appliance Egress CA");
    params
        .distinguished_name
        .push(DnType::OrganizationName, "Appliance");
    params.key_usages = vec![
        KeyUsagePurpose::KeyCertSign,
        KeyUsagePurpose::CrlSign,
        KeyUsagePurpose::DigitalSignature,
    ];
    let key = KeyPair::generate()?;
    let cert = params.self_signed(&key)?;
    let cert_pem = cert.pem();

    if let Some(parent) = cert_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&cert_path, &cert_pem).with_context(|| format!("write {}", cert_path.display()))?;
    std::fs::write(&key_path, key.serialize_pem())
        .with_context(|| format!("write {}", key_path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&key_path, std::fs::Permissions::from_mode(0o600));
    }

    Ok(Ca { cert, key })
}

impl Ca {
    /// Mint a leaf certificate for `host`, signed by this CA.
    fn mint_leaf(&self, host: &str) -> Result<CertifiedKey> {
        let mut params = CertificateParams::new(vec![host.to_string()])?;
        params.distinguished_name.push(DnType::CommonName, host);
        let leaf_key = KeyPair::generate()?;
        let leaf = params.signed_by(&leaf_key, &self.cert, &self.key)?;

        let chain = vec![leaf.der().clone()];
        let key_der = PrivateKeyDer::try_from(leaf_key.serialize_der())
            .map_err(|e| anyhow::anyhow!("leaf key der: {e}"))?;
        let signing_key = rustls::crypto::ring::sign::any_supported_type(&key_der)
            .context("leaf signing key")?;
        Ok(CertifiedKey::new(chain, signing_key))
    }
}

/// rustls cert resolver that mints (and caches) a leaf per SNI host,
/// so a single proxy serves any destination the workload reaches.
pub struct MintingResolver {
    ca: Arc<Ca>,
    cache: Mutex<HashMap<String, Arc<CertifiedKey>>>,
}

impl MintingResolver {
    pub fn new(ca: Arc<Ca>) -> Self {
        Self {
            ca,
            cache: Mutex::new(HashMap::new()),
        }
    }
}

impl std::fmt::Debug for MintingResolver {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("MintingResolver")
    }
}

impl ResolvesServerCert for MintingResolver {
    fn resolve(&self, hello: ClientHello<'_>) -> Option<Arc<CertifiedKey>> {
        let host = hello.server_name()?.to_string();
        let mut cache = self.cache.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(existing) = cache.get(&host) {
            return Some(existing.clone());
        }
        let minted = Arc::new(self.ca.mint_leaf(&host).ok()?);
        cache.insert(host, minted.clone());
        Some(minted)
    }
}

// --- TLS configs ----------------------------------------------------

fn provider() -> Arc<rustls::crypto::CryptoProvider> {
    Arc::new(rustls::crypto::ring::default_provider())
}

/// A server config that presents minted leaves for any SNI — the
/// client (guest workload, trusting our CA) terminates TLS here.
pub fn server_config(ca: Arc<Ca>) -> Result<Arc<ServerConfig>> {
    let cfg = ServerConfig::builder_with_provider(provider())
        .with_safe_default_protocol_versions()
        .context("server tls versions")?
        .with_no_client_auth()
        .with_cert_resolver(Arc::new(MintingResolver::new(ca)));
    Ok(Arc::new(cfg))
}

/// The client config used to re-originate TLS to the real upstream,
/// validating against the webpki trust roots. Built once.
pub fn client_config() -> Result<Arc<ClientConfig>> {
    static CFG: OnceLock<Arc<ClientConfig>> = OnceLock::new();
    if let Some(c) = CFG.get() {
        return Ok(c.clone());
    }
    let roots = RootCertStore {
        roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
    };
    let cfg = ClientConfig::builder_with_provider(provider())
        .with_safe_default_protocol_versions()
        .context("client tls versions")?
        .with_root_certificates(roots)
        .with_no_client_auth();
    let arc = Arc::new(cfg);
    let _ = CFG.set(arc.clone());
    Ok(arc)
}

// --- interception ---------------------------------------------------

/// Intercept one CONNECT tunnel: terminate the client's TLS with a
/// minted leaf, re-originate TLS to `host:port`, and forward a single
/// HTTP/1 request/response. We force `Connection: close` upstream so
/// the response is delimited by EOF — no fragile keep-alive framing —
/// which is correct for the typical one-shot calls workloads make.
///
/// `client_tcp` has already received the proxy's `200` and is about
/// to start its TLS handshake.
pub fn intercept(
    name: &str,
    client_tcp: TcpStream,
    host: &str,
    port: u16,
    server_cfg: Arc<ServerConfig>,
    client_cfg: Arc<ClientConfig>,
    log: bool,
) -> Result<()> {
    let server_conn = ServerConnection::new(server_cfg).context("server tls conn")?;
    let mut client_tls = StreamOwned::new(server_conn, client_tcp);

    // Read the decrypted request head from the client (this drives the
    // client-side TLS handshake against our minted leaf).
    let head = read_http_head(&mut client_tls)?;
    let request_line = head.lines().next().unwrap_or_default().to_string();
    // A real request line has at least METHOD + TARGET. Bail on an
    // empty/garbled head (client hung up, or spoke non-HTTP) rather
    // than dialing upstream and forwarding nonsense.
    if request_line.split_whitespace().count() < 2 {
        return Ok(());
    }
    if log {
        eprintln!("egress mitm: {host} :: {request_line}");
    }
    // Record the decrypted request for the desktop traffic view.
    {
        let mut parts = request_line.split_whitespace();
        let method = parts.next().unwrap_or_default();
        let path = parts.next().unwrap_or("/");
        crate::traffic::record(name, host, port, method, Some(path), "mitm");
    }

    // Load the credential config ONCE for this intercepted request and
    // thread it through both capture and injection — no per-phase re-read.
    let cfg = crate::creds::load_config(name);

    // Credential capture: lift a configured credential header off the
    // request into the host-side secret store (best-effort). The broker
    // rule for api.anthropic.com is capture:false, so the in-guest
    // placeholder x-api-key is never lifted into egress-secrets.json.
    crate::creds::capture_from_head(&cfg, name, host, &head);

    // Resolve the credential to inject BEFORE dialing upstream so we can
    // fail CLOSED, atomically: classifying "no rule" vs "rule but
    // unresolved" vs "resolved" from the SAME single config load avoids a
    // TOCTOU where the rule is seen but the value isn't (or vice versa). A
    // host that HAS an inject rule but whose credential can't be resolved
    // (host helper failed / Anthropic key not configured / Keychain
    // locked) must NEVER forward the in-guest placeholder credential to
    // the real upstream — refuse with a clear, actionable error and dial
    // no upstream, so the placeholder leaves the host zero times.
    let injection = match crate::creds::resolve_injection(&cfg, name, host) {
        crate::creds::Injection::Resolved(header, value) => Some((header, value)),
        crate::creds::Injection::RuleButUnresolved => {
            if log {
                eprintln!("egress mitm: {host} :: credential not configured — refusing (fail closed)");
            }
            return write_cred_unconfigured(&mut client_tls, host);
        }
        crate::creds::Injection::NoRule => None,
    };

    // Only now dial upstream — no wasted connection on a dead client.
    let upstream_tcp = TcpStream::connect((host, port)).with_context(|| format!("connect {host}:{port}"))?;
    let sni = ServerName::try_from(host.to_string()).context("server name")?;
    let client_conn = ClientConnection::new(client_cfg, sni).context("client tls conn")?;
    let mut up_tls = StreamOwned::new(client_conn, upstream_tcp);

    // Force a single request/response, then close. Credential
    // injection (if configured) sets the header on the outbound copy,
    // so the workload need never hold the secret itself.
    let mut rewritten = force_connection_close(&head);
    if let Some((header, value)) = injection {
        rewritten = crate::creds::set_header(&rewritten, &header, &value);
    }
    up_tls.write_all(rewritten.as_bytes())?;
    copy_request_body(&mut client_tls, &mut up_tls, &head)?;
    up_tls.flush()?;

    // Upstream now EOF-delimits the response — stream it straight back.
    std::io::copy(&mut up_tls, &mut client_tls).ok();
    client_tls.flush().ok();
    Ok(())
}

/// Read an HTTP message head (through the blank line) from a stream.
fn read_http_head<R: Read>(r: &mut R) -> Result<String> {
    let mut buf = Vec::with_capacity(512);
    let mut byte = [0u8; 1];
    loop {
        let n = r.read(&mut byte)?;
        if n == 0 {
            break;
        }
        buf.push(byte[0]);
        if buf.ends_with(b"\r\n\r\n") {
            break;
        }
        if buf.len() > 256 * 1024 {
            anyhow::bail!("request head too large");
        }
    }
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

/// Replace any Connection/Proxy-Connection headers with a single
/// `Connection: close`, preserving the rest of the head verbatim.
fn force_connection_close(head: &str) -> String {
    let mut out = String::with_capacity(head.len() + 20);
    let mut lines = head.split("\r\n");
    if let Some(request_line) = lines.next() {
        out.push_str(request_line);
        out.push_str("\r\n");
    }
    for line in lines {
        if line.is_empty() {
            break;
        }
        let lower = line.to_ascii_lowercase();
        if lower.starts_with("connection:") || lower.starts_with("proxy-connection:") {
            continue;
        }
        out.push_str(line);
        out.push_str("\r\n");
    }
    out.push_str("Connection: close\r\n\r\n");
    out
}

/// Fail-closed response for an intercepted host that has a
/// credential-injection rule the broker can't satisfy (host helper
/// failed / the key isn't configured). Writes a clear, actionable HTTP
/// error back to the guest over the already-terminated TLS — and
/// crucially returns WITHOUT dialing the real upstream, so the in-guest
/// placeholder credential never crosses the host boundary. The message
/// never contains a credential.
fn write_cred_unconfigured<W: Write>(client_tls: &mut W, host: &str) -> Result<()> {
    let body = format!("Anthropic key not configured for {host} (run `appliance agent login`).\n");
    let resp = format!(
        "HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{body}",
        body.len()
    );
    client_tls.write_all(resp.as_bytes())?;
    client_tls.flush().ok();
    Ok(())
}

fn header_value<'a>(head: &'a str, name: &str) -> Option<&'a str> {
    head.lines()
        .skip(1)
        .filter_map(|line| line.split_once(':'))
        .find(|(k, _)| k.trim().eq_ignore_ascii_case(name))
        .map(|(_, v)| v.trim())
}

/// Forward a request body (if any) by Content-Length or chunked
/// encoding. Requests without either carry no body.
fn copy_request_body<R: Read, W: Write>(reader: &mut R, writer: &mut W, head: &str) -> Result<()> {
    if header_value(head, "transfer-encoding")
        .map(|v| v.to_ascii_lowercase().contains("chunked"))
        .unwrap_or(false)
    {
        return copy_chunked(reader, writer);
    }
    if let Some(len) = header_value(head, "content-length").and_then(|v| v.trim().parse::<u64>().ok()) {
        copy_n(reader, writer, len)?;
    }
    Ok(())
}

fn copy_n<R: Read, W: Write>(reader: &mut R, writer: &mut W, mut remaining: u64) -> Result<()> {
    let mut buf = [0u8; 8192];
    while remaining > 0 {
        let want = remaining.min(buf.len() as u64) as usize;
        let n = reader.read(&mut buf[..want])?;
        if n == 0 {
            break;
        }
        writer.write_all(&buf[..n])?;
        remaining -= n as u64;
    }
    Ok(())
}

/// Copy a chunked-encoded body verbatim (size lines + data) through to
/// the terminating zero-size chunk.
fn copy_chunked<R: Read, W: Write>(reader: &mut R, writer: &mut W) -> Result<()> {
    loop {
        let size_line = read_line(reader)?;
        writer.write_all(size_line.as_bytes())?;
        let hex = size_line.trim_end().split(';').next().unwrap_or("").trim();
        let size = u64::from_str_radix(hex, 16).unwrap_or(0);
        if size == 0 {
            // Trailer (possibly empty) up to the final blank line.
            loop {
                let line = read_line(reader)?;
                writer.write_all(line.as_bytes())?;
                if line == "\r\n" || line.is_empty() {
                    break;
                }
            }
            break;
        }
        copy_n(reader, writer, size)?;
        // Trailing CRLF after the chunk data.
        let crlf = read_line(reader)?;
        writer.write_all(crlf.as_bytes())?;
    }
    Ok(())
}

fn read_line<R: Read>(reader: &mut R) -> Result<String> {
    let mut buf = Vec::with_capacity(32);
    let mut byte = [0u8; 1];
    loop {
        let n = reader.read(&mut byte)?;
        if n == 0 {
            break;
        }
        buf.push(byte[0]);
        if buf.ends_with(b"\n") {
            break;
        }
    }
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn force_close_replaces_existing_connection_header() {
        let head = "GET / HTTP/1.1\r\nHost: x\r\nConnection: keep-alive\r\nAccept: */*\r\n\r\n";
        let out = force_connection_close(head);
        // Request line + non-Connection headers preserved.
        assert!(out.starts_with("GET / HTTP/1.1\r\n"));
        assert!(out.contains("Host: x\r\n"));
        assert!(out.contains("Accept: */*\r\n"));
        // Exactly one Connection header, and it's close.
        assert_eq!(out.matches("Connection:").count(), 1);
        assert!(out.contains("Connection: close\r\n"));
        assert!(!out.to_ascii_lowercase().contains("keep-alive"));
        assert!(out.ends_with("\r\n\r\n"));
    }

    #[test]
    fn force_close_strips_proxy_connection_and_adds_when_absent() {
        let with_proxy = "GET / HTTP/1.1\r\nProxy-Connection: keep-alive\r\n\r\n";
        let out = force_connection_close(with_proxy);
        assert!(!out.to_ascii_lowercase().contains("proxy-connection:"));
        assert!(out.contains("Connection: close\r\n"));

        let bare = "GET / HTTP/1.1\r\nHost: x\r\n\r\n";
        let out = force_connection_close(bare);
        assert_eq!(out.matches("Connection: close").count(), 1);
    }

    #[test]
    fn header_value_is_case_insensitive_and_trims() {
        let head = "POST / HTTP/1.1\r\nContent-Length:  12 \r\nHost: x\r\n\r\n";
        assert_eq!(header_value(head, "content-length"), Some("12"));
        assert_eq!(header_value(head, "Content-Length"), Some("12"));
        assert_eq!(header_value(head, "missing"), None);
    }

    #[test]
    fn copy_request_body_honors_content_length() {
        // Body has trailing bytes beyond Content-Length that must NOT
        // be copied (they belong to the next request on the stream).
        let head = "POST / HTTP/1.1\r\nContent-Length: 5\r\n\r\n";
        let mut reader = Cursor::new(b"helloEXTRA".to_vec());
        let mut out: Vec<u8> = Vec::new();
        copy_request_body(&mut reader, &mut out, head).unwrap();
        assert_eq!(out, b"hello");
    }

    #[test]
    fn copy_request_body_none_when_no_length() {
        let head = "GET / HTTP/1.1\r\nHost: x\r\n\r\n";
        let mut reader = Cursor::new(b"unexpected".to_vec());
        let mut out: Vec<u8> = Vec::new();
        copy_request_body(&mut reader, &mut out, head).unwrap();
        assert!(out.is_empty());
    }

    #[test]
    fn cred_unconfigured_is_actionable_and_keyless() {
        let mut out: Vec<u8> = Vec::new();
        write_cred_unconfigured(&mut out, "api.anthropic.com").unwrap();
        let resp = String::from_utf8(out).unwrap();
        assert!(resp.starts_with("HTTP/1.1 502 Bad Gateway\r\n"));
        assert!(resp.contains("Connection: close\r\n"));
        assert!(resp.contains("appliance agent login"));
        assert!(resp.contains("api.anthropic.com"));
        // A well-formed Content-Length so the client frames the body.
        assert!(resp.contains("Content-Length: "));
    }

    #[test]
    fn copy_chunked_forwards_body_verbatim() {
        let body = "4\r\nWiki\r\n5\r\npedia\r\n0\r\n\r\n";
        let mut reader = Cursor::new(body.as_bytes().to_vec());
        let mut out: Vec<u8> = Vec::new();
        copy_chunked(&mut reader, &mut out).unwrap();
        assert_eq!(String::from_utf8(out).unwrap(), body);
    }
}
