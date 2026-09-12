# phone-connector

The on-device half of the Hermes phone system (see [`../README.md`](../README.md)).
An Android **priv-app** `InCallService` (`com.hermes.connector`) that makes a real
cellular call — inbound or outbound — driven by Gemini Live and steered by the
`hermes-core` director over one persistent WebSocket.

It is **dumb I/O**. It captures `VOICE_DOWNLINK`, streams it to Gemini Live,
injects Gemini's reply into `TYPE_TELEPHONY`, relays the transcript to
`hermes-core`, and obeys `call.accept` / `call.inject` / `call.hangup` /
`call.place` commands. The only Gemini tool it declares is a local `end_call`;
every other capability is a `hermes-core` director tool.

Ported from the original single-app prototype, which proved the audio pipeline live
(2026-08-26/27). The `InCallService` architecture decision and the capture/inject
primitives are documented in
[`../docs/system-architecture-and-status.md`](../docs/system-architecture-and-status.md)
§3–§5.

## Status — live-tested on device `ginkgo`, 2026-09-05

| Checkpoint | What | Status |
|---|---|---|
| B | Service binds as a 2nd `InCallService`, captures downlink audio | ✅ live |
| C | `HermesLink` foreground service, persistent WSS, reconnect + backoff, boot self-heal | ✅ live |
| D | Inbound call through the link: persona handoff (3s local fallback), auto-answer, lifecycle events, transcript relay | ✅ live |
| E1 | Director inject → queued to a turn boundary → fed to Gemini silently | ✅ live |
| E2 | Remote hangup with reason taxonomy | ✅ live |
| E3 | Mic-mute for the session, restored on every teardown path | ✅ live |
| F1 / F2 | Outbound `call.place` → dial → attach; 20s dial-timeout (`dial_timeout`) vs unanswered ring (`far_party`) | ✅ live |
| G1 | Max-call-duration watchdog (`MAX_CALL_MS`) | ⚠️ **code-complete, unit-tested, not yet confirmed on a real call** — blocked by a recurring `cause=1 ERROR` dial flake; deferred with the owner's go-ahead, connector redeployed at the default `max_call_ms=600000` |
| SMS | `SmsBridge` (outbound via `SmsManager`) + `SmsReceiver` (`SMS_RECEIVED` → `sms.inbound`), non-default SMS app, `SEND_SMS`/`RECEIVE_SMS` granted via `pm grant`. | ✅ **live-tested on `ginkgo`, 2026-09-12** — see checklist below. |

### SMS on-device checklist (2026-09-12)

| # | Check | Result |
|---|---|---|
| 1 | Outbound — dashboard/API send → arrives, status `queued → sent → delivered` | ✅ Pass |
| 2 | Inbound — text `ginkgo` → thread updates live, no refresh | ✅ Pass |
| 3 | Long message (244 chars, multipart) — reassembles as one bubble both directions | ✅ Pass |
| 4 | Queue survives disconnect, replays on reconnect (`hello` → `resendPendingSms`) | ⚠️ Not independently reproduced live — the existing WSS survives `adb reverse --remove-all` (only new connections are affected) and `POST /sms` requires the device to already be registry-connected, so a live "queued while truly offline" state couldn't be forced by hand. Mechanism is unit-tested (`call-engine.test.ts`) and wired in `server.ts`'s `hello` handler. |
| 5 | Failure path — recipient in airplane mode → `sent` then `failed`, error surfaced | ✅ Pass — `error: "resultCode=2"` |
| 6 | Process-death gap (known v1 limitation) — inbound SMS while force-stopped is missed, no crash | ⚠️ Timing couldn't be pinned by hand (the reply landed at/after the restart); no crash observed either way |

**Bug found + fixed during this pass:** `normalizeE164()` (`hermes-core/src/repos/contacts.ts`) stripped all
non-digit characters, so an alphanumeric carrier sender id (e.g. `JD-JioHtsr`)
collapsed to a bare `"+"` and every such sender piled into one fake thread.
Fixed to leave a digit-less sender id unchanged. Caught live: real inbound Jio
OTP messages had exactly this shape.

**Near-miss found + fixed:** `normalizeE164`'s bare-10-digit fallback assumed
`+1` (US). Posting a bare 10-digit Indian mobile queued a send
to `+1…` instead of `+91…`. It didn't actually reach a stranger only because
the connector's in-memory replay-guard happened to still hold that `client_ref`
from an earlier test run; on a clean dedupe cache it would have sent for real.
**Fixed:** the bare-10-digit default is now `+91` (India — this deployment's
country), not `+1`. Still pass a full `+<country><number>` `to` value for any
number outside India.

Also landed post-checkpoints (2026-09-05): the Gemini session is **pre-warmed
during the ring** (connect + `setup` overlap the answer window) and the caller is
held on **ringback until the session is ready** (capped at `GEMINI_READY_WAIT_MS`
= 8s), removing the dead-air window. Realtime-latency work is tracked in
[`LATENCY.md`](./LATENCY.md).

## Source (`src/com/hermes/connector/`)

| File | Role |
|---|---|
| `ConnectorService.java` | The `InCallService`. Capture → Gemini → uplink playback; call lifecycle; per-call system instruction; the inject queue; mic-mute; wires `HermesLink`, `OutboundCoordinator`, `Watchdog`. |
| `LinkService.java` | Foreground service (`remoteMessaging` type) that owns the persistent `HermesLink`. Started on boot and self-healed from `onCallAdded`. |
| `HermesLink.java` | One WSS to `hermes-core`: `hello` handshake, bearer token, 20s heartbeat, writer deque with head-requeue, backoff 1/2/4/8/16/30s. |
| `Protocol.java` | Wire codec for the link. Pure Java (host-testable). Encoders hand-roll JSON (RFC 8259 escaping); `parse()` uses `org.json` (device-only). Contract = `hermes-core/src/protocol.ts`. |
| `WebSocketClient.java` | Hand-rolled RFC 6455 client over `javax.net.ssl` / plaintext `Socket`. No external libraries. Used for both the Gemini socket and the link. |
| `GeminiLiveClient.java` | Gemini Live API protocol on top of `WebSocketClient`. AUDIO-out only, JSON over binary frames, `outputAudioTranscription`, one local tool (`end_call`). |
| `GeminiSmokeTestReceiver.java` | `adb`-triggered Gemini Live smoke test — no telephony needed. |
| `SmsBridge.java` | Outbound SMS: `sms.send` → `SmsManager.sendMultipartTextMessage` (default SIM), SENT/DELIVERED `PendingIntent`s → `sms.sent` / `sms.delivered`. In-memory replay guard. Owned by `LinkService`. |
| `SmsReceiver.java` | Inbound SMS: manifest receiver for `SMS_RECEIVED` (non-default app safe), reassembles multipart parts → `LinkService.deliverInboundSms` → `sms.inbound`. |
| `InjectGate.java` | Barge-in-safe gate: a `<<DIRECTOR …>>` note is fed to Gemini only at a turn boundary (turn just completed, or idle ≥ 1200ms). Pure logic. |
| `OutboundCoordinator.java` | Correlates a `call.place` with the Telecom `onCallAdded(DIRECTION_OUTGOING)` by the last 10 digits of the number; arms the 20s dial-timeout. Pure logic. |
| `Watchdog.java` | Fire-once max-call-duration timer. `start()` on `STATE_ACTIVE`, `cancel()` on `stopSession`. |
| `BootReceiver.java` | Starts `LinkService` on `(LOCKED_)BOOT_COMPLETED`. |
| `DevOutboundReceiver.java` | Dev-only: `adb am broadcast -a com.hermes.connector.DEV_OUTBOUND_CALL --es to <number>` into the real outbound path, no link needed. |
| `BuildConfig.java` | **Generated** by `build.sh` from `../.env`. Git-ignored, never committed. `GEMINI_API_KEY`, `HERMES_WS_URL`, `HERMES_DEVICE_ID`, `HERMES_TOKEN`, `MAX_CALL_MS`. |

End-reason taxonomy (both sides):
`agent_ended | remote_hangup | aborted_off_script | watchdog | far_party | dial_timeout | error`.

## Build

Requires the Android SDK command-line build-tools `36.0.0` + `platforms/android-36`
(under `$ANDROID_HOME`, default `~/Android/Sdk`) and a JDK. **No Gradle, no Android
Studio, no external Java libraries.**

```sh
bash build.sh          # aapt2 link -> javac 11 -> d8 --min-api 26 -> zipalign -> apksigner
                       # -> build/HermesConnector.apk  (self-signed dev key: hermes-dev.keystore)
```

`build.sh` first regenerates `src/com/hermes/connector/BuildConfig.java` from
`../.env`. Missing `gemini_key` → build still succeeds, warns, and
`GeminiLiveClient.connect()` fails at runtime. Missing any `hermes_*` → the link
is disabled (not an error); inbound calls use `DEFAULT_SYSTEM_INSTRUCTION` (which
carries the same HARD RULES block as `hermes-core`'s `persona-rules.ts`).

The dev signature does **not** need to match the platform cert — priv-app grants
come from the allowlist file (`privapp-permissions-hermes.xml`: `CAPTURE_AUDIO_OUTPUT`,
`CONTROL_INCALL_EXPERIENCE`, `MODIFY_PHONE_STATE`) + `/product` placement.

## Test

```sh
bash selftest.sh       # compiles the tree against android.jar, runs each pure-logic
                       # class's static main()/selfTest() on the host JVM:
                       # WebSocketClient, Protocol, HermesLink, InjectGate,
                       # OutboundCoordinator, Watchdog  (6 suites)
```

On-device integration is proven by the numbered checkpoints in the build plan
(exact `adb` commands + expected `logcat`/dashboard state); run output is captured
to `logs/`.

## Deploy

See [`DEPLOY.md`](./DEPLOY.md). Short version: it's a priv-app, so the APK +
allowlist go to `/product/priv-app/HermesConnector/` + `/product/etc/permissions/`
on the **same partition**, and a **first install needs a reboot** (priv-app grants
are scanned only at boot). APK-only changes hot-swap without a reboot
(`adb push` + `am force-stop`). Dev link to a local `hermes-core`:
`adb reverse tcp:8787 tcp:8787` with `hermes_ws_url=ws://localhost:8787/phone`.
Production is `wss://` via the existing Cloudflare Tunnel. **Never set the
connector as the default dialer.**
