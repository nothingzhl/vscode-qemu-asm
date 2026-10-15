#!/usr/bin/env bash
# Development/CI only: tool installation is confined to a disposable container.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get -o Acquire::Retries=3 update -qq
apt-get -o Acquire::Retries=3 install -y --no-install-recommends \
  qemu-system-x86 gdb nasm gcc binutils ca-certificates
exec node /repo/scripts/compatibility/runner.cjs \
  --label "${COMPATIBILITY_LABEL:-container}" --output /results
