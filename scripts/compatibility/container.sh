#!/usr/bin/env bash
# Development/CI only: tool installation is confined to a disposable container.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
# Ubuntu's disposable-image hook deletes .deb files after install. Retain only
# downloaded packages in the CI-mounted cache; always refresh package indexes.
rm -f /etc/apt/apt.conf.d/docker-clean
apt-get -o Acquire::Retries=3 update -qq
apt-get -o Acquire::Retries=3 install -y --no-install-recommends \
  qemu-system-x86 gdb nasm gcc binutils ca-certificates
apt-get autoclean -qq
exec node /repo/scripts/compatibility/runner.cjs \
  --label "${COMPATIBILITY_LABEL:-container}" --output /results
