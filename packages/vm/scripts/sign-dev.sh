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
# vz.entitlements grants com.apple.security.virtualization — required to
# create VMs via Virtualization.framework. Kept comment-free so codesign's
# DER entitlement encoding never trips over XML comments. The desktop app's
# release signing pipeline must apply the same entitlement for distribution.
codesign --force --sign - --entitlements vz.entitlements "$BIN"
echo "signed $BIN with com.apple.security.virtualization"
