#!/bin/sh
# Stand-in bwrap for tests: logs its arguments to $FAKE_BWRAP_LOG, then runs what follows "--".
printf '%s\n' "$@" > "$FAKE_BWRAP_LOG"
while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done
shift
exec "$@"
