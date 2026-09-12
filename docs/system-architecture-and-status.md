# phone-agent — System Architecture & Status

> **⚠️ HISTORICAL — device-primitives reference only (last current 2026-08-26).**
> This doc describes the single-priv-app `probe-app/` era, when the Gemini agent
> ran entirely on the phone with no server. The system has since split into
> **`phone-connector/`** (on-device I/O) + **`hermes-core/`** (the VPS brain).
> **Current:** [`../phone-connector/README.md`](../phone-connector/README.md),
> [`../hermes-core/README.md`](../hermes-core/README.md),
> [`../hermes-mcp/README.md`](../hermes-mcp/README.md).
> **Project overview:** [`../README.md`](../README.md).
>
> What is still *live and correct* here: **§3–§5** — the locked "second, non-default
> `InCallService`" architecture decision, the `VOICE_DOWNLINK` capture /
> `TYPE_TELEPHONY` injection primitives, and the priv-app permission/deploy model.
> `phone-connector` is a direct port of exactly those primitives. Everything framed
> below as "current status", "open item", or "not yet built" is about `probe-app/`
> and is superseded — see the two docs above for what is actually built now
> (control link, remote hangup, outbound scripted calls, mic-mute fix, per-call
> personas, the director).

**What this doc was:** the factual state of the single-app system as of
2026-08-26 — what was built, proven live, and still open. Historical
investigation logs (raw ADSP/ALSA forensics, probe-by-probe evidence dumps)
were removed once their conclusions were folded in below.

**Companion docs (historical):**
[`call-control-and-hermes-integration-design.md`](./call-control-and-hermes-integration-design.md) —
the *abandoned* gateway design for hangup / outbound / control link / mic-mute
(superseded; those capabilities were built the `hermes-core` way instead).
[`call-agent-behavior-and-policy-spec.md`](./call-agent-behavior-and-policy-spec.md) —
behavior/policy requirements, since folded into the 2026-09-02 spec.
[`tool-integrations.md`](./tool-integrations.md) — the three on-device Gemini
tools (`append_sheet_row`, `create_calendar_event`, `handoff_to_hermes`), all
**removed** from `phone-connector` (which keeps only a local `end_call`); still
describes `probe-app/` and the Gemini Live function-calling protocol.

---

## 1. Goal

Give a real Android phone an AI agent that can hear and speak on an actual
phone call — not a separate VoIP line, the device's real cellular call —
without forking the stock Dialer or touching closed vendor audio firmware.

## 2. Device under test

| Property | Value |
|---|---|
| Model | Redmi Note 8 (`ginkgo`) |
| SoC | Snapdragon 665 — `SM6125`, platform `trinket` |
| OS | LineageOS 23.2, Android 16 (SDK 36), `arm64-v8a` |
| Root | LineageOS "Rooted debugging" → `adb root` (uid=0). No on-device `su`/Magisk. |
| Sound card | `trinket-idp-snd-card` (ALSA card 0) |

All facts below (mixer names, permission behavior, HAL behavior) are
specific to this build. An OTA or a different device needs re-verification
before assuming any of it still holds.

## 3. Locked architecture decision

**Not** a forked Dialer, **not** a vendor HAL/DSP patch. A separate,
headless, privileged Android system service (`probe-app/`, package
`com.calltap.probe`) taps call audio through the standard privilege-gated
Android call-recording API, running as a **second, non-default
`InCallService`** bound by Telecom alongside the stock Dialer — the Dialer
is never touched, never replaced.

```
┌────────────────────────────┐         ┌──────────────────────────────┐
│ com.android.dialer          │         │ com.calltap.probe             │
│ (STOCK, UNMODIFIED)         │         │ (priv-app, headless, no UI)   │
│  - dialing / UI / hangup    │         │                                │
└──────────────┬─────────────┘         │  InCallService (2nd, non-      │
               │ call events              default) bound via            │
               ▼                          CONTROL_INCALL_EXPERIENCE      │
     Telecom (system_server)  ─────────►  on ACTIVE: AudioRecord(        │
     broadcasts call state to             VOICE_DOWNLINK) opens,         │
     ALL bound InCallServices             streams to Gemini Live API,    │
                                          AudioTrack injects reply back   │
                                          └───────────────┬────────────────┘
                                                           │
                                                           ▼
                                          far party hears the AI directly
                                          (no separate consumer app yet —
                                           the Gemini wiring lives inside
                                           this same priv-app)
```

**Why this shape, not the alternatives** — checked and rejected:

| Option | Verdict | Reason |
|---|---|---|
| Raw ALSA DSP tap (root + `tinymix`/`tinycap`) | ❌ Blocked, proven live | Qualcomm's aDSP refuses a userspace `VOC_REC` open (`ADSP_ENEEDMORE`) on every tested config (sample rate, tap-enable timing, `Voc Rec Config` value). The one port that *does* open from userspace (`AFE-PROXY-TX`) streams only zero-samples. The DSP only arms that tap for the closed vendor HAL's own calibration handshake — not reachable from outside it, independent of root. |
| Fork the stock Dialer app | ❌ Rejected | Couples capture logic to the app used to actually make calls — a bug there risks missed calls/crashes on the daily driver. |
| Patch the vendor audio HAL/DSP firmware | ❌ Rejected | Closed Qualcomm binaries (`audio.primary.trinket.so`, `libacdbloader.so`), not AOSP even on LineageOS. Bad effort/success ratio for a problem the chosen route already solves. |
| **Separate headless `InCallService` priv-app** | ✅ **Chosen, proven live** | Uses only open AOSP/LineageOS framework code. `CAPTURE_AUDIO_OUTPUT` is sufficient for `VOICE_CALL`-family capture on this build (same permission the stock Dialer holds); `CONTROL_INCALL_EXPERIENCE` permits a concurrent non-UI service. Decouples the trusted, rarely-changed capture producer from a fast-iterating consumer. |

Not pursued: hooking vendor telephony/IMS via Frida/Xposed (fragile against
closed, versioned binaries) and modem/RIL-level taps (closed baseband
firmware, not accessible).

## 4. What's proven live today

| Capability | Status | Mechanism |
|---|---|---|
| Second, non-default `InCallService` bound alongside stock Dialer | ✅ Proven | `CONTROL_INCALL_EXPERIENCE`, `android:directBootAware="true"` required on both `<application>` and `<service>` (without it, Telecom's `InCallController` silently never enumerates the package at all — the one deploy bug that cost real iteration time) |
| Far-end audio capture (`VOICE_DOWNLINK`) | ✅ Proven | `AudioRecord(VOICE_DOWNLINK, 16kHz, mono, PCM16)`, real non-silent speech-level audio confirmed (`rms` up to ~6200, `peak` up to ~18800 of 32767 full-scale), zero read errors across thousands of reads, survives call-end→new-call cleanly |
| Audio injection into the live call (far party hears it) | ✅ Proven | `AudioTrack(USAGE_VOICE_COMMUNICATION, CONTENT_TYPE_SPEECH)` with `setPreferredDevice()` pointed at the `TYPE_TELEPHONY` output device, gated behind `MODIFY_PHONE_STATE`. Confirmed audible to a real human on the far end of a live call. Quality tracked cellular signal strength in testing (flawless outdoors/strong signal, degraded indoors/weak signal in one comparison) — not an app-side issue in that comparison. |
| Full conversational AI on a live call | ✅ Proven | Wired to the **Gemini Live API** (`gemini-3.1-flash-live-preview`) via a hand-rolled RFC 6455 WebSocket client over raw `SSLSocket` (`WebSocketClient.java` — no external libraries; the platform has TLS/JSON/Base64 built in but not `java.net.http.WebSocket`). A real back-and-forth conversation through the call, confirmed by a human listener, re-confirmed again live on 2026-08-26 with a full multi-minute session and real tool-skip/transcript logging. |
| Tool/function calling | ✅ Proven, built | See [`tool-integrations.md`](./tool-integrations.md) — three tools built, config-gated, correctly no-op when unconfigured. |
| Priv-app deployment via live remount (dev iteration only) | ✅ Proven on this device | `adb root` + `adb remount` is live-writable here (`AVB verification is disabled`); push APK + `privapp-permissions-calltap.xml` to `/product/priv-app/`+`/product/etc/permissions/`, `adb reboot` (priv-app grants are only scanned at boot). `RECORD_AUDIO` granted post-boot via `adb shell pm grant`. **A real production deploy still needs a planned `/product` image build + reboot** — `ro.control_privapp_permissions=enforce` and `ro.debuggable=0` mean this live-remount shortcut is a dev-iteration convenience, not the production install path. |

**Data flow as built today:**
```
InCallService(ACTIVE) → AudioRecord(VOICE_DOWNLINK, 16kHz) → GeminiLiveClient (WebSocket)
    → Gemini Live API (STT+LLM+TTS internally, gemini-3.1-flash-live-preview)
    → 24kHz PCM reply → AudioTrack(TYPE_TELEPHONY) → far party hears it
```
No separate STT/LLM/TTS components — Gemini Live absorbs all three into one
bidirectional audio stream. No separate consumer app yet either — the
Gemini wiring lives directly inside the priv-app (`CallProbeService`), not
split out behind an authenticated local transport.

## 5. Permissions in use

| Permission | Protection level | Gates | Allowlist entry needed? |
|---|---|---|---|
| `CAPTURE_AUDIO_OUTPUT` | signature\|privileged | `VOICE_DOWNLINK`/`VOICE_UPLINK`/`VOICE_CALL` capture | Yes — in `privapp-permissions-calltap.xml` |
| `CONTROL_INCALL_EXPERIENCE` | signature\|privileged\|role | Concurrent non-default `InCallService` | Yes |
| `MODIFY_PHONE_STATE` | signature\|privileged | Uplink audio injection via `setPreferredDevice()` | Yes |
| `RECORD_AUDIO` | dangerous | `AudioRecord` in general | No — granted via `adb shell pm grant` post-boot |
| `READ_PHONE_STATE` | dangerous | Call state | No |
| `INTERNET` | normal | Gemini Live API, tool HTTP calls | No |

`CALL_AUDIO_INTERCEPTION` was investigated and confirmed **not** required
for ordinary `VOICE_CALL`-family capture on this build — the stock Dialer's
own working capture client holds only `CAPTURE_AUDIO_OUTPUT`. Reserve it
only if a future call-redirection feature specifically needs it.

## 6. Quality & latency

- **Audio quality (capture path):** near-lossless relative to the call
  itself — this is a HAL-level buffer tap, not a re-recording, so the only
  ceiling is whatever the call's own codec (AMR-NB/AMR-WB/EVS) already
  imposes.
- **Latency:** capture-path (DSP→HAL→`AudioRecord`) is estimated
  ~20–100ms based on typical Qualcomm HAL buffering behavior — **not
  directly measured yet** (no tone/click correlation test has been run).
  This is dwarfed by the Gemini round-trip (STT+LLM+TTS), which is the real
  latency budget owner for how conversational the call feels — also not
  formally measured, though live use has felt acceptable in testing.
- **Consent/legality:** call recording/interception law varies by
  jurisdiction (one-party vs. all-party consent). This project targets the
  device owner's own phone/number; any broader use (especially outbound
  AI-scripted calls to third parties, or persisting far-party transcripts)
  needs its own deliberate consent/disclosure review — not assumed safe by
  default. See [`call-agent-behavior-and-policy-spec.md`](./call-agent-behavior-and-policy-spec.md)
  §5 for the specific open item this raises for call logging.

## 7. Known open items / risks

> **Status note (2026-09-05):** several items below are resolved in
> `phone-connector/` — remote hangup + reason taxonomy, outbound scripted calls,
> the mic-mute bugfix, per-call personas from `hermes-core`, and a persistent
> reconnecting control link all shipped and were live-tested on `ginkgo`. The
> Gemini realtime latency is under active investigation — see
> [`../phone-connector/LATENCY.md`](../phone-connector/LATENCY.md). The items
> below are kept as the `probe-app/`-era record.

- **No reconnect-on-drop** for the Gemini session — a session-resumption
  handle is received from the API but currently unused.
- **Latency not formally measured** — see §6.
- **True concurrent capture untested** — only one capture client (this
  service) has been exercised at a time; whether a second simultaneous
  `AudioRecord` client would conflict on this HAL's `voice_rx` port is
  unverified.
- **`VOICE_UPLINK`/`VOICE_CALL` (near-end audio) capture untested** — only
  `VOICE_DOWNLINK` (far-end) has actually been exercised. Same API family,
  same permissions, expected to work the same way, not yet probed.
- **No authenticated transport to a separate consumer app** — the Gemini
  agent currently lives directly inside the priv-app rather than behind an
  authenticated local IPC boundary to an unprivileged, fast-iterating
  companion app.
- **Two live-observed anomalies, not yet root-caused (found 2026-08-26,
  live verification session):**
  - The downlink capture loop's local RMS/peak logging reads `0.0`/`0` on
    every single chunk even during a call where real speech was
    successfully transcribed by Gemini seconds later — looks like a
    logging-path bug (the audio itself is clearly arriving), not actual
    silence. Worth a dedicated look; not otherwise affecting functionality
    as far as observed.
  - `AS.AudioService` logged `AudioHardening background playback would be
    muted for com.calltap.probe` several times during a live session's
    playback. Worth checking whether Android's background-audio-hardening
    policy is clipping any of the AI's replies — plausible contributor to
    the "audio quality was bad" reports this project has been chasing,
    independent of the already-identified mic-mute bug and cellular
    signal-strength factor.
- **Per-device/per-build fragility** — all mixer names, permission
  behavior, and closed-blob behavior in §3 are specific to this
  `trinket`/LineageOS 23.2 build; an OTA or different device needs the
  underlying recon re-run before trusting any of it.
- **Non-rooted phones** — out of scope entirely for now. A non-rooted
  fallback would mean mic/speaker-bleed capture (significantly worse
  quality: room acoustics, echo, ambient noise) rather than this HAL-level
  tap — deferred until the rooted path is fully built and measured.

## 8. Possible future directions (uncommitted ideas, not designed)

Everything below reuses the exact same proven baseline (capture + inject +
Gemini Live) — none of it requires new architecture, just new logic on top
of what's already running. Not committed, not scoped, listed only so the
ideas aren't lost:

- Live captions / real-time translation subtitles for the far party's speech
- Automatic call notes, summaries, or a searchable call archive
- Scam/spoofing content detection with a mid-call warning
- Spam/robocall flagging and do-not-disturb automation from call metadata
  alone (no audio needed for this one)
- Voice biometrics / caller verification
- A call-based personal CRM/journal

Each of these would need its own explicit legal/consent review before
building (§6) — this project's existing posture only clearly covers the
device owner's own calls.
