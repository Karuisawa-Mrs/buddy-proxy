#!/usr/bin/env bash
# Record the upstream responses into fixtures.
#
#   test/capture.sh
#
# Runs the whole matrix against the real upstreams through a recording proxy,
# so every response the router saw is written down. The mock server replays
# them afterwards, which is what the test runs against.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PROXY_PORT="${PROXY_PORT:-6699}"
FIXTURES="$ROOT/test/fixtures"
# Logs and the new recording live under the repository (gitignored): bash and
# Node resolve "/tmp" to different places on Windows (see test/smoke.sh).
WORK="test/.tmp/capture"
rm -rf "$WORK"
mkdir -p "$WORK"

# The recording goes into a fresh directory (test/fixture-name.ts writes there
# when FIXTURE_DIR_OUT is set) and is copied over the committed fixtures, file
# by file, only when the whole run succeeded. A failed or half-finished run
# leaves the old ones alone.
export FIXTURE_DIR_OUT="$ROOT/$WORK/fixtures"
mkdir -p "$FIXTURE_DIR_OUT"

# Which upstreams answer is decided by the accounts in the gateway's database
# (the panel switches them on), not by peeking into .env here.

# The China region answers slowly and does not go through the proxy, so it is
# recorded on its own.
node --experimental-strip-types test/capture-legacy.ts || true

node --experimental-strip-types test/record-proxy.ts "$PROXY_PORT" > "$WORK/record-proxy.log" 2>&1 &
PROXY_PID=$!

# 网关交给 test/serve.ts：端口由共享 helper 挑，上游指向录制代理。
READY="$WORK/ready.json"
node --experimental-strip-types test/serve.ts --upstream "http://127.0.0.1:$PROXY_PORT" \
  --ready-file "$READY" > "$WORK/capture-serve.log" 2>&1 &
ROUTER_PID=$!

cleanup() {
  kill $ROUTER_PID $PROXY_PID 2>/dev/null
  wait $ROUTER_PID $PROXY_PID 2>/dev/null
}
trap cleanup EXIT

for _ in $(seq 1 120); do
  [ -f "$READY" ] && break
  kill -0 $ROUTER_PID 2>/dev/null || break
  sleep 0.5
done
BASE="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["base"])' "$READY" 2>/dev/null)"
if [ -z "$BASE" ]; then
  echo "the router did not start:"
  tail -20 "$WORK/capture-serve.log"
  exit 1
fi

E2E_SKIP="qoder-cn" bash test/e2e.sh "$BASE"
status=$?

# The China region answers slowly, so the recorder may still be waiting for it.
# Give it a moment to write the answer down before it is stopped.
echo
echo "waiting for the recorder to finish..."
sleep 20

echo
echo "--- recorded ---"
grep recorded "$WORK/record-proxy.log" || echo "(nothing recorded)"

if [ "$status" -ne 0 ] || [ -z "$(ls -A "$FIXTURE_DIR_OUT" 2>/dev/null)" ]; then
  echo
  echo "the run failed or recorded nothing: test/fixtures is left as it was."
  echo "the partial recording is in $FIXTURE_DIR_OUT"
  exit "${status:-1}"
fi

# File by file: a recorded answer replaces its old fixture, and a fixture this
# run did not record (an upstream that was off, a request that was skipped)
# stays. Swapping the whole directory used to drop those.
mkdir -p "$FIXTURES"
updated=()
added=()
for new in "$FIXTURE_DIR_OUT"/*; do
  [ -f "$new" ] || continue
  name="$(basename "$new")"
  if [ -f "$FIXTURES/$name" ]; then updated+=("$name"); else added+=("$name"); fi
  cp -f "$new" "$FIXTURES/$name"
done
kept=()
for old in "$FIXTURES"/*; do
  [ -f "$old" ] || continue
  name="$(basename "$old")"
  [ -f "$FIXTURE_DIR_OUT/$name" ] || kept+=("$name")
done

echo
echo "--- fixtures ---"
echo "updated (${#updated[@]}):"
for n in "${updated[@]}"; do echo "  $n"; done
echo "added (${#added[@]}):"
for n in "${added[@]}"; do echo "  $n"; done
echo "kept, not recorded this run (${#kept[@]}):"
for n in "${kept[@]}"; do echo "  $n"; done
exit $status
