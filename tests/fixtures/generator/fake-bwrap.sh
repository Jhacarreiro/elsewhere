#!/bin/sh
# Stand-in bwrap for tests: logs its arguments to $FAKE_BWRAP_LOG (when it is passed in), then runs
# what follows "--".
printf '%s\n' "$@" > "${FAKE_BWRAP_LOG:-/dev/null}"
while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done
shift
exec "$@"
