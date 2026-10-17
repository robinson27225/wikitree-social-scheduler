#!/bin/sh
# The data disk is mounted as root. Make it writable for the app, then run the app as the unprivileged "node" user.
set -e
mkdir -p "${SOCIAL_SCHEDULER_DATA:-/data}"
chown -R node:node "${SOCIAL_SCHEDULER_DATA:-/data}"
exec gosu node "$@"
