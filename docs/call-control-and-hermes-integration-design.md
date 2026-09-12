# Call Control & Hermes Integration — Design

> **⚠️ ABANDONED (2026-09-02). Kept for history only — do not build from this.**
> This "standalone `phone-agent-gateway` + in-memory state on the phone" design
> was replaced before implementation by the split
> **`phone-connector/` (dumb on-device I/O) + `hermes-core/` (the VPS brain,
> Postgres-backed, with a trigger-based director)**. Every capability this doc
> designs — remote hangup, outbound scripted calls, the persistent phone↔server
> link, the mic-mute bugfix — was built, just the `hermes-core` way instead.
> **What shipped instead:** [`../phone-connector/README.md`](../phone-connector/README.md)
> + [`../hermes-core/README.md`](../hermes-core/README.md).
> The section references (`§5.1`, `§5.4`, `§5.5`, …) that the newer docs still
> cite point back into *this* file — that is the only reason to open it now.

**Status (original): LOCKED (2026-08-26).** Verified against the live codebase and a
real live call on-device (see §2.1) before locking — not a paper design.
Ready to build in the order given in §9. This supersedes the earlier
"Planned" draft of the same date: that draft had one fatal architectural
gap (§2.1/§5.1) and several under-specified state-tracking edges (now
closed throughout §5). Everything described here is new work on top of the
already-live system in
[`system-architecture-and-status.md`](./system-architecture-and-status.md)
§3–§4 and [`tool-integrations.md`](./tool-integrations.md).

**Companion docs:** [`system-architecture-and-status.md`](./system-architecture-and-status.md) —
the proven capture/inject architecture and current system status.
[`tool-integrations.md`](./tool-integrations.md) — the three Gemini tools
already built (`append_sheet_row`, `create_calendar_event`,
`handoff_to_hermes`) and their shared HTTP/OAuth plumbing, reused here.
[`call-agent-behavior-and-policy-spec.md`](./call-agent-behavior-and-policy-spec.md) —
the behavior/policy layer (inbound personas, admin trust tiers, outbound
script guardrails) this technical design will need to support.

---

## 1. Goal

An **automated phone API**: your own agent (Hermes) or you directly (a
manual `curl`) can hand the phone a number and a script, and the phone
places that call and runs it autonomously. Independently, **inbound calls
are handled entirely locally** — no API round trip, no correlation, just
the AI joining the call the way it already does today. Both paths end the
call cleanly (self-ended by the AI, or force-ended remotely) and neither
leaks the human's own mic into the far party's ears while the AI is
talking.

Four new capabilities, one bugfix — unchanged in shape from the prior
draft, but capability 3 is now designed as a genuinely standalone
always-on component instead of piggybacking on call-scoped lifecycle:

1. **Hangup** — the agent (or Hermes, remotely) can end a call.
2. **Outbound call with script** — the automated phone API: Hermes/you
   `POST` a number + script, the phone dials it and hands the AI that
   exact script for that call.
3. **Control link** — an always-on phone↔server connection that exists
   *independent of whether a call is happening*, because that's precisely
   when capability 2 needs to be triggerable.
4. **Mic mute (bugfix)** — the near-end mic is currently *never* muted
   (confirmed still true on the live call checked in §2.1), so it mixes
   into the uplink alongside the AI's injected audio the whole time.

**Inbound vs. outbound — the split the whole design hangs on:**

| | Inbound | Outbound (API-triggered) |
|---|---|---|
| Triggered by | the far party calling in | `POST /calls` from Hermes or you |
| Correlation needed | none — `onCallAdded` fires, that's the whole story | number-match + script hand-off (§5.4) |
| System prompt | generic default | the script from the API call |
| Control-plane involvement | **none** | required to receive the trigger *before* the call exists |
| Mic-mute / hangup / watchdog | apply identically either way — see §5 |

---

## 2. Recap: what's already live (unchanged by this design)

```
                    ┌─────────────────────────────────────────────────────────┐
                    │  com.calltap.probe (priv-app, /product/priv-app)         │
                    │  CallProbeService : InCallService (2nd, non-UI,          │
                    │  bound alongside stock Dialer — never replaces it)       │
                    │                                                          │
  Telecom ─────────▶│  onCallAdded/onStateChanged(ACTIVE) → startSession()     │
 (call events)      │        │                                                 │
                    │        ├─ AudioRecord(VOICE_DOWNLINK,16kHz) ──┐          │
                    │        │      far party's speech               │        │
                    │        │                                       ▼        │
                    │        │                          GeminiLiveClient      │
                    │        │                        (hand-rolled WS,        │
                    │        │                     gemini-3.1-flash-live)     │
                    │        │                                       │        │
                    │        │                     tool calls ◄──────┤        │
                    │        │              (append_sheet_row,       │        │
                    │        │               create_calendar_event,  │        │
                    │        │               handoff_to_hermes)      │        │
                    │        │                                       ▼        │
                    │        └─ AudioTrack(TYPE_TELEPHONY) ◄── 24kHz PCM reply │
                    │               far party hears Gemini (MIXED with mic —  │
                    │               see §5.5, this is the bug being fixed)    │
                    └─────────────────────────────────────────────────────────┘
```

Reusable building blocks this design leans on:

- **`WebSocketClient.java`** — hand-rolled RFC 6455 client over `SSLSocket`.
  Proven for the Gemini connection (re-confirmed live, §2.1). This design
  opens a **second, independent** instance for the control link (§5.1), not
  a modification to the Gemini one. Note: it has no built-in
  reconnect/backoff — that's new logic wrapped around it, not something the
  class already provides.
- **`HttpUtil.java` / `GoogleApiAuth.java`** — shared HTTPS + bearer-token
  patterns already used by `HermesClient`/`SheetsClient`/`CalendarClient`.
- **`registerTools()` pattern in `CallProbeService`** — each tool is
  independently config-gated and silently skipped if unconfigured (also
  re-confirmed live, §2.1). `end_call` (§5.3) follows the same shape.
- **`BuildConfig.java` generation from `.env`** — new config keys for this
  phase (control-plane URL/token) follow the exact pattern already used for
  `HERMES_API_URL`/`HERMES_API_TOKEN`.

### 2.1 Live verification (2026-08-26, this design's pre-lock check)

Checked directly against a real call on the connected device (`adb`,
device `1508de2a`) before locking this doc, because the first draft's
control-link design turned out to rest on a false assumption:

| Checked | Result |
|---|---|
| Does `CallProbeService`/its process exist when no call is active? | **No.** `dumpsys telecom`'s `InCallController` log shows `com.calltap.probe` bound only from `onCallAdded` (13:27:38) onward for this specific call; nothing in `system-architecture-and-status.md`'s own evidence (§4 proven-capabilities table) shows it running otherwise either. **This is why §5.1 below introduces a genuinely separate, always-on component** rather than hanging the control link off `CallProbeService` as the first draft did. |
| Does the Gemini Live pipeline still work end-to-end? | **Yes** — real call, real transcript exchange, `setupComplete`→audio→`turnComplete` all observed live, uplink confirmed routed to `TYPE_TELEPHONY` (`routedDeviceType=18`). |
| Do the three existing tools correctly skip when unconfigured? | **Yes** — `.env` only has `gemini_key` set; logs show all three ("Sheets tool not configured... skipping" etc.) skipping cleanly, no crash. |
| Is the mic currently muted during an agent session? | **No** — confirms §5.5's bugfix target is still an open, live bug. |
| Anything unrelated worth flagging? | `runCapture()`'s local RMS/peak log is `0.0`/`0` on every chunk despite real speech being transcribed by Gemini seconds later — looks like a logging bug, not silence (worth a look, **not part of this design**). Also 4 `AudioHardening background playback would be muted for com.calltap.probe` lines from `AS.AudioService` during playback — worth checking whether this is clipping AI replies (**not part of this design**, noted for a separate pass). |

---

## 3. What's actually on the Hermes side (prod VPS)

Checked directly (read-only) before designing this, because the original
mental model ("Hermes reads a local DB via cron") turned out not to match
reality — worth recording since it shaped the design:

| Found | Detail |
|---|---|
| `hermes-gateway.service` | systemd, `Restart=always`, runs as **root**, `python -m hermes_cli.main gateway run` from `/usr/local/lib/hermes-agent` — a full project (`gateway/`, `cron/`, `acp_adapter/`, `mcp_serve.py`, WhatsApp bridge on `:3000` localhost-only). This is a real always-on gateway, not a polling cron job. |
| `hermes-agent.service` | Separate, simpler: `/opt/hermes-agent/hermes_agent.py`, a Telegram bridge, config in `/etc/hermes-agent.env`. |
| Permissions | Everything under `/usr/local/lib/hermes-agent` and `/opt/hermes-agent` is root-owned, `0700`/`0500` — even the normal `ashish` user gets `Permission denied` trying to read the venv or run the CLI. **Integrating directly into Hermes' internals is not realistically available from outside root on that box.** This is the main reason the design below adds a **new, separate, standalone service** rather than trying to bolt into Hermes. |
| `syrex-tunnel` (docker) | `cloudflare/cloudflared` container already running, fronting `syrex-api` behind `syrex-caddy`. **A Cloudflare Tunnel already exists on this box.** The new control-plane service reuses this — add one new ingress hostname to the existing tunnel config — rather than standing up any new tunnel infrastructure, and *especially* rather than running any tunnel client on the Android device itself. |
| Other containers | `syrex-api`, `supabase-*`, `kuber-*`, `coolify` (which manages deploys on this box) — unrelated to this design, noted only because `phone-agent-gateway` (§4) should be deployed the same way (a Coolify-managed app or a plain systemd unit) rather than introducing a new deployment pattern. |

---

## 4. New component: `phone-agent-gateway` (server, prod VPS) — the automated phone API

A small, standalone service — **not** inside Hermes' codebase (can't reach
it) and **not** bolted into `syrex-api` (unrelated concern) — reachable at
e.g. `https://phonectl.<yourdomain>/` through the **existing** Caddy +
Cloudflare Tunnel (new ingress hostname only, no new firewall port, no new
TLS cert management). This is the thing Hermes calls, and the thing you can
`curl` by hand — the single front door for "make the phone call this
number with this script."

### 4.1 Why "phone dials out", not a reverse tunnel

The phone is on mobile data: no public IP, almost certainly behind carrier
NAT/CGNAT. Hermes cannot open a connection *to* the phone. Two ways to solve
that:

- **Reverse tunnel onto the phone** (e.g. running `cloudflared` itself as a
  second always-running root process on the device) — works, but adds a
  whole new moving part on-device: another persistent background process,
  its own credentials/DNS to manage, another thing that can silently die.
- **Phone dials out** (chosen) — the phone opens a persistent outbound
  WebSocket to `phone-agent-gateway` and holds it open. No inbound
  reachability to the phone is ever needed. Reuses `WebSocketClient.java`
  directly, but the *long-lived, reconnect-with-backoff* usage pattern is
  new (§2's note: the class itself has no reconnect logic built in).

### 4.2 API surface

**WSS endpoint** — `wss://phonectl.<yourdomain>/ws`
The phone's `PhoneControlService` (§5.1 — **not** `CallProbeService`)
connects once at boot/process start and keeps it open for its own
lifetime, independent of any call, reconnecting with backoff on drop.
Auth: a bearer/shared-secret token in the connect headers (new
`PHONE_AGENT_CONTROL_TOKEN`, same `.env` → `BuildConfig` pattern as
`HERMES_API_TOKEN`).

Server → phone messages:
```json
{"type": "place_call", "call_id": "c_123", "to": "+15551234567", "script": "You are calling to confirm tomorrow's 3pm meeting with..."}
{"type": "hangup", "call_id": "c_123"}
```

Phone → server messages:
```json
{"type": "call_dialing", "call_id": "c_123", "to": "+15551234567"}
{"type": "call_active",  "call_id": "c_123"}
{"type": "call_ended", "call_id": "c_123", "reason": "agent_ended | remote_hangup | far_party_hung_up | watchdog_timeout | dial_timeout | error", "summary": "short free-text outcome, optional"}
{"type": "heartbeat"}
```
`call_dialing` is sent the moment the phone has a real `Call` object
correlated to this `call_id` (Telecom accepted the dial attempt — still
ringing/connecting). `call_active` is sent when that call actually reaches
`STATE_ACTIVE` (far party picked up, AI session starts). This is a change
from the first draft, which only had `call_started`/`call_ended` and had
no event that could ever produce a `"ringing"` status — see §4.3.

**REST endpoint for Hermes (and for you, directly):**

| Method | Path | Body | Effect |
|---|---|---|---|
| `POST` | `/calls` | `{to, script}` | Validates phone is connected; assigns `call_id`; pushes `place_call` down the socket; returns `{call_id, status:"queued"}` immediately. |
| `POST` | `/calls/{call_id}/hangup` | — | Pushes `hangup` down the socket. |
| `GET` | `/calls/{call_id}` | — | Current status + outcome, from the last WS events received for that `call_id`. |

### 4.3 Status state machine (now fully backed by real events)

```
queued ──(call_dialing)──▶ dialing ──(call_active)──▶ active ──(call_ended)──▶ ended
   │                          │                                                  ▲
   └──────────(dial_timeout, or place_call rejected/errored)────────────────────┘
```
`queued` is set synchronously at `POST /calls` time and has a **local
dial-timeout** on the phone side (§5.4): if no `call_dialing` arrives
within 20s of the phone receiving `place_call`, the phone itself emits
`call_ended{reason:"dial_timeout"}` — closing the gap the first draft had
(a `placeCall()` failure/no-op could previously leave a call `"queued"`
forever with no way for Hermes to ever find out).

State (`call_id` → status/outcome) can live in-memory in `phone-agent-gateway`
for v1 — no durable store is required by anything in this design (see §9 for
what a durable call log would need if wanted later).

---

## 5. Phone-side additions

This is the section that changed most from the first draft. Two components
now, not one:

- **`PhoneControlService`** (new, §5.1) — a plain, always-on Android
  `Service`, **not** an `InCallService`. Owns the persistent control-plane
  WebSocket. Lives independently of whether a call exists.
- **`CallProbeService`** (existing `InCallService`, extended) — still only
  alive while a call is in progress (confirmed §2.1), still owns the actual
  call/audio/Gemini session. Talks to `PhoneControlService` through a tiny
  in-process bridge (§5.2) — both are components of the same app process,
  so this is a static singleton, not IPC/AIDL.

### 5.1 `PhoneControlService.java` (new) — the always-on half

A regular foreground `Service`:
- **Started at boot** via a `RECEIVE_BOOT_COMPLETED` receiver (normal
  permission, no allowlist entry needed), and **self-healed** on every call:
  `CallProbeService.onCallAdded()` checks whether `PhoneControlService` is
  running and starts it if not — cheap insurance against it having been
  killed, using a wakeup the app gets for free anyway (a call event) rather
  than adding a separate scheduler.
- **Foreground service, minimal notification.** Android 8+ requires a
  visible notification for any foreground service; targeting API 34 also
  requires declaring a `foregroundServiceType`. `remoteMessaging`
  (`FOREGROUND_SERVICE_REMOTE_MESSAGING`, API 34+) is the closest documented
  fit — "maintain a connection to a remote server to guarantee timely
  delivery of messages" is exactly this. Use a minimum-importance
  notification channel ("Phone Agent · Ready") so it's compliant but
  unobtrusive. **Confirm the exact FGS-type behavior on this device during
  implementation** — fall back to `specialUse` with a justification string
  if `remoteMessaging` rejects this use case in practice.
- Hosts one instance of `WebSocketClient` wrapped with reconnect+backoff
  (new logic — see §2's note that the base class doesn't provide this).
- Owns the **pending outbound call state** — this is the fix for the first
  draft's script-handoff timing hole (was §5.3 there): `pendingCallId`,
  `pendingNumber` (normalized, see §5.4), `pendingScript`, plus a
  `pendingCancelled` flag and a dial-timeout `Runnable` (§4.3). This state
  now lives in the component that's actually alive when `place_call`
  arrives, and stays alive across the handoff to whichever
  `CallProbeService` instance eventually gets created for that call.
- Exposes (via `PhoneAgentBridge`, §5.2): a way for `CallProbeService` to
  claim/consume the pending state, a way to push `call_dialing` /
  `call_active` / `call_ended` events, and a way to check/clear
  `pendingCancelled`.

### 5.2 `PhoneAgentBridge` (new) — the in-process link

Both services run in the same app process (no `android:process` override
anywhere), so this is a plain static class — no `Messenger`/`AIDL`/`Binder`
IPC needed:

```java
final class PhoneAgentBridge {
    // Set by PhoneControlService on place_call, consumed by CallProbeService.onCallAdded.
    static volatile PendingOutboundCall pending; // {callId, number, script, cancelled}
    // CallProbeService registers itself here while a call is active so
    // PhoneControlService's WS handler thread can route hangup/status queries to it.
    static volatile ActiveCallHandle activeCall;  // {callId, disconnect(), reportReason(String)}
    // Outbound event push, called from CallProbeService at each lifecycle point.
    static void sendEvent(JSONObject event) { PhoneControlService.instance().send(event); }
}
```
This is intentionally the *only* new coupling between the two services —
everything else (audio, Gemini session, tool calls) stays exactly where it
is today in `CallProbeService`.

### 5.3 Hangup

`CallProbeService` today never retains a reference to the live `Call`
object — it's only a callback-local parameter. Add:
```java
private volatile Call activeCall; // set in onCallAdded, cleared in onCallRemoved
private volatile String pendingDisconnectReason; // set immediately before any disconnect() call
```
`pendingDisconnectReason` is the fix for the first draft's missing
disconnect-reason tracking: the WS protocol needs to distinguish
`agent_ended | remote_hangup | far_party_hung_up | watchdog_timeout | error`,
but there was previously exactly one teardown path and no way to tell them
apart. Every trigger below sets this field **before** calling
`disconnect()`; the teardown path (`stopSession()`) reads it to build the
`call_ended` event, defaulting to `far_party_hung_up` if nothing set it
(i.e. nobody local initiated the disconnect) and clears it after.

Three independent triggers, same underlying action:
1. **Gemini tool `end_call`** (no parameters, always registered — no
   `.env` gating needed, no external credentials) → `pendingDisconnectReason
   = "agent_ended"`; `activeCall.disconnect()`.
2. **Remote hangup via `PhoneAgentBridge`** — Hermes/you force a call to
   end early → `pendingDisconnectReason = "remote_hangup"`;
   `activeCall.disconnect()` from the WS command handler thread. If
   `activeCall` is null because the call hasn't been added yet (hangup
   arrived in the narrow window between `placeCall()` and `onCallAdded`),
   set `pendingCancelled = true` on the bridge's pending-state instead;
   `onCallAdded` checks that flag and immediately disconnects the
   just-created call before doing anything else.
3. **Watchdog** (§5.4) → `pendingDisconnectReason = "watchdog_timeout"`;
   `activeCall.disconnect()`.

All three null-check `activeCall` before calling `disconnect()` — a tool
call or remote command arriving in the small window after the far party
already hung up (but before `onCallRemoved` clears the field) must not
throw; it's caught by the tool-call handler's existing try/catch regardless
(see `GeminiLiveClient.runToolCall`), but the remote-hangup path should
guard explicitly too since it isn't wrapped by that same catch.

No new Android permission needed — `Call.disconnect()` only requires
`BIND_INCALL_SERVICE`, already held by the service.

### 5.4 Outbound call with script

On `PhoneControlService` receiving `place_call {call_id, to, script}`:
1. Reject (send back `call_ended{call_id, reason:"error", summary:"call already in progress"}`)
   if `PhoneAgentBridge.activeCall != null` **or** `pending != null` — v1
   handles one call at a time, deliberately not building
   call-waiting/concurrency handling. This check-then-act is on the WS
   handler thread only (single-threaded per connection), so it's
   effectively atomic against another `place_call`; it is *not* atomic
   against an inbound call landing concurrently — see the residual race
   note below.
2. Store `pending = {callId, number: normalize(to), script, cancelled:false}`
   on the bridge; start the 20s dial-timeout `Runnable` (§4.3).
3. `telecomManager.placeCall(Uri.fromParts("tel", to, null), extras)` —
   wrapped in try/catch: a thrown `SecurityException`/other exception means
   `placeCall()` never produced a call, so clear `pending`, cancel the
   timeout, and immediately emit `call_ended{reason:"error", summary: e.getMessage()}`.
   This closes the first draft's silent-forever-"queued" gap.

In `CallProbeService.onCallAdded`, if the new call's direction is
`DIRECTION_OUTGOING` and its number matches `PhoneAgentBridge.pending.number`:
- If `pending.cancelled` is already true (a hangup raced the dial, §5.3 #2),
  disconnect immediately and skip everything below.
- Otherwise: cancel the dial-timeout, copy `pending.script` into a **new,
  session-scoped field** `sessionSystemInstruction` on `CallProbeService`
  (this is the fix for the first draft's handoff gap — `startSession()`
  only actually runs later, at the `STATE_ACTIVE` transition, so the script
  has to survive past `onCallAdded` in a field that isn't the pending one),
  register this call as `PhoneAgentBridge.activeCall`, clear `pending` on
  the bridge, and send `call_dialing`. When `STATE_ACTIVE` fires,
  `startSession()` uses `sessionSystemInstruction` (falling back to the
  generic default if null) as the `systemInstruction` passed to
  `GeminiLiveClient.connect()`, and sends `call_active`. Clear
  `sessionSystemInstruction` on teardown either way, so a stale script can
  never leak onto some unrelated later call.

**Number normalization (`normalize()`, newly specified — the first draft
left this undefined):** strip everything except digits and a leading `+`,
then compare the rightmost 10 digits of the dialed number against the
rightmost 10 digits of what Telecom reports on the new call's handle. This
is a pragmatic v1 choice (US-centric; international numbers with fewer than
10 significant digits, or two genuinely different numbers that happen to
share a last-10-digit suffix, are edge cases not handled). **If it doesn't
match, don't silently fall back to the default prompt** — log loudly (this
means a real call is running with the wrong/no script and nobody would
otherwise know) and still emit `call_dialing`/`call_active` so status
tracking doesn't break, just without the script.

**Residual race, accepted for v1:** `place_call`'s activeCall/pending check
(step 1) isn't atomic against an inbound call arriving in the same instant.
If both land together, whichever reaches `onCallAdded` first wins the
single-call-in-flight slot; the other is a call Telecom itself will
juggle (multi-call handling is Telecom's problem, not this service's) but
this service's own state tracking may attribute the wrong script/events to
the wrong call in that narrow window. Not fixed here — flagged, matching
the deliberate "no call-waiting handling" scope decision already in the
first draft (§8).

**New permission:** `TelecomManager.placeCall()` requires `CALL_PHONE`
(dangerous, normal protection level, confirmed against the current
manifest — not present yet) — request in the manifest, grant via
`adb shell pm grant` post-boot, same pattern already used for
`RECORD_AUDIO`. No priv-app allowlist entry needed (not a
`signature|privileged` permission).

**Safety watchdog — scope decision, made explicit here (ambiguous in the
first draft):** a single max-call-duration timer (default 10 minutes, one
constant) applies to **every** agent-run session, inbound or outbound —
matching §5.5's "always-on, not conditional" precedent for mic-mute, and
because a runaway inbound session the AI joined is exactly as much of a
blast-radius concern as a runaway outbound one. Started in `startSession()`,
cancelled in `stopSession()`. This is a deliberate piece of local insurance
given the "no number allowlist" decision (§6) — it bounds the blast radius
of any single runaway call without restricting *which* numbers can be
dialed or *which direction* triggered it.

### 5.5 Mic mute (bugfix)

**Current bug (re-confirmed live, §2.1):** `AudioTrack(TYPE_TELEPHONY)`
*adds* Gemini's voice into the uplink; it does not replace the live mic
path. The near-end mic keeps feeding the call the whole time an agent
session is active, mixing room noise/echo with the AI's injected audio.

**Fix:**
```java
// startSession():
audioManager.setMicrophoneMute(true);
// stopSession() AND onCallRemoved() AND any teardown path:
audioManager.setMicrophoneMute(false);
```
The unmute must be defensive in *every* teardown path. `setMicrophoneMute`
is a **global** `AudioManager` flag, not scoped to this call or this app —
two consequences worth stating explicitly rather than leaving implicit:

- **A crash mid-session has no OS-level guarantee of clearing it.** There's
  no `try/finally` that survives a process death. Mitigation: a defensive
  check at the *start* of every new call — `onCallAdded` checks
  `audioManager.isMicrophoneMute()` and clears it if true and no session
  should logically be muting yet, before doing anything else. This doesn't
  guarantee zero-downtime mute-stuck-on windows (a crash between calls
  could still leave a stray period muted until the next call arrives), but
  bounds it to "at most until the next call," not indefinitely.
- **Interaction with the stock Dialer's own mute button is undesigned and
  accepted as a v1 limitation, not fixed here.** While an agent session is
  active, the phone owner physically cannot be heard on that call even if
  they want to jump in — the mic is muted at the `AudioManager` level
  regardless of what the Dialer's own mute UI shows. If the owner taps
  "mute"/"unmute" in the Dialer during an agent session, that toggle and
  this programmatic one can desync (Dialer UI showing unmuted while HW is
  actually muted, or vice versa after the agent session ends). Acceptable
  for v1 because the whole point of an agent-run call is that the human
  isn't expected to be speaking on it; worth revisiting if that assumption
  turns out to be wrong in practice.

`setMicrophoneMute` requires `MODIFY_AUDIO_SETTINGS` — normal protection
level, just add to the manifest, no allowlist entry needed.

This applies to **every** agent session, inbound or outbound, matching the
existing "always-on" behavior — not something newly conditional.

---

## 6. Security / safety posture

- **Control-link auth:** shared-secret bearer token, phone↔gateway only.
  Not building per-Hermes-user auth or mTLS for v1 — this is a single
  device talking to a single service you control.
- **No number allowlist** (explicit decision) — Hermes can direct the phone
  to dial any number. The only local guardrails are the single-call-in-flight
  guard (§5.4) and the max-duration watchdog (§5.4, now explicitly scoped to
  all sessions) — both bound *how bad* a mistaken call can get, neither
  restricts *who* can be called. If this turns out to matter in practice,
  an allowlist is a small, additive change later (a set check before
  `placeCall()`), not a redesign.
- **Consent/legality** — unchanged from the existing project posture
  (`system-architecture-and-status.md` §6): this targets calls on the device owner's own
  phone/number. An outbound AI-scripted call to a third party carries its
  own disclosure/consent considerations depending on jurisdiction and
  purpose — worth being deliberate about the *content* of scripts Hermes
  sends, independent of anything this design builds.

---

## 7. Explicitly out of scope for this pass

- **WS reconnect/backoff tuning** beyond "just works" for both the Gemini
  session and the new control link.
- **Call-waiting / concurrent calls** — the "reject if in-flight" guard
  punts on this on purpose; residual race noted in §5.4.
- **Durable call-outcome logging** — `phone-agent-gateway` keeps call state
  in memory only. If a persistent call log is wanted later, the natural fit
  is reusing the already-built `append_sheet_row` tool's plumbing for a
  "call log" sheet, or having the gateway write to Postgres (Supabase is
  already running on the same box).
- **Per-number allowlisting** — declined explicitly (§6).
- **The RMS/peak-always-zero logging bug and the `AudioHardening
  background playback` log lines noticed in §2.1** — real, worth a look,
  not part of this design.

---

## 8. Build order (locked)

1. Phone: `PhoneAgentBridge.java` (the static bridge, §5.2) — trivial,
   needed by both new/changed classes below, land first.
2. Phone: `PhoneControlService.java` (§5.1) — boot receiver, foreground
   service + `remoteMessaging` type, `WebSocketClient` + reconnect/backoff,
   pending-outbound state + dial-timeout. Testable standalone once
   `phone-agent-gateway` (step 4) exists to connect to — verify with
   `dumpsys activity services` / a manual WS echo server first if you want
   to test the reconnect logic before the real gateway is up.
3. Phone: `activeCall`/`pendingDisconnectReason` fields + `end_call` tool +
   remote-hangup handling (§5.3) — testable standalone on any live call, no
   gateway dependency.
4. Phone: mic-mute fix + crash-safety self-check (§5.5) — testable
   standalone on any live call, no gateway dependency, worth landing early
   since it's a plain bugfix.
5. Server: `phone-agent-gateway` — WSS endpoint + the three REST routes +
   the `dialing`/`active`/`ended` state machine (§4.3), in-memory call-state
   map. Deploy alongside the existing stack on prod (Coolify or plain
   systemd, matching how `syrex-api` is run); add one ingress hostname to
   the existing `cloudflared` tunnel config.
6. Phone: outbound call + script correlation + number normalization +
   watchdog (§5.4) — depends on steps 1–2 and 5 being in place to actually
   receive and act on a `place_call` command.
7. End-to-end test: Hermes (or a manual `curl POST /calls`) triggers a real
   outbound call with a test script while **no call is already in
   progress** (the exact scenario the first draft couldn't have supported —
   confirm `PhoneControlService` is alive and connected at that moment via
   `dumpsys activity services com.calltap.probe`), confirm script is used,
   confirm `end_call` and remote hangup both work, confirm mic-mute doesn't
   regress the existing inbound-call flow, confirm `dial_timeout` fires
   correctly against a deliberately bad number.

Steps 3–4 have no dependency on 1–2/5 and can be built/tested first if
preferred — they're pure phone-side changes to code that already works,
same as the first draft noted.

---

## 9. Open questions / risks carried forward

- **Real Hermes-side integration is still undesigned** — this spec defines
  the API `phone-agent-gateway` exposes, but *what inside Hermes actually
  calls `POST /calls`* (a new gateway command, an MCP tool, a cron rule) is
  a Hermes-side task outside this repo. Recommended default, to keep this
  from staying open indefinitely: expose it as one MCP tool to Hermes' own
  model (simplest, most directly matches "my agent can provide a script
  to") — a Telegram command is the fallback if MCP wiring on the Hermes
  side turns out to be blocked by the root-owned permissions noted in §3.
- **Script authoring/safety** — nothing here validates or reviews the
  `script` text Hermes sends before it's used as a live system prompt on a
  real outbound call.
- **`MODIFY_PHONE_STATE` is already allowlisted** (present in
  `privapp-permissions-calltap.xml` today, added for uplink injection) —
  confirmed no change needed there; `CALL_PHONE`, `MODIFY_AUDIO_SETTINGS`,
  `RECEIVE_BOOT_COMPLETED`, `FOREGROUND_SERVICE`, and
  `FOREGROUND_SERVICE_REMOTE_MESSAGING` are the new permissions this design
  needs, and none require a priv-app allowlist entry.
- **`remoteMessaging` foreground-service-type fit** — logically the right
  category (§5.1) but not yet confirmed against this specific device/OS
  build; first thing to check once `PhoneControlService` is written.
