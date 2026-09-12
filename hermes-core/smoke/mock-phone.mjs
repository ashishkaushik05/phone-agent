// Phase 0 smoke harness: stands in for the Android phone-connector.
//
// Real device  : AudioRecord(VOICE_DOWNLINK) <-> Gemini Live <-> AudioTrack(TELEPHONY)
// This harness  : scripted caller text turns  <-> Gemini Live <-> transcript to stdout
//
// It exercises the full hermes-core loop: link up, persona handoff, transcript relay,
// director-triggered <<DIRECTOR>> inject, and remote hangup — with no phone, no audio.
//
//   node smoke/mock-phone.mjs --scenario smoke/scenarios/reception.json
//
// Outbound: start this with --outbound, then POST /calls to hermes-core in another
// shell. The mock phone waits for the resulting call.place, adopts its call_id and
// system_instruction (the caller-side script), dials, and plays scenario.caller_lines
// as the FAR party:
//   node smoke/mock-phone.mjs --outbound --scenario smoke/scenarios/angry-customer.json
//   curl -XPOST localhost:8787/calls -H 'authorization: Bearer smoke-token' \
//     -H 'content-type: application/json' -d '{"to":"+15551230000","script":"..."}'

import fs from "node:fs";
import { WebSocket as WsClient } from "ws";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(
  process.argv.slice(2).flatMap((a, i, arr) => (a.startsWith("--") ? [[a.slice(2), arr[i + 1] ?? true]] : [])),
);

const env = readFileSync(join(here, "..", "..", ".env"), "utf8");
const GEMINI_KEY = env.split("\n").find((l) => l.startsWith("gemini_key="))?.slice(11).trim().replace(/^["']|["']$/g, "");
const PORT = process.env.HERMES_PORT ?? 8787;
const TOKEN = process.env.PHONE_AGENT_CONTROL_TOKEN ?? "smoke-token";
const MODEL = "models/gemini-3.1-flash-live-preview";
const DEVICE_ID = args["device-id"] ?? "mock-phone";
let CALL_ID = `smoke-${DEVICE_ID}-${Date.now()}`; // overwritten by call.place in outbound mode

const scenario = args.scenario
  ? JSON.parse(fs.readFileSync(args.scenario, "utf8"))
  : { from: "+15559999999", caller_lines: ["Hello?", "Okay, thanks. Bye."] };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- link to hermes-core -----------------------------------------------------
const link = new WsClient(`ws://localhost:${PORT}/phone`, { headers: { authorization: `Bearer ${TOKEN}` } });
const up = (m) => link.send(JSON.stringify(m));
const injectQueue = [];
let systemInstruction = null;
let hangupRequested = null;
let placed = null; // { call_id, to } once hermes-core pushes call.place

const linkReady = new Promise((resolve) => {
  link.on("open", () => up({ type: "hello", device_id: DEVICE_ID }));
  link.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type === "hello_ack") { console.log(`[mock-phone] hello_ack ${m.device_id ?? ""}`); return resolve(); }
    if (m.type === "call.accept" || m.type === "call.place") systemInstruction = m.system_instruction;
    if (m.type === "call.place") { placed = { call_id: m.call_id, to: m.to }; CALL_ID = m.call_id; }
    if (m.type === "call.inject") injectQueue.push(m.text);
    if (m.type === "call.hangup") hangupRequested = m.reason;
  });
  link.on("error", (e) => { console.error("[mock-phone] link error", e.message); process.exit(1); });
});

// ---- Gemini Live session ----------------------------------------------------
function openGemini(system) {
  const ws = new WebSocket(
    `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(GEMINI_KEY)}`,
  );
  const api = { ws, ready: null, _turnText: "", _resolveTurn: null };
  api.ready = new Promise((resolve, reject) => {
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({
        setup: {
          model: MODEL,
          generationConfig: { responseModalities: ["AUDIO"] },
          outputAudioTranscription: {},
          systemInstruction: { parts: [{ text: system }] },
        },
      }));
    });
    ws.addEventListener("message", async (ev) => {
      const buf = ev.data instanceof Blob ? Buffer.from(await ev.data.arrayBuffer()) : Buffer.from(ev.data);
      let msg; try { msg = JSON.parse(buf.toString("utf8")); } catch { return; }
      if (msg.setupComplete) return resolve();
      if (msg.error) return reject(new Error(JSON.stringify(msg.error)));
      const sc = msg.serverContent;
      if (!sc) return;
      if (sc.outputTranscription?.text) api._turnText += sc.outputTranscription.text;
      if (sc.turnComplete && api._resolveTurn) {
        const t = api._turnText.trim();
        api._turnText = "";
        const r = api._resolveTurn; api._resolveTurn = null;
        r(t);
      }
    });
    ws.addEventListener("close", (e) => { if (e.code !== 1000) console.error("[gemini] closed", e.code, e.reason); });
  });
  /** send one user turn, resolve with the model's spoken (transcribed) reply */
  api.turn = (text) =>
    new Promise((resolve) => {
      api._resolveTurn = resolve;
      ws.send(JSON.stringify({ clientContent: { turns: [{ role: "user", parts: [{ text }] }], turnComplete: true } }));
    });
  return api;
}

// ---- run -------------------------------------------------------------------
async function main() {
  await linkReady;
  console.log("[mock-phone] link up");

  const outbound = Boolean(args.outbound);
  if (outbound) {
    // hermes-core drives outbound: it emits call.place (with the call_id and the
    // caller-side script) when POST /calls arrives. Wait for it, then dial.
    console.log("[mock-phone] outbound — waiting for call.place (POST /calls to hermes-core)");
    for (let i = 0; i < 600 && !placed; i++) await sleep(50);
    if (!placed) { console.error("[mock-phone] no call.place after 30s — did you POST /calls?"); process.exit(1); }
    console.log(`[mock-phone] call.place ${placed.call_id} -> ${placed.to}`);
    up({ type: "call.dialing", device_id: DEVICE_ID, call_id: CALL_ID, to: placed.to });
  } else {
    up({ type: "call.inbound", device_id: DEVICE_ID, call_id: CALL_ID, from: scenario.from });
  }

  // wait for persona handoff
  for (let i = 0; i < 40 && !systemInstruction; i++) await sleep(50);
  if (!systemInstruction) {
    systemInstruction = "You are a phone receptionist. Keep replies short.";
    console.log("[mock-phone] no persona from core, using fallback");
  }

  const gem = openGemini(systemInstruction);
  await gem.ready;
  up({ type: "call.active", device_id: DEVICE_ID, call_id: CALL_ID });
  console.log("[mock-phone] gemini session active\n");

  for (const line of scenario.caller_lines) {
    if (hangupRequested) break;

    // drain any pending director injections first (at a turn boundary)
    while (injectQueue.length) {
      const note = injectQueue.shift();
      const spoken = await gem.turn(note);
      up({ type: "transcript", device_id: DEVICE_ID, call_id: CALL_ID, role: "agent", text: spoken, ts: Date.now() });
      await sleep(1200);
      if (hangupRequested) break;
    }
    if (hangupRequested) break;

    up({ type: "transcript", device_id: DEVICE_ID, call_id: CALL_ID, role: "caller", text: line, ts: Date.now() });
    const spoken = await gem.turn(line);
    up({ type: "transcript", device_id: DEVICE_ID, call_id: CALL_ID, role: "agent", text: spoken, ts: Date.now() });

    // give the async director a moment to react before the next caller line
    await sleep(1600);
  }

  // final drain (e.g. a closing/hangup inject queued after the last line)
  while (injectQueue.length && !hangupRequested) {
    const note = injectQueue.shift();
    const spoken = await gem.turn(note);
    up({ type: "transcript", device_id: DEVICE_ID, call_id: CALL_ID, role: "agent", text: spoken, ts: Date.now() });
    await sleep(1500);
  }
  if (hangupRequested) await sleep(500);

  const reason = hangupRequested ?? "far_party";
  const lastAgent = [...(scenario.caller_lines ?? [])].length ? "scenario complete" : "no lines";
  up({ type: "call.ended", device_id: DEVICE_ID, call_id: CALL_ID, reason, summary: `mock scenario finished (${lastAgent})` });
  console.log(`\n[mock-phone] call.ended (${reason})`);
  await sleep(300);
  gem.ws.close();
  link.close();
  process.exit(0);
}

main().catch((e) => { console.error("[mock-phone] fatal", e); process.exit(1); });
