# Host-enforced guest egress firewall

**Status:** Design (F0 spike). **Owner-locked.** This document is the contract
F1–F5 build to; it writes no feature code. The decisions in **bold** are
settled — do not relitigate them downstream, refine the _how_.

## 0. Why

Today a microVM's egress is **unconfined**. The guest NIC is a
`VZNATNetworkDeviceAttachment` (`backend/vz/mod.rs:192-201`): the
framework runs NAT internally, the host never sees a packet, and the
guest has a direct, unrestricted path to the internet. The only "egress
control" we have is **cooperative** — `HTTP(S)_PROXY` env vars injected
into dockerd (`guest.rs:451-485`) and into k3s workloads via the
`appliance-egress` ConfigMap (`egress.rs:507-584`). A process that drops
the env, uses `--network host`, dials a raw IP, or speaks a non-HTTP
protocol simply bypasses it. Worse, the **shell-agent path — where Phase
5 agents run — injects no proxy at all**. A rooted guest, or an agent
told to exfiltrate, has nothing in its way.

This design makes the **host the egress boundary**. We replace the
framework NAT with a host-resident userspace TCP/IP netstack that owns
the _only_ path off-box, and force every guest flow through the existing
`egress.rs` allow/deny + MITM/creds machinery. A rooted/jailbroken guest
can forge any frame it likes; it still cannot reach anything except
through our netstack, which forwards a flow only after the allowlist says
yes. The policy stops being a suggestion.

Scope: **all managed microVMs** (agent + dev) on the macOS `VzBackend`.
**Out of scope and explicitly untouched: BYO-k8s and cloud deployment
paths** (§7).

## 1. Netstack choice — **smoltcp**

**Decision: a host-side userspace TCP/IP stack built on
[`smoltcp`](https://github.com/smoltcp-rs/smoltcp)** (pure Rust, MIT),
operated as a transparent terminator in the `tun2proxy` mode: feed it the
guest's raw Ethernet frames, let it terminate every guest TCP connection
locally, and forward the accepted byte-stream into `egress.rs`.

Evaluated:

| Option                      | TCP correctness                                                                                          | Integration                                                                                    | Maintenance                          | Verdict    |
| --------------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------ | ---------- |
| **smoltcp**                 | Good — window scaling, reassembly, RTO, used in anger by `tun2proxy`, embedded fleets                    | In-process pure-Rust crate; preserves the single-binary `VzBackend` ethos                      | One crate, active, no FFI            | **Chosen** |
| gVisor `netstack/tcpip`     | Excellent — conformance-grade                                                                            | Go. CGo FFI is heavy and loses the single static binary, or it runs as a sidecar process + IPC | Large Go dep tree, language boundary | Rejected   |
| Hand-rolled L3/L4 forwarder | The hard part — SACK/RTO/window-scaling/reassembly/RST/MSS is months of work and a permanent bug surface | Trivial deps                                                                                   | We own a TCP stack forever           | Rejected   |

**Rationale (one paragraph).** The genuinely hard, correctness-critical
part of this project is terminating arbitrary guest TCP correctly at line
rate; everything else (DHCP-for-one-host, a DNS forwarder, the allowlist)
is small. smoltcp gives us exactly that hard part as a vetted, pure-Rust,
in-process library, and the `tun2proxy` project is a direct existence
proof of the shape we need — take raw IP/Ethernet from one side, accept
connections to _arbitrary_ destination addresses, and splice them to a
proxy. gVisor's stack is more conformant but Go: pulling it in means
either CGo (kills our single signed Mach-O and complicates the
entitlement story) or a sidecar process, both of which betray the
in-process `VZVirtualMachine` model the backend is built around. Rolling
our own TCP is the classic trap the brief flags — we would reimplement
smoltcp, worse, and maintain it. smoltcp's only gaps for us are that its
DHCP and DNS sockets are _client_-side; we supply a ~50-line DHCP
responder and a small DNS forwarder ourselves (§3), which is trivial next
to a TCP stack.

smoltcp runs **one instance per VM**, on the per-VM thread that already
owns guest-facing host services (`guest.rs:831`). It is not shared
across VMs — each VM has its own netstack bound to its own link, which
also structurally closes the cross-VM key-theft window the current
`peer_allowed`/`should_intercept` guards work around (§8).

## 2. The file-handle link

**Decision: swap `VZNATNetworkDeviceAttachment` →
`VZFileHandleNetworkDeviceAttachment`** (`backend/vz/mod.rs:194-201`),
backed by a `socketpair`, with the host end owned by the smoltcp
netstack.

### 2.1 Creating + wiring the fd

```
let (host_fd, vz_fd) = socketpair(AF_UNIX, SOCK_DGRAM, 0);   // two ends
// vz end → NSFileHandle → the attachment → the virtio-net device:
let nsfh = NSFileHandle::initWithFileDescriptor_closeOnDealloc(vz_fd, true);
let attach = VZFileHandleNetworkDeviceAttachment::initWithFileHandle(&nsfh);
attach.setMaximumTransmissionUnit(1500);                     // F1: keep 1500
net.setAttachment(Some(&attach));
// host_fd → the netstack's smoltcp Device (read/write raw frames).
```

The binding is already vendored (`objc2-virtualization` 0.3.2:
`VZFileHandleNetworkDeviceAttachment::initWithFileHandle`,
`setMaximumTransmissionUnit`); F1 only adds the
`VZFileHandleNetworkDeviceAttachment` + `NSFileHandle` cargo features
next to the existing network features in `packages/vm/Cargo.toml:33-49`.

### 2.2 Frame flow (host ↔ guest)

`VZFileHandleNetworkDeviceAttachment`'s contract is **one datagram = one
raw Ethernet frame** (full L2, no length prefix). That is exactly why the
link is `SOCK_DGRAM`, not `SOCK_STREAM`: the framework relies on datagram
boundaries to delimit frames, and a stream socket would force us to
re-frame a byte pipe the framework does not length-prefix.

- **Guest → host (TX):** the framework `write()`s each frame the guest's
  virtio-net emits to its end; the netstack `read()`s it from `host_fd`
  and pushes it into smoltcp as a received frame.
- **Host → guest (RX):** smoltcp produces a frame to transmit; the
  netstack `write()`s it to `host_fd`; the framework delivers it to the
  guest's virtio-net RX queue.

The netstack is the guest's L2 peer: it answers ARP for the gateway
address, owns the gateway MAC, and routes every IP packet through its
sockets. There is **no second NIC and no NAT** — `host_fd` is the entire
world the guest's NIC can see.

### 2.3 Link hygiene (tracked, finalized in F5)

- **Socket buffers.** DGRAM socketpair defaults are small; a burst of
  full-MTU frames can drop silently. Raise `SO_SNDBUF`/`SO_RCVBUF` on
  both ends and drain `host_fd` promptly on a dedicated reader.
- **Checksum offload.** virtio-net commonly offloads L4 checksums, so
  guest→host frames can arrive with zero/partial checksums. smoltcp must
  be configured to **not reject** RX checksums (`ChecksumCapabilities`)
  and to **compute** them on TX, or the guest must disable offload
  (`ethtool -K eth0 tx off rx off`). We take the netstack-side option so
  the guest needs no cooperation.
- **MTU.** Keep 1500 in F1 for parity and to avoid PMTU surprises; revisit
  larger MTU for throughput in F5.

## 3. DHCP + DNS (host-side, replacing the framework)

With NAT gone, the framework no longer leases the guest an address or
answers DNS — the netstack must. Both live inside the per-VM netstack on
a fixed private subnet (we pick our own deterministic /24, e.g.
`192.168.127.0/24`, gateway/host `=.1`, so the existing
`guest_proxy_url` "gateway is `.1`" assumption in `egress.rs:449-459`
still holds).

**DHCP (the lease).** A minimal single-client DHCP responder: the guest
DHCPs in initramfs (`ip=dhcp`, `guest.rs:638`), we answer DISCOVER/REQUEST
for the VM's known MAC with a fixed lease — `192.168.127.2/24`,
`router=192.168.127.1`, `dns=192.168.127.1`. **Because the netstack
_assigns_ the lease, the guest IP is known deterministically the instant
it is handed out** (indeed a-priori, since we allocate it per VM).

> **This replaces the `/var/db/dhcpd_leases` scrape entirely**
> (`net.rs:23-112`, `discover_guest_ip`). No plist parsing, no 120 s
> poll, no MAC-lookup race. The netstack writes `guest-ip` at lease-grant
> time (the same file `egress.rs` and the forwards already read), and
> `discover_guest_ip` collapses to "read the IP the netstack assigned."

**DNS (the resolver).** The netstack listens on UDP/53 **and** TCP/53 at
`192.168.127.1`. It is a forwarding resolver: it consults the
`EgressPolicy` allowlist for the queried name, and for **allowed** names
forwards to the host's real resolver (host `getaddrinfo` / system DNS),
returning the answer to the guest; **denied** names get `NXDOMAIN`/refused.

**DNS's role — defense-in-depth + UX, NOT the boundary.** DNS filtering
is bypassable on its own (a guest can hardcode IPs or speak DoH to an
allowed host), so we never _rely_ on it. We filter DNS anyway because it
(1) fails non-allowlisted egress fast and legibly instead of as an opaque
TCP timeout, (2) means the only nameserver the guest can reach is ours —
DNS-tunnelling to an arbitrary resolver is just another flow that hits
default-deny, and (3) lets us remember `name → resolved A/AAAA` so a
later raw-IP connect can be back-referenced to the allowlisted name it
came from (§4). The hard boundary is still the TCP terminator.

## 4. Transparent forward + classification

The netstack accepts **every** guest TCP SYN to **any** destination
IP:port and terminates it locally (smoltcp listening socket on the catch-
all). On accept we know `dst_ip:dst_port`; we then classify and feed
**allowed** flows into the existing `egress.rs` core (reused wholesale —
`EgressPolicy::allows()`/`host_matches()`, `mitm.rs` SNI extraction at
`mitm.rs:135`, `creds.rs`):

- **443 / TLS ports** — peek the TLS ClientHello, extract **SNI**
  (`hello.server_name()`, `mitm.rs:135`). Allowlist by SNI. Allowed →
  hand the terminated stream to the existing tunnel path as if it were a
  `CONNECT sni:443`: `EgressPolicy::allows()` → `should_intercept` →
  blind splice **or** `mitm::intercept` (+ `creds`) exactly as today.
- **80 / HTTP** — read the request head, take the **Host** header,
  allowlist by Host, feed the plain-HTTP forward path.
- **Raw IP / non-TLS / non-HTTP / other ports** — **default-deny.**
  Three escape hatches, all opt-in: (a) the dst IP matches an A/AAAA we
  resolved for an _allowlisted_ name within a short TTL (the legitimate
  "app dialed the IP our DNS just gave it" case); (b) an explicit
  **IP/CIDR allow rule** in `EgressPolicy.allow`; otherwise refuse.
- **UDP (non-DNS)** — **default-deny in F2.** This denies QUIC/HTTP-3 on
  UDP/443; well-behaved clients fall back to TCP/443 (which we _can_
  SNI-inspect), so this is a feature, not a regression. Revisit as a
  policy knob in F5. DNS to the gateway (`.1:53`) is the one allowed UDP.

This is the load-bearing reuse: the netstack's accept path is a new
_front door_ onto the **same** allow/deny + MITM/creds core that
`egress.rs::handle_conn` already implements (F3 extracts that core so
both share it).

## 5. Default-deny + the sane default allowlist

**Decision: flip `EgressPolicy` default `Allow → Deny`**
(`egress.rs:41-46`; the data model and the
`default_deny_blocks_unless_allowlisted` test already exist) in **F2**,
and ship a baked default allowlist for fresh VMs:

```
# api / model
api.anthropic.com
# alpine packages
dl-cdn.alpinelinux.org
# language package registries
registry.npmjs.org                       # npm
pypi.org   files.pythonhosted.org        # pip
crates.io  static.crates.io              # cargo
# git
github.com  codeload.github.com  *.githubusercontent.com
# container registries
registry-1.docker.io  auth.docker.io  production.cloudflare.docker.com  ghcr.io
```

(Suffix-matched by `host_matches` — `github.com` already covers
`api.github.com`; `*.githubusercontent.com` is the wildcard the matcher
handles as the `githubusercontent.com` suffix.)

**Exclusions — never policed, always local** (mirrors and extends
`default_no_proxy`, `egress.rs:492-494`): loopback (`127.0.0.0/8`, `::1`,
`localhost`); the k3s pod/service CIDRs `10.42.0.0/16` & `10.43.0.0/16`;
`.svc` / `.svc.cluster.local`; the docker bridge `172.17.0.0/16`. **Most
of these never reach the host link at all** — pod-to-pod (`10.42`),
service (`10.43`), and docker-bridge (`172.17`) traffic is _intra-guest_
and is switched inside the guest kernel; it never crosses `host_fd`, so
default-deny at the boundary structurally cannot touch it. That is
precisely why in-VM k3s keeps working under a host-side firewall (§7
risk). The exclusions are belt-and-suspenders for any such packet that
_does_ reach the netstack (e.g. addressed to the gateway).

The in-guest cooperative layer (the `appliance-egress` ConfigMap +
dockerd env, `egress.rs:507-584`, `guest.rs:451-485`) **stays** — it now
sits _behind_ the hard host boundary as defense-in-depth (and keeps
giving workloads a tidy `HTTPS_PROXY` rather than relying on transparent
interception for everything), but it is no longer load-bearing for
confinement.

## 6. Published-port inbound forwarding

Inbound forwarding (`net.rs:spawn_proxy`, wired in `guest.rs:848-863`)
must keep working: api `:6443`, ingress `:80`, registry NodePort, the
`30000-30050` window, and the dev `published` ports
(`spec.rs:PublishedPort`).

Today `spawn_proxy` does `TcpStream::connect((guest_ip, port))` — the OS
routes that over the vz NAT subnet. **Under the new link there is no OS
route to the guest** (the guest lives entirely inside our userspace
stack). So the inbound path is re-homed: the netstack exposes a
**`connect(guest_ip, port) -> host-side stream`** primitive (smoltcp
originates a SYN to the guest as a client), and `spawn_proxy` dials
_through the netstack_ instead of the OS TCP stack. The listener side
(`127.0.0.1:<hostPort>`) and the bidirectional `pump` are unchanged; only
the "connect to guest" leg swaps from `TcpStream::connect` to
`netstack.connect`. This is the one change point for point 6, and it is
covered by F1 (behavior-neutral): published ports must work identically
before any filtering is added.

## 7. Rollout / migration (LOAD-BEARING)

This swaps the network for **every managed microVM**, so it ships staged
and flag-gated, behavior-neutral first.

**Feature flag:** a per-VM spec field **`VmSpec.net_link: { Nat,
Netstack }`** (serde default `Nat` in F1→F3, flipped to `Netstack` in
F4). Per-VM so existing VMs keep NAT until recreated; a global
`APPLIANCE_NETSTACK=1` env override for testing/CI. The `Nat` path stays
compiled and selectable for one release after the default flips, as the
escape hatch.

**Build contracts (one line each):**

- **F1 — Behavior-neutral host netstack (default-ALLOW, opt-in).** Swap
  NAT → `VZFileHandleNetworkDeviceAttachment` over a `socketpair(DGRAM)`;
  smoltcp netstack with the single-client DHCP responder (deterministic
  lease → writes `guest-ip`, **deletes the `dhcpd_leases` scrape**),
  forwarding DNS, and transparent TCP terminate-and-forward upstream with
  **every flow allowed**; re-home `net.rs` inbound forwards through the
  netstack `connect`. Gated `net_link=Netstack`. **Accept:** boot, DNS,
  k3s `Ready`, kubeconfig handoff, and published ports are identical to
  NAT — zero breakage.
- **F2 — Default-deny + allowlist filtering.** Flip
  `EgressPolicy::default()` → `Deny`; bake the §5 allowlist + exclusions;
  classify SNI(443)/Host(80)/IP(raw) on the accept path through
  `EgressPolicy::allows()`; non-TLS/non-HTTP/raw-IP → default-deny (+ the
  DNS-backref & IP/CIDR opt-ins); DNS resolver enforces the allowlist as
  fast-fail. **Accept:** allowlisted endpoints (apk/npm/pip/cargo/git/
  docker/anthropic) succeed; everything else is refused, including raw-IP
  and a proxy-env-dropping process.
- **F3 — Unify the policy core.** Extract `serve_tunnel(name, host, port,
stream)` / `serve_http(name, host, stream)` from
  `egress.rs::handle_conn` so the netstack accept-path and the legacy
  CONNECT proxy share one allow/deny + `mitm::intercept` + `creds` core;
  move the egress proxy off its `0.0.0.0` TCP listener
  (`main.rs:581-582`) to per-VM in-process/loopback-only invocation
  (closes the open-proxy + sibling-reachability surface, §8).
- **F4 — Netstack becomes the default.** Flip `net_link` default →
  `Netstack` for all managed microVMs (agent + dev); NAT remains
  selectable for one release; `doctor`/`up` surface the active link.
  **BYO-k8s + cloud paths stay on their current networking, untouched.**
- **F5 — Hardening + observability.** Checksum/MTU/offload handling,
  socketpair buffer tuning, fuzz the hostile-frame parser, per-VM
  netstack panic isolation, deny/allow events into the existing `traffic`
  view, finalize UDP/QUIC policy, throughput validation, then retire NAT.

**Untouched (must not regress):**

- **BYO-k8s** — runs against the user's own cluster; never starts the vz
  link, must not get default-deny and must not depend on the netstack.
- **Cloud deployment / promotion** (`docs/cloud-promotion-contract.md`,
  `control-plane.md`) — a different runtime entirely; the egress firewall
  is a local-`VzBackend`-only concern and must not touch it.
- The k3d runtime and the in-guest cooperative egress ConfigMap remain as
  they are (the latter demoted to defense-in-depth, §5).

**Risk list:**

1. **DNS** — correctness/latency of the host forwarder; must answer fast
   (initramfs and apk are sensitive to slow DNS) and not deadlock on the
   host resolver. Mitigate: short upstream timeouts, cache, TCP/53 too.
2. **k3s in-VM** — relies on intra-guest pod/service traffic _never_
   crossing the link (§5). Verify with a multi-pod workload under
   default-deny; a regression here breaks the cluster silently.
3. **Published ports** — the re-homed `netstack.connect` inbound leg is a
   new code path for ingress/api/registry/NodePort/dev-published; prove
   it in F1 before any filtering lands.
4. **MTU / checksums on the virtio link** — offloaded/zero checksums and
   datagram-socket frame drops are the most likely "works then mysteriously
   stalls" failure; handle checksum capabilities + buffer sizing
   explicitly (§2.3), don't assume.

## 8. Security

**The boundary today** is cooperative and effectively absent: NAT gives
the guest direct egress, the only control is `HTTP(S)_PROXY` env a
process can drop, and the agent/shell path injects nothing. A rooted
guest has unrestricted egress.

**The boundary after** is the host netstack at the hypervisor link. The
guest's NIC is wired to a single `SOCK_DGRAM` socketpair whose only peer
is our smoltcp instance. There is **no NAT, no second NIC, no host route**
from the guest subnet to anything. A rooted/jailbroken guest can forge
arbitrary Ethernet/IP/TCP frames, drop the proxy env, use `--network
host`, dial a raw IP, or speak a custom protocol — and every one of those
frames still arrives in our userspace netstack, which **forwards a flow
only after `EgressPolicy::allows()` returns true** for its SNI/Host/IP.
Default-deny means the unclassifiable cases fail closed. **There is no
other path off-box**, which is the property the brief requires.

A structural bonus: because each VM has its **own** netstack and its
**own** link, a sibling VM cannot reach this VM's egress proxy at all —
the cross-VM brokered-key-theft window that `peer_allowed` /
`should_intercept` defend against (`egress.rs:386-424`) closes by
construction once F3 moves the proxy off `0.0.0.0` to per-VM in-process.

**Residual risks (for Sasha to gate):**

1. **Covert/allowed-channel exfil.** Allowlisting controls _where_, not
   _what_. An agent can still tunnel data out through an allowed host
   (a GitHub gist, an Anthropic request body) or via timing. MITM/creds
   only inspect _brokered_ hosts; allowed-but-blind hosts are opaque
   tunnels by design (to preserve streaming/keep-alive). This firewall
   shrinks the egress surface to a known allowlist; it is not DLP.
2. **DNS / IP back-reference.** The `name→IP` back-ref (§4) is a
   deliberate, time-boxed hole so raw-IP connects to allowlisted hosts
   work; a guest that races the TTL could ride it to a non-allowlisted IP
   that briefly shared a resolved address. Keep the TTL short; treat IP
   allow as coarse.
3. **The host process is now in the data path.** A netstack bug is a
   confinement bug. smoltcp's track record mitigates, but the frame
   parser ingests hostile input from a rooted guest — it must be fuzzed
   (F5). A panic is a per-VM DoS (per-VM thread), not host compromise,
   but note it.
4. **QUIC/UDP.** Denied by default (good — we can't easily SNI-inspect
   QUIC); if a future policy allows UDP/443, inspection is weaker than
   TCP. Decision deferred to F5 as an explicit knob.
5. **The gateway resolver reaches the host's DNS.** The guest's only
   nameserver is ours, which forwards to the host resolver — scope what
   the host resolver itself can reach so the forwarder isn't an oracle
   for the host's internal network.
