# Gemini realtime latency — investigation

Status: **diagnosis from code + Checkpoint-D observations; not yet confirmed with instrumented call data.**
Trigger: Checkpoint D — "~9.5 s from setupComplete to first spoken token, plus 20–30 s mid-call
gaps," worst under a bad phone network. User: "we will have to look into that."

## Already ruled out

- **The Muse director / tool calls.** hermes-core is not on the phone↔Gemini audio path. The
  director reads the transcript relay and (E1) pushes a `<<DIRECTOR>>` text turn back over the
  *phone's* Gemini socket. A slow director delays a steer, never the base conversation. Confirmed
  by architecture, not measurement.
- **`end_call` tool blocking the reader thread.** It only posts `Call.disconnect()` to the main
  looper and returns — no I/O.

## The pipeline (agent answering the caller)

```
far party speaks
  → cellular downlink → AudioRecord(VOICE_DOWNLINK, 16k)         [chunk ≥100 ms; buffer minBuf*4]
  → runCapture thread: base64 + JSON + ws.sendText()  ── SYNC, on the capture thread ──┐
                                                                                       │ one TLS socket
  Gemini (generativelanguage.googleapis.com) processes, streams 24k PCM back ──────────┘
  → WebSocketClient reader thread → onAudioChunk → audioOutQueue (cap 32, drop oldest)
  → runPlayback thread: audioOutQueue.take() → AudioTrack.write() (blocks = realtime pacing)
  → TYPE_TELEPHONY uplink → far party hears it
```

## Suspected contributors, most actionable first

### 1. The WS send is synchronous on the capture thread  — **primary, fixable**

`runCapture` calls `geminiClient.sendAudioChunk()` inline every ~100 ms, and that ends in
`out.write()` + `out.flush()` on the TLS socket under `writeLock` (`WebSocketClient.sendFrame`).
When the **uplink** congests, that write blocks. While it's blocked:

- the capture loop isn't calling `recorder.read()`, so `AudioRecord`'s internal buffer
  (`minBuf*4`, a few hundred ms) fills and then **overruns — downlink audio is silently dropped**;
- Gemini receives a gap in the caller's speech and can misread it as end-of-turn or lose context,
  then waits;
- when the socket drains, a burst of now-stale audio is sent, so the model is replying to
  something the caller said seconds ago → the reply feels late.

**Fix:** give `sendAudioChunk` its own bounded queue + a dedicated writer thread (the same shape
`HermesLink` already uses for the link). Under backpressure, **drop the oldest outbound audio**
rather than blocking — send Gemini the freshest audio, skip the backlog. The capture thread then
never stalls and never loses downlink.

### 2. Pre-`setupComplete` audio is dropped, not buffered — **contributes to the 9.5 s**

`sendAudioChunk` returns immediately while `!ready` (GeminiLiveClient.java:179). `startSession`
starts the capture thread and the Gemini connect thread concurrently; on a bad network the
TLS handshake + HTTP upgrade + `setup` round-trip is easily 2–5 s. Every word the caller says in
that window is **gone**, so the model has nothing to answer until the caller speaks again.

**Fix:** hold a small bounded ring (≈ last 2 s) of captured audio while `!ready`; flush it in
order on `onReady()`. Cheap, and it gives the model the caller's opening line.

### 3. Mid-call 20–30 s gaps — TCP stalls on the shared socket — **mostly the network**

Audio-in, audio-out, transcripts and the E1 inject all share one TCP stream. A stalled read
(bad downlink) blocks everything queued behind it (head-of-line blocking); a stalled write backs
up as in (1). 20–30 s is consistent with cellular handover / deep fade + TCP retransmit backoff.

Not fully fixable on-device (it's the link), but (1) stops it from also destroying the *next*
reply, and we should **surface it**: if no server frame for > N s mid-call, log it and consider a
short spoken "one moment" / letting the call proceed rather than dead air.

### 4. AudioRecord / AudioTrack buffers at `minBuf*4` — **minor, easy**

~150–350 ms of pure buffering on each of input and output. Try `minBuf*2`. Measure for
underruns before keeping it.

### 5. Large system instruction — **measure**

`DEFAULT_SYSTEM_INSTRUCTION` + HARD RULES, or a hermes-core persona, is re-grounded every turn.
A voice model's TTFT scales with prompt size. Worth a comparison call with a one-line persona to
see how much of the 9.5 s and the per-turn lag it accounts for.

## Instrumentation to confirm (proposed, additive, no behaviour change)

Add timestamped logs so the next real call produces numbers:

| marker | where |
|---|---|
| `t0` startSession, `t1` ws open, `t2` setupComplete, `t3` first `onAudioChunk`, `t4` first playback write | ConnectorService / GeminiLiveClient |
| time spent inside `ws.sendText` per audio chunk — p50 / p95 over 5 s windows | GeminiLiveClient.sendAudioChunk |
| inter-arrival gap between server frames; warn if > 3 s | WebSocketClient.readLoop |
| `audioOutQueue` depth (already logged) + count of oldest-dropped | ConnectorService.onAudioChunk |

Rising `sendText` p95 ⇒ (1) confirmed. Multi-second frame-arrival gaps ⇒ (3) confirmed.

## Recommended order

1. Land the instrumentation (additive) → one instrumented call → confirm.
2. Async outbound audio writer + drop-oldest backpressure (fix 1). Biggest expected win.
3. Pre-`setupComplete` ring buffer (fix 2).
4. Tune buffer multipliers + a stale-link log (fixes 4, 3-surfacing).
5. Persona-size comparison call (fix 5).

None of 2–5 is in the current plan's scope; they'd be a follow-up task after Phase G, or folded in
if the checkpoints show the latency makes the calls unusable.
