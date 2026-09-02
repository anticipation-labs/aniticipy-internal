#!/bin/sh
# Prepares the data volume, then drops root if it can.
#
# Railway mounts the persistent volume as root. The database file must be
# writable by whoever runs the process, so ownership is fixed here rather than
# baked into the image, where a later mount would mask it.
set -e

DATA_DIR="${DATA_DIR:-/data}"
mkdir -p "$DATA_DIR"

if [ "$(id -u)" = "0" ]; then
  chown -R node:node "$DATA_DIR" 2>/dev/null || true
  # setpriv ships with util-linux in the Debian base image. If it is ever
  # absent, running as root beats failing to boot, so fall through instead.
  if command -v setpriv >/dev/null 2>&1; then
    exec setpriv --reuid=node --regid=node --init-groups node dist-server/index.mjs
  fi
fi

exec node dist-server/index.mjs
