//! A forwarding DNS resolver for the guest.
//!
//! With NAT gone the framework no longer answers DNS, so the netstack
//! does: it listens at the gateway (`.1:53`) and forwards the guest's
//! query to the host's real resolver, returning the answer verbatim.
//!
//! **F1 scope.** This stage resolves normally — it is behaviour-neutral.
//! The anti-SSRF / private-range answer filter and the allowlist-name
//! filter are F2 (the pre-F2 blocker, docs/egress-firewall.md §8.1 #1);
//! the [`allowed`] hook below is the stub they replace. We forward only
//! to the host's own resolvers (local DNS), never to a guest-steerable
//! address — the classifier already drops any UDP/53 not aimed at the
//! gateway, so there is no guest-steerable passthrough.

use std::net::{Ipv4Addr, SocketAddr, UdpSocket};
use std::time::Duration;

/// Upstream lookups are bounded so a slow/hostile resolver can neither
/// stall the netstack nor (in F2) serve as an internal-host timing
/// oracle.
pub const UPSTREAM_TIMEOUT: Duration = Duration::from_secs(5);

/// F1 filter hook — resolve everything. F2 replaces this with the
/// allowlist-name check and the private-range answer reject (§8.1 #1).
pub fn allowed(_name: &Option<String>) -> bool {
    true
}

/// The host's configured resolvers, parsed from `/etc/resolv.conf`
/// (`nameserver <ip>` lines). Falls back to a public resolver only when
/// the file names none, so the guest always has working DNS.
pub fn system_resolvers() -> Vec<SocketAddr> {
    let mut out = Vec::new();
    if let Ok(conf) = std::fs::read_to_string("/etc/resolv.conf") {
        for line in conf.lines() {
            let line = line.trim();
            if let Some(rest) = line.strip_prefix("nameserver") {
                if let Ok(ip) = rest.trim().parse::<std::net::IpAddr>() {
                    out.push(SocketAddr::new(ip, 53));
                }
            }
        }
    }
    if out.is_empty() {
        out.push(SocketAddr::new(Ipv4Addr::new(1, 1, 1, 1).into(), 53));
    }
    out
}

/// Forward one query to the first responsive upstream and return its
/// raw response. Bounded by [`UPSTREAM_TIMEOUT`]; `None` if no upstream
/// answers in time. Each call uses its own ephemeral socket so concurrent
/// queries can't cross responses.
pub fn forward(query: &[u8], upstreams: &[SocketAddr], timeout: Duration) -> Option<Vec<u8>> {
    let sock = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).ok()?;
    sock.set_read_timeout(Some(timeout)).ok()?;
    for up in upstreams {
        if sock.send_to(query, up).is_err() {
            continue;
        }
        let mut buf = vec![0u8; 4096];
        match sock.recv_from(&mut buf) {
            Ok((n, from)) if from.ip() == up.ip() && n >= 2 => {
                // Match the transaction id so a stray datagram can't be
                // mistaken for this query's answer.
                if n >= 2 && query.len() >= 2 && buf[0..2] == query[0..2] {
                    buf.truncate(n);
                    return Some(buf);
                }
            }
            _ => continue,
        }
    }
    None
}

/// Extract the first question's QNAME (dotted, lowercased) for logging
/// and the F2 allowlist check. Bounded and panic-free; compression
/// pointers are not followed (a query's QNAME is never compressed).
pub fn query_name(query: &[u8]) -> Option<String> {
    // Header is 12 bytes; the first question's labels start at 12.
    if query.len() < 12 {
        return None;
    }
    let mut i = 12usize;
    let mut labels: Vec<String> = Vec::new();
    loop {
        let len = *query.get(i)? as usize;
        if len == 0 {
            break;
        }
        // 0xC0 top bits mark a compression pointer — not expected in a
        // question; bail rather than chase it.
        if len & 0xC0 != 0 {
            return None;
        }
        let start = i + 1;
        let end = start.checked_add(len)?;
        if end > query.len() || labels.len() > 127 {
            return None;
        }
        labels.push(String::from_utf8_lossy(&query[start..end]).to_ascii_lowercase());
        i = end;
    }
    if labels.is_empty() {
        None
    } else {
        Some(labels.join("."))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `example.com` A query (id 0x1234).
    fn example_query() -> Vec<u8> {
        let mut q = vec![0x12, 0x34, 0x01, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0];
        for label in ["example", "com"] {
            q.push(label.len() as u8);
            q.extend_from_slice(label.as_bytes());
        }
        q.push(0); // root
        q.extend_from_slice(&[0x00, 0x01, 0x00, 0x01]); // QTYPE A, QCLASS IN
        q
    }

    #[test]
    fn extracts_query_name() {
        assert_eq!(query_name(&example_query()).as_deref(), Some("example.com"));
    }

    #[test]
    fn query_name_bounded_on_garbage() {
        assert_eq!(query_name(&[]), None);
        assert_eq!(query_name(&[0u8; 5]), None);
        // A label length running past the end yields None, not a panic.
        let mut q = vec![0u8; 12];
        q.push(200); // claims 200 bytes
        q.extend_from_slice(b"short");
        assert_eq!(query_name(&q), None);
        // A compression pointer in the question is refused.
        let mut q = vec![0u8; 12];
        q.push(0xC0);
        q.push(0x0C);
        assert_eq!(query_name(&q), None);
    }

    #[test]
    fn fuzz_query_name_never_panics() {
        let mut seed = 0xb5297a4d_u64;
        for _ in 0..10_000 {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            let len = (seed as usize) % 300;
            let q: Vec<u8> = (0..len).map(|i| (seed >> (i % 56)) as u8).collect();
            let _ = query_name(&q);
        }
    }

    #[test]
    fn forward_relays_to_a_mock_upstream() {
        // Stand up a tiny UDP "resolver" that echoes the query id + a
        // canned answer, then prove forward() round-trips through it.
        let upstream = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let addr = upstream.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let mut buf = [0u8; 1500];
            let (n, peer) = upstream.recv_from(&mut buf).unwrap();
            // Reply: echo the 2-byte id, set the response bit, append a marker.
            let mut resp = buf[..n].to_vec();
            resp[2] |= 0x80;
            resp.extend_from_slice(b"ANSWER");
            upstream.send_to(&resp, peer).unwrap();
        });

        let resp = forward(&example_query(), &[addr], UPSTREAM_TIMEOUT).expect("a response");
        assert_eq!(&resp[0..2], &[0x12, 0x34], "transaction id echoed");
        assert!(resp.ends_with(b"ANSWER"));
        server.join().unwrap();
    }

    #[test]
    fn forward_times_out_when_no_upstream_answers() {
        // A bound-but-silent socket: forward() must give up, not hang
        // forever. Use a very short window via a black-hole port.
        let black_hole = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let addr = black_hole.local_addr().unwrap();
        drop(black_hole); // nothing listening now
        let started = std::time::Instant::now();
        // A short timeout bounds the wait; the call must give up (None),
        // never hang.
        let out = forward(&example_query(), &[addr], Duration::from_millis(150));
        assert!(out.is_none());
        assert!(started.elapsed() < Duration::from_secs(2), "forward must respect the timeout");
    }
}
