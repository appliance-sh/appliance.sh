#!/bin/bash
# Apply the virtualization entitlement to a locally built appliance-vm
# with an ad-hoc signature. Creating VMs via Virtualization.framework
# is entitlement-gated; cargo doesn't sign, so run this after build:
#
#   cargo build [--release] && ./scripts/sign-dev.sh [--release]
set -euo pipefail
cd "$(dirname "$0")/.."
PROFILE=debug
[ "${1:-}" = "--release" ] && PROFILE=release
BIN="target/$PROFILE/appliance-vm"
codesign --force --sign - --entitlements vz.entitlements "$BIN"
echo "signed $BIN with com.apple.security.virtualization"
