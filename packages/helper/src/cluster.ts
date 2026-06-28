// Default names/ports for the local runtime.
//
// The k3d cluster + sibling-registry lifecycle that used to live here
// (startLocalCluster / stopLocalCluster / image import / registry
// probing, …) was removed when bare k3d was dropped — the microVM is now
// the sole local runtime. These constants survive because the
// in-cluster api-server bootstrap (api-server.ts) and the CLI/desktop
// runtime config still key off them.

// Name recorded for the local runtime's cluster/profile. Retained for
// back-compat with the in-cluster base config; the microVM ignores it.
export const DEFAULT_LOCAL_CLUSTER_NAME = 'appliance-local';
export const DEFAULT_LOCAL_NAMESPACE = 'appliance';
// Host port the runtime's ingress LoadBalancer publishes. Default 8081 —
// keeps clear of the desktop's 1420 dev server and common 8080.
export const DEFAULT_LOCAL_HOST_PORT = 8081;
// Host-side port the in-runtime image registry publishes on. Picked out
// of the way of common dev tools (5000 is occupied by macOS AirPlay
// Receiver on Sequoia+, 5001 by some VPN clients).
export const DEFAULT_LOCAL_REGISTRY_PORT = 5050;
