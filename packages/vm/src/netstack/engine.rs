//! The per-VM smoltcp driver loop (unix only).
//!
//! Owns the host end of the guest's `socketpair` link and a single
//! smoltcp `Interface`. Per iteration it: drains the fd of guest frames,
//! answers DHCP/DNS at the raw layer, feeds ARP + TCP to smoltcp,
//! terminates every guest TCP flow, and bridges each to an external peer
//! (an upstream `TcpStream` for guest-originated flows; the host
//! listener for inbound published ports). **F1 is behaviour-neutral
//! default-ALLOW** — every flow is forwarded, no policy yet.
//!
//! All work runs on one thread, wrapped by the caller in `catch_unwind`,
//! so a panic is contained to this VM (§8.1 #5).

use super::frame::{self, Class};
use super::{Bridge, BridgeStream, ConnectRequest, LinkConfig, Netstack};
use smoltcp::iface::{Config, Interface, SocketHandle, SocketSet};
use smoltcp::phy::{Checksum, ChecksumCapabilities, Device, DeviceCapabilities, Medium, RxToken, TxToken};
use smoltcp::socket::tcp;
use smoltcp::time::Instant as SmolInstant;
use smoltcp::wire::{EthernetAddress, HardwareAddress, IpAddress, IpCidr, IpEndpoint, IpListenEndpoint};
use std::collections::{HashMap, VecDeque};
use std::net::{Ipv4Addr, SocketAddr};
use std::os::fd::RawFd;
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// SO_SNDBUF on the link ends. Apple wants SO_RCVBUF ≥ 2× (ideally 4×)
/// SO_SNDBUF for the file-handle attachment (§2.3).
const SND_BUF: libc::c_int = 256 * 1024;
const RCV_BUF: libc::c_int = 1024 * 1024;
/// Per-flow smoltcp socket buffer (each direction).
const TCP_BUF: usize = 64 * 1024;
/// Cap on frames drained from the fd per iteration (bounds work).
const RX_BATCH: usize = 256;
/// Loop wait cap (ms): bounds added latency for bridge data that
/// smoltcp's own `poll_delay` can't see. Throughput tuning is F5.
const WAIT_CAP_MS: i32 = 5;

/// Create the `socketpair(AF_UNIX, SOCK_DGRAM)` link. Returns
/// `(host_fd, vz_fd)`: the host end (owned by the netstack, made
/// non-blocking) and the guest/framework end (handed to the
/// `VZFileHandleNetworkDeviceAttachment`).
pub fn make_link() -> std::io::Result<(RawFd, RawFd)> {
    let mut fds = [0 as libc::c_int; 2];
    let rc = unsafe { libc::socketpair(libc::AF_UNIX, libc::SOCK_DGRAM, 0, fds.as_mut_ptr()) };
    if rc != 0 {
        return Err(std::io::Error::last_os_error());
    }
    let (host_fd, vz_fd) = (fds[0], fds[1]);
    for &fd in &[host_fd, vz_fd] {
        set_buf(fd, libc::SO_SNDBUF, SND_BUF);
        set_buf(fd, libc::SO_RCVBUF, RCV_BUF);
    }
    // Host end non-blocking so the engine drains without stalling on it.
    unsafe {
        let flags = libc::fcntl(host_fd, libc::F_GETFL);
        libc::fcntl(host_fd, libc::F_SETFL, flags | libc::O_NONBLOCK);
    }
    Ok((host_fd, vz_fd))
}

fn set_buf(fd: RawFd, name: libc::c_int, val: libc::c_int) {
    unsafe {
        libc::setsockopt(
            fd,
            libc::SOL_SOCKET,
            name,
            &val as *const libc::c_int as *const libc::c_void,
            std::mem::size_of::<libc::c_int>() as libc::socklen_t,
        );
    }
}

/// Start the per-VM netstack on its own (panic-isolated) thread and
/// return the handle. The thread owns `host_fd` and closes it on exit.
pub fn start(host_fd: RawFd, cfg: LinkConfig) -> Netstack {
    let (connect_tx, connect_rx) = channel::<ConnectRequest>();
    let guest_ip = cfg.guest_ip;
    let mac = cfg.guest_mac;
    let _ = std::thread::Builder::new()
        .name(format!(
            "netstack-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
            mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]
        ))
        .spawn(move || {
            let ok = super::run_isolated(std::panic::AssertUnwindSafe(|| {
                engine_loop(host_fd, cfg, connect_rx);
            }));
            if !ok {
                eprintln!(
                    "netstack: per-VM engine panicked — link down for this VM only (host + siblings unaffected)"
                );
            }
            unsafe { libc::close(host_fd) };
        });
    Netstack { guest_ip, connect_tx }
}

// --- the smoltcp phy device over the host fd ------------------------

struct FdDevice {
    fd: RawFd,
    /// Guest frames staged by the driver for smoltcp to ingest. Filled
    /// from the fd each iteration; drained by `receive`.
    rx: VecDeque<Vec<u8>>,
}

struct RxTok {
    frame: Vec<u8>,
}
struct TxTok {
    fd: RawFd,
}

impl RxToken for RxTok {
    fn consume<R, F: FnOnce(&[u8]) -> R>(self, f: F) -> R {
        f(&self.frame)
    }
}

impl TxToken for TxTok {
    fn consume<R, F: FnOnce(&mut [u8]) -> R>(self, len: usize, f: F) -> R {
        let mut buf = vec![0u8; len];
        let r = f(&mut buf);
        // One datagram == one Ethernet frame (the SOCK_DGRAM contract).
        // A full send buffer (EAGAIN) drops the frame; TCP retransmits.
        unsafe {
            libc::send(self.fd, buf.as_ptr() as *const libc::c_void, len, 0);
        }
        r
    }
}

impl Device for FdDevice {
    type RxToken<'a> = RxTok;
    type TxToken<'a> = TxTok;

    fn receive(&mut self, _t: SmolInstant) -> Option<(Self::RxToken<'_>, Self::TxToken<'_>)> {
        self.rx
            .pop_front()
            .map(|frame| (RxTok { frame }, TxTok { fd: self.fd }))
    }

    fn transmit(&mut self, _t: SmolInstant) -> Option<Self::TxToken<'_>> {
        Some(TxTok { fd: self.fd })
    }

    fn capabilities(&self) -> DeviceCapabilities {
        let mut caps = DeviceCapabilities::default();
        caps.medium = Medium::Ethernet;
        caps.max_transmission_unit = super::LINK_MTU + 14; // + Ethernet header
                                                           // RX: do NOT verify — virtio-net offloads L4 checksums, so
                                                           // guest→host frames arrive with zero/partial checksums (§2.3).
                                                           // TX: compute, since the guest's stack verifies on receive.
        let mut cs = ChecksumCapabilities::ignored();
        cs.ipv4 = Checksum::Tx;
        cs.tcp = Checksum::Tx;
        cs.udp = Checksum::Tx;
        caps.checksum = cs;
        caps
    }
}

// --- flow bookkeeping ------------------------------------------------

type Tuple = (Ipv4Addr, u16, Ipv4Addr, u16);

enum FlowKind {
    /// Guest-originated (outbound): we terminated the guest's SYN and
    /// forward to `dst` upstream once established.
    Terminated { dst: SocketAddr, upstream_spawned: bool },
    /// Host-originated (inbound published port): the bridge's ext side is
    /// already held by the `connect()` caller.
    Originated,
}

struct Flow {
    bridge: Arc<Mutex<Bridge>>,
    kind: FlowKind,
    tuple: Option<Tuple>,
}

fn tcp_socket() -> tcp::Socket<'static> {
    tcp::Socket::new(
        tcp::SocketBuffer::new(vec![0u8; TCP_BUF]),
        tcp::SocketBuffer::new(vec![0u8; TCP_BUF]),
    )
}

fn smol_now(start: Instant) -> SmolInstant {
    SmolInstant::from_millis(start.elapsed().as_millis() as i64)
}

fn engine_loop(host_fd: RawFd, cfg: LinkConfig, connect_rx: Receiver<ConnectRequest>) {
    let start = Instant::now();
    let mut device = FdDevice {
        fd: host_fd,
        rx: VecDeque::new(),
    };

    let mut config = Config::new(HardwareAddress::Ethernet(EthernetAddress(cfg.gateway_mac)));
    config.random_seed = seed();
    let mut iface = Interface::new(config, &mut device, smol_now(start));
    iface.update_ip_addrs(|addrs| {
        let _ = addrs.push(IpCidr::new(IpAddress::Ipv4(cfg.gateway_ip), super::PREFIX_LEN));
    });
    // Default route via our own gateway address + AnyIP: the guest's
    // frames to public IPs arrive addressed to the gateway MAC but with a
    // foreign dst IP; this is what makes smoltcp accept and terminate
    // them (the transparent-terminator trick).
    let _ = iface.routes_mut().add_default_ipv4_route(cfg.gateway_ip);
    iface.set_any_ip(true);

    let mut sockets = SocketSet::new(Vec::new());
    let mut flows: HashMap<SocketHandle, Flow> = HashMap::new();
    let mut by_tuple: HashMap<Tuple, SocketHandle> = HashMap::new();
    let mut next_local_port: u16 = 49152;

    // DNS replies built off-thread are posted back here so only the
    // engine thread writes the fd.
    let (outframe_tx, outframe_rx) = channel::<Vec<u8>>();

    loop {
        // 1. Inbound connect requests (published ports) → originate sockets.
        while let Ok(req) = connect_rx.try_recv() {
            let mut sock = tcp_socket();
            let local = next_local_port;
            next_local_port = next_local_port.checked_add(1).filter(|p| *p != 0).unwrap_or(49152);
            let remote = IpEndpoint::new(IpAddress::Ipv4(cfg.guest_ip), req.port);
            match sock.connect(iface.context(), remote, local) {
                Ok(()) => {
                    let handle = sockets.add(sock);
                    flows.insert(
                        handle,
                        Flow {
                            bridge: req.bridge,
                            kind: FlowKind::Originated,
                            tuple: None,
                        },
                    );
                }
                Err(_) => {
                    if let Ok(mut b) = req.bridge.lock() {
                        b.aborted = true;
                    }
                }
            }
        }

        // 2. Drain guest frames, classify, answer DHCP/DNS, feed the rest.
        for f in read_frames(host_fd) {
            match frame::classify(&f, cfg.gateway_ip) {
                Class::Dhcp => answer_dhcp(&f, &cfg, host_fd),
                Class::Dns { src_ip, src_port } => {
                    spawn_dns(&f, src_ip, src_port, &cfg, outframe_tx.clone())
                }
                Class::Tcp(seg) => {
                    if seg.is_syn {
                        // Pre-create the LISTEN socket on the exact dst so
                        // the interface delivers the SYN instead of RSTing
                        // it. Dedupe by 4-tuple so a retransmitted SYN
                        // doesn't spawn a second socket.
                        if let std::collections::hash_map::Entry::Vacant(e) =
                            by_tuple.entry(seg.tuple())
                        {
                            let mut sock = tcp_socket();
                            let _ = sock.listen(IpListenEndpoint {
                                addr: Some(IpAddress::Ipv4(seg.dst_ip)),
                                port: seg.dst_port,
                            });
                            let handle = sockets.add(sock);
                            flows.insert(
                                handle,
                                Flow {
                                    bridge: Arc::new(Mutex::new(Bridge::default())),
                                    kind: FlowKind::Terminated {
                                        dst: SocketAddr::new(seg.dst_ip.into(), seg.dst_port),
                                        upstream_spawned: false,
                                    },
                                    tuple: Some(seg.tuple()),
                                },
                            );
                            e.insert(handle);
                        }
                    }
                    device.rx.push_back(f);
                }
                Class::Passthrough => device.rx.push_back(f),
                Class::Drop => {}
            }
        }

        // 3. Process ingress (sockets receive) + egress (device transmits).
        iface.poll(smol_now(start), &mut device, &mut sockets);

        // 4. Shuttle bytes between each socket and its bridge; start
        //    upstreams for newly-established outbound flows.
        let handles: Vec<SocketHandle> = flows.keys().copied().collect();
        let mut dead: Vec<SocketHandle> = Vec::new();
        for handle in handles {
            if service_flow(handle, &mut flows, &mut sockets) {
                dead.push(handle);
            }
        }

        // 5. Flush anything queued into sockets in step 4.
        iface.poll(smol_now(start), &mut device, &mut sockets);

        // 6. Emit DNS replies (engine-thread-only fd writes).
        while let Ok(out) = outframe_rx.try_recv() {
            send_frame(host_fd, &out);
        }

        // 7. Reap dead flows.
        for handle in dead {
            if let Some(flow) = flows.remove(&handle) {
                if let Some(t) = flow.tuple {
                    by_tuple.remove(&t);
                }
                // Any waiter on this flow must unblock with an error
                // rather than hang.
                if let Ok(mut b) = flow.bridge.lock() {
                    if !b.established {
                        b.aborted = true;
                    }
                }
            }
            sockets.remove(handle);
        }

        // 8. Wait for the next frame or a short cap (so bridge data, which
        //    smoltcp's poll_delay can't see, still moves promptly).
        let delay = iface
            .poll_delay(smol_now(start), &sockets)
            .map(|d| d.total_millis() as i32)
            .unwrap_or(WAIT_CAP_MS)
            .clamp(0, WAIT_CAP_MS);
        wait_readable(host_fd, delay);
    }
}

/// Move bytes between one flow's smoltcp socket and its bridge. Returns
/// `true` when the flow is finished and should be reaped.
fn service_flow(
    handle: SocketHandle,
    flows: &mut HashMap<SocketHandle, Flow>,
    sockets: &mut SocketSet<'static>,
) -> bool {
    let flow = match flows.get_mut(&handle) {
        Some(f) => f,
        None => return true,
    };
    let sock = sockets.get_mut::<tcp::Socket>(handle);
    let bridge_arc = flow.bridge.clone();
    let mut bridge = match bridge_arc.lock() {
        Ok(b) => b,
        Err(_) => return true,
    };

    if !bridge.established && sock.may_send() {
        bridge.established = true;
    }

    // Start the upstream once a terminated (outbound) flow is up.
    if let FlowKind::Terminated { dst, upstream_spawned } = &mut flow.kind {
        if bridge.established && !*upstream_spawned {
            *upstream_spawned = true;
            let dst = *dst;
            let ext = BridgeStream::new(bridge_arc.clone());
            std::thread::spawn(move || match std::net::TcpStream::connect_timeout(&dst, Duration::from_secs(10)) {
                Ok(stream) => super::bridge_pump(ext, stream),
                Err(_) => ext.abort(),
            });
        }
    }

    // guest → ext
    while sock.can_recv() {
        let mut tmp = [0u8; 8192];
        match sock.recv_slice(&mut tmp) {
            Ok(0) | Err(_) => break,
            Ok(n) => bridge.guest_to_ext.extend(tmp[..n].iter().copied()),
        }
    }
    if !sock.may_recv() {
        bridge.guest_fin = true;
    }

    // ext → guest
    while sock.can_send() && !bridge.ext_to_guest.is_empty() {
        let mut tmp = [0u8; 8192];
        let n = bridge.ext_to_guest.len().min(tmp.len());
        for (i, slot) in tmp.iter_mut().enumerate().take(n) {
            *slot = bridge.ext_to_guest[i];
        }
        match sock.send_slice(&tmp[..n]) {
            Ok(0) | Err(_) => break,
            Ok(sent) => {
                bridge.ext_to_guest.drain(..sent);
            }
        }
    }
    if bridge.ext_fin && bridge.ext_to_guest.is_empty() && sock.may_send() {
        sock.close();
    }
    if bridge.aborted && sock.is_open() {
        sock.abort();
    }

    matches!(sock.state(), tcp::State::Closed)
}

fn answer_dhcp(frame: &[u8], cfg: &LinkConfig, fd: RawFd) {
    let Some(payload) = frame::udp_payload(frame) else {
        return;
    };
    let Some(req) = super::dhcp::parse(payload) else {
        return;
    };
    let reply = super::dhcp::build_reply(&req, &cfg.dhcp_lease());
    // Broadcast the OFFER/ACK at L2 (ff:ff:ff:ff:ff:ff) and L3
    // (255.255.255.255): the guest has no address yet and the initramfs
    // DHCP client typically sets the broadcast flag and listens for a
    // broadcast reply. Broadcasting works whether or not the flag is set
    // (one guest on the link), the maximally-compatible choice. Emitted
    // on the engine thread (no fd write contention).
    let out = frame::build_udp_ipv4(
        [0xff; 6],
        cfg.gateway_mac,
        cfg.gateway_ip,
        Ipv4Addr::BROADCAST,
        frame::DHCP_SERVER_PORT,
        frame::DHCP_CLIENT_PORT,
        &reply,
    );
    send_frame(fd, &out);
}

fn spawn_dns(frame: &[u8], src_ip: Ipv4Addr, src_port: u16, cfg: &LinkConfig, out_tx: Sender<Vec<u8>>) {
    let Some(query) = frame::udp_payload(frame) else {
        return;
    };
    let query = query.to_vec();
    let cfg = cfg.clone();
    std::thread::spawn(move || {
        let name = super::dns::query_name(&query);
        // F1: always allowed. F2 adds the allowlist + private-range
        // answer reject here (the §8.1 #1 pre-F2 blocker).
        if !super::dns::allowed(&name) {
            return;
        }
        if let Some(resp) = super::dns::forward(&query, &cfg.dns_upstreams, super::dns::UPSTREAM_TIMEOUT) {
            let out = frame::build_udp_ipv4(
                cfg.guest_mac,
                cfg.gateway_mac,
                cfg.gateway_ip,
                src_ip,
                frame::DNS_PORT,
                src_port,
                &resp,
            );
            let _ = out_tx.send(out);
        }
    });
}

fn read_frames(fd: RawFd) -> Vec<Vec<u8>> {
    let mut out = Vec::new();
    let mut buf = [0u8; 65536];
    for _ in 0..RX_BATCH {
        let n = unsafe { libc::recv(fd, buf.as_mut_ptr() as *mut libc::c_void, buf.len(), 0) };
        if n > 0 {
            out.push(buf[..n as usize].to_vec());
        } else {
            break; // EAGAIN / closed / error
        }
    }
    out
}

fn send_frame(fd: RawFd, frame: &[u8]) {
    unsafe {
        libc::send(fd, frame.as_ptr() as *const libc::c_void, frame.len(), 0);
    }
}

fn wait_readable(fd: RawFd, timeout_ms: i32) {
    let mut pfd = libc::pollfd {
        fd,
        events: libc::POLLIN,
        revents: 0,
    };
    unsafe {
        libc::poll(&mut pfd, 1, timeout_ms);
    }
}

fn seed() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0x1234_5678)
        ^ ((std::process::id() as u64) << 32)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    /// Drive the engine over a real socketpair: write a DHCP DISCOVER as
    /// the "guest" and read back the OFFER the engine builds. Exercises
    /// the whole loop — fd I/O, classification, the DHCP responder, and
    /// frame synthesis — without a VM.
    #[test]
    fn engine_answers_dhcp_over_the_link() {
        let (host_fd, vz_fd) = make_link().unwrap();
        // Give the guest end a read timeout so a regression can't hang CI.
        let tv = libc::timeval { tv_sec: 3, tv_usec: 0 };
        unsafe {
            libc::setsockopt(
                vz_fd,
                libc::SOL_SOCKET,
                libc::SO_RCVTIMEO,
                &tv as *const libc::timeval as *const libc::c_void,
                std::mem::size_of::<libc::timeval>() as libc::socklen_t,
            );
        }

        let mac = [0x52, 0x54, 0x00, 0xaa, 0xbb, 0xcc];
        let cfg = LinkConfig::for_guest_mac("52:54:00:aa:bb:cc");
        let _ns = start(host_fd, cfg);

        // Build a DHCP DISCOVER BOOTP payload.
        let mut bootp = vec![0u8; 240];
        bootp[0] = 1; // BOOTREQUEST
        bootp[4..8].copy_from_slice(&[0x11, 0x22, 0x33, 0x44]); // xid
        bootp[28..34].copy_from_slice(&mac); // chaddr
        bootp[236..240].copy_from_slice(&[99, 130, 83, 99]); // magic cookie
        bootp.extend_from_slice(&[53, 1, 1]); // DHCPDISCOVER
        bootp.push(255);
        let discover = frame::build_udp_ipv4(
            [0xff; 6],
            mac,
            Ipv4Addr::UNSPECIFIED,
            Ipv4Addr::BROADCAST,
            68,
            67,
            &bootp,
        );
        send_frame(vz_fd, &discover);

        // Read the OFFER back off the guest end.
        let mut buf = [0u8; 2048];
        let n = unsafe { libc::recv(vz_fd, buf.as_mut_ptr() as *mut libc::c_void, buf.len(), 0) };
        assert!(n > 0, "engine should have answered the DISCOVER");
        let reply = &buf[..n as usize];
        let offer_payload = frame::udp_payload(reply).expect("a UDP/IPv4 reply frame");
        let req = super::super::dhcp::parse(offer_payload);
        // It's a BOOTREPLY OFFER leasing the deterministic guest IP.
        assert!(req.is_none(), "a reply is not itself a parseable request");
        // yiaddr (offset 16) is the leased guest address.
        assert_eq!(&offer_payload[16..20], &super::super::GUEST_IP.octets());

        unsafe { libc::close(vz_fd) };
        let _ = Duration::from_millis(0);
    }
}
