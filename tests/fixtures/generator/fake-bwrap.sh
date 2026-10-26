#!/bin/sh
# Stand-in bwrap for tests: logs its arguments to $FAKE_BWRAP_LOG (when it is passed in), then runs
# what follows "--".
printf '%s\n' "$@" > "${FAKE_BWRAP_LOG:-/dev/null}"
# Applies --setenv, as bwrap does; mounts nothing.
while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do
  if [ "$1" = "--setenv" ]; then export "$2=$3"; shift 2; fi
  shift
done
shift
exec "$@"
