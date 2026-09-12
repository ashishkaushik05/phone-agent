#!/usr/bin/env bash
# Phase A end-to-end smoke: boots hermes-core (in-process PGlite), runs TWO mock
# phones concurrently — phone-a (reception.json) and phone-b (quick.json) — each
# through a scripted call against the real Gemini Live + Muse director APIs, then
# asserts both calls persisted with the right deviceId, transcript and actions.
#
# Run it as a single foreground command: `bash smoke/run-multi-device-smoke.sh`
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${HERMES_PORT:-8787}"
BASE="http://localhost:$PORT"
export DATABASE_URL=""

TMP="$(mktemp -d)"

echo "== starting hermes-core =="
TSX="./node_modules/.bin/tsx"; [ -x "$TSX" ] || TSX="npx tsx"
$TSX src/main.ts &
CORE_PID=$!
PID_A=""
PID_B=""
cleanup() {
  [ -n "$PID_A" ] && kill "$PID_A" 2>/dev/null || true
  [ -n "$PID_B" ] && kill "$PID_B" 2>/dev/null || true
  pkill -P "$CORE_PID" 2>/dev/null || true
  kill "$CORE_PID" 2>/dev/null || true
  rm -rf "$TMP"
}
trap cleanup EXIT INT TERM

for _ in $(seq 1 120); do
  curl -sf "$BASE/health" >/dev/null 2>&1 && break
  sleep 0.25
done
curl -sf "$BASE/health" >/dev/null || { echo "hermes-core /health never came up"; exit 1; }
curl -s "$BASE/health"; echo

echo
echo "== running mock phones: phone-a (reception) + phone-b (quick) =="
node smoke/mock-phone.mjs --device-id phone-a --scenario smoke/scenarios/reception.json > "$TMP/a.log" 2>&1 &
PID_A=$!
node smoke/mock-phone.mjs --device-id phone-b --scenario smoke/scenarios/quick.json > "$TMP/b.log" 2>&1 &
PID_B=$!

RC_A=0; wait "$PID_A" || RC_A=$?
RC_B=0; wait "$PID_B" || RC_B=$?
PID_A=""; PID_B=""
echo "mock-phone exit codes: phone-a=$RC_A phone-b=$RC_B"

echo
echo "== final call log =="
curl -s "$BASE/calls" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{for(const c of JSON.parse(d||"[]"))console.log(`${c.id} ${c.deviceId} ${c.direction} ${c.status} ${c.endReason??""}`)})'

echo
echo "== assertions =="
FAIL=0

if [ "$RC_A" -ne 0 ] || [ "$RC_B" -ne 0 ]; then
  echo "FAIL: a mock-phone exited non-zero (phone-a=$RC_A phone-b=$RC_B)"
  FAIL=1
fi

LIST="$(curl -s "$BASE/calls")"
IDS="$(printf '%s' "$LIST" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const a=JSON.parse(d||"[]");process.stdout.write(a.map(c=>c.id).join("\n"))})')"

printf '%s' "$LIST" | node -e '
  let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
    const a=JSON.parse(d||"[]");
    const devs=a.map(c=>c.deviceId).sort();
    const ok = a.length===2 && JSON.stringify(devs)===JSON.stringify(["phone-a","phone-b"]);
    if(!ok){console.log(`FAIL: expected 2 calls {phone-a,phone-b}, got ${a.length} [${devs.join(",")}]`);process.exit(1);}
    console.log(`ok: 2 calls, deviceIds {${devs.join(",")}}`);
  })' || FAIL=1

while IFS= read -r id; do
  [ -z "$id" ] && continue
  curl -s "$BASE/calls/$id" | node -e '
    let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
      const c=JSON.parse(d);
      const ok = c.transcript.length>0 && c.actions.length>=1 && c.status==="ended";
      console.log(`${c.id} ${c.deviceId} turns=${c.transcript.length} actions=${c.actions.length} status=${c.status}`);
      process.exit(ok?0:1);
    })' || FAIL=1
done <<< "$IDS"

if [ "$FAIL" -ne 0 ]; then
  echo
  echo "== phone-a log tail =="; tail -n 40 "$TMP/a.log"
  echo
  echo "== phone-b log tail =="; tail -n 40 "$TMP/b.log"
  echo
  echo "MULTI-DEVICE SMOKE: FAIL"
  exit 1
fi

echo
echo "MULTI-DEVICE SMOKE: PASS"
exit 0
