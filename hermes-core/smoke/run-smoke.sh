#!/usr/bin/env bash
# Phase 1 end-to-end smoke: boots hermes-core (Postgres-backed, in-process PGlite
# here), runs the mock phone through a scripted call against the real Gemini Live
# API, asserts the call + transcript + director actions persisted, tears down.
#
# Run it as a single foreground command: `bash smoke/run-smoke.sh`
set -uo pipefail
cd "$(dirname "$0")/.."

SCENARIO="${1:-smoke/scenarios/reception.json}"
PORT="${HERMES_PORT:-8787}"

# Fresh in-process PGlite each boot — no external Postgres needed for the smoke.
export DATABASE_URL=""

echo "== starting hermes-core =="
TSX="./node_modules/.bin/tsx"; [ -x "$TSX" ] || TSX="npx tsx"
$TSX src/main.ts &
CORE_PID=$!
cleanup() {
  pkill -P "$CORE_PID" 2>/dev/null || true
  kill "$CORE_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

for _ in $(seq 1 60); do
  curl -sf "http://localhost:$PORT/health" >/dev/null 2>&1 && break
  sleep 0.25
done
curl -s "http://localhost:$PORT/health"; echo

echo
echo "== running mock phone: $SCENARIO =="
node smoke/mock-phone.mjs --scenario "$SCENARIO"
RC=$?

echo
echo "== final call log =="
curl -s "http://localhost:$PORT/calls" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{for(const c of JSON.parse(d||"[]"))console.log(`${c.id} ${c.direction} ${c.status} ${c.endReason??""}`)})'

echo
echo "== persistence check =="
LAST=$(curl -s "http://localhost:$PORT/calls" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const a=JSON.parse(d||"[]");process.stdout.write(a[0]?.id??"")})')
if [ -z "$LAST" ]; then
  echo "FAIL: no calls persisted"
  exit 1
fi
curl -s "http://localhost:$PORT/calls/$LAST" | node -e '
  let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
    const c=JSON.parse(d);
    const ok = c.transcript.length>0 && c.actions.length>0 && c.status==="ended";
    console.log(`call ${c.id}: ${c.transcript.length} turns, ${c.actions.length} actions, status=${c.status}`);
    process.exit(ok?0:1);
  })'
PERSIST_RC=$?

[ "$RC" -eq 0 ] && exit $PERSIST_RC || exit $RC
