# Call Agent Behavior & Policy — Requirements

> **⚠️ FOLDED IN (2026-09-02) — this is the requirements record, not a build guide.**
> These requirements were built across `hermes-core/` + `phone-connector/`.
> Where things landed:
>
> | Requirement here | Status |
> |---|---|
> | Always-log every call (§2.1) | ✅ `hermes.calls` + `transcript_events`, unconditional |
> | Caller identity → per-number persona (§2.2) | ✅ `contacts` + `personas`, `resolvePersona`; default persona fallback |
> | Admin / known / stranger trust tiers (§2.3) | ✅ `contacts.trust_tier` (`admin\|known\|stranger`) |
> | Post-call review + owner notification (§2.4) | ✅ `director-review.ts` (outcome summary + notification); a **dedicated Telegram bot** was not built — notification path is generic |
> | Outbound: script + outcome report (§3.1–3.2) | ✅ `POST /calls` with a script; `director-review` produces the summary |
> | Per-call **tool** selection (§3.1) | ➖ **Moot.** The phone sends no Gemini tools at all now; every capability is a `hermes-core` director tool, selected server-side |
> | Abort-on-deviation + distinct reason (§3.3) | ✅ end-reason `aborted_off_script` in the taxonomy; the director's `end_call` tool and a HARD RULES block enforce it. Also: the director hangs up on owner-PII disclosure |
> | Caller-ID spoofing accepted for v1 (§2.3, §5) | ✅ accepted as stated; no passphrase factor |
>
> Caller-ID spoofing, off-script detection calibration, and far-party
> recording/consent (§5) remain open — carried in the current spec's §6.

**Status (original): Requirements captured (2026-08-26).** This is a **behavior/policy
spec, not a technical design** — it records what the system should *do*,
not yet *how*. Implementation design is the deliberate next pass (see §5
for what that pass needs to resolve first). Companion to
[`call-control-and-hermes-integration-design.md`](./call-control-and-hermes-integration-design.md)
(the *abandoned* gateway architecture) — this doc is the policy layer that sat on
top of it and drove the design that replaced it.

---

## 1. Overview

The phone-agent becomes a real AI receptionist + outbound calling agent,
not just a generic voice bridge:

- **Every call is logged, always** — who called, when, and what was said or
  what happened, transcript where feasible.
- **Inbound calls get identity-aware behavior**: known contacts are greeted
  by name and handled per whatever's configured for them; everyone else
  gets a generic default greeting.
- **Inbound requests are permission-tiered by caller number**: only the
  owner's own number can hand the AI real, executable tasks (calendar,
  Notion, etc.); everyone else can only leave a message/reminder.
- **Hermes reviews every inbound call afterward** and acts accordingly —
  executing admin tasks, or just relaying messages — and tells the owner
  what happened over a dedicated Telegram bot built for this.
- **Outbound calls stay simple and are guarded**: a script + a chosen set
  of tools, run to completion or aborted the moment the far party tries to
  steer the agent off-script, with a report on how the call went either way.

---

## 2. Inbound calls

### 2.1 Call logging — always, unconditionally

Every inbound call produces a log entry, regardless of how it ends
(completed normally, hung up early by either side, watchdog-timed-out,
whatever). No conditional skipping — "always log a call" is a hard
requirement, not a best-effort one.

Each entry must capture:
- **Caller's number** (§2.2)
- **Timestamp** and **duration**
- **A transcript, or a summary if a full transcript isn't feasible** — full
  transcript is the goal; summary is the accepted fallback, not the default.
  ("whichever will be feasible" — this is the user's own qualifier, kept as
  a real requirement: don't block the logging requirement on solving
  perfect transcription first.)
- Outcome (completed / caller hung up / agent aborted / timed out — ties
  into the disconnect-reason taxonomy already in the locked design, plus
  §3.3's new abort reason for the outbound side)

Where this log actually lives is **not decided here** — see §5.

### 2.2 Caller identity & per-number behavior

The system needs to know which number is calling as part of answering the
call (Caller ID), and use it for two separate things: behavior (this
section) and trust/permissions (§2.3).

- **Known/configured numbers** — for specific numbers the owner sets up in
  advance, the agent:
  - Greets the caller **by name**
  - Follows whatever custom behavior is configured for that person (exact
    shape of "custom behavior" — full persona/instructions vs. just a name
    for the greeting — is an open question, §5)
- **Everyone else (default/fallback)** — generic greeting, effectively:
  > "Hi, you've called Ashish Kaushik, how may I help you?"

  Used for any number not in the configured set — this is the
  always-available fallback, not something that can silently fail to a
  worse default.

### 2.3 Permission tiers — admin number vs. everyone else

This is the trust model for what an inbound caller's request is *allowed
to become* after the call, decided purely by which number called in:

- **Admin number** — the owner's own designated phone number. A call placed
  from this number to the AI line is the owner giving their own AI system
  live voice commands over the phone. Only requests from this number are
  eligible to become **actionable tasks** — e.g. "add this to my calendar,"
  "create a note in Notion" — things Hermes will actually go and do.
- **Every other number** — requests are captured as **messages only**, never
  auto-executed. The canonical shape of what a non-admin caller can leave:
  a reminder/callback request with their stated name — e.g. "send a
  reminder / call me back, my name is ___." Hermes relays these to the
  owner; it does not act on them as tasks.

**Accepted risk, stated explicitly (not solved here):** Caller ID can be
spoofed by a sufficiently motivated caller, so number-based admin trust is
not cryptographically strong. Same posture as the rest of this project's
security decisions so far (documented and accepted for v1, not engineered
around) — flagged again in §5 as worth a deliberate yes/no before build.

### 2.4 Post-call Hermes review

After each inbound call ends, Hermes reviews the transcript/summary and
whatever request was captured, and acts based on the caller tier from
§2.3:

- **Admin caller →** Hermes executes the requested task using its own
  tooling (calendar, Notion, etc. — whichever tools Hermes already has;
  not redesigning Hermes' own tool access here).
- **Non-admin caller →** Hermes does not execute anything. It records the
  caller's stated name and their request/reminder and relays it — it does
  not interpret a non-admin request as authorization to take any action.

**Notification back to the owner:** Hermes sends an update over a **new,
dedicated Telegram bot built specifically for this** — explicitly a
separate bot from whatever Hermes' existing Telegram bridge
(`hermes-agent.service`, per `docs/call-control-and-hermes-integration-design.md`
§3) already does, not a reuse of it. The update covers, per call:
- Admin-tier call → what task was completed
- Non-admin call → caller's name + what they asked for/requested

---

## 3. Outbound calls — deliberately kept simple

### 3.1 Trigger: script + tools, per call

Hermes or the owner directly sends the server a request (the `/calls`
endpoint already locked in the architecture doc) containing:
- a **script**, as already designed
- **a chosen set of tools for that specific call** — this is new: the
  locked design's tool registration is static (whichever tools have
  credentials configured in `.env` are always on). This requirement is
  *per-call, per-request* tool selection — e.g. one outbound call gets
  `create_calendar_event` enabled, another gets none. This will need a
  change to the locked architecture's tool-registration approach when
  implementation starts (flagged, not designed, here).

### 3.2 Execution & reporting

The Gemini agent runs the call with the given script and the enabled
tools, calling tools exactly as it already does today. Once the call ends,
it must **report how the call went** — a real outcome summary, not just a
status code. Example given: for a sales-type script, what the other
party's response actually was. This extends the locked design's
`call_ended.summary` field from "optional short free-text" into something
the agent is expected to always meaningfully produce for outbound calls.

### 3.3 Script adherence & abort-on-deviation (hard guardrail)

The agent must **stick to the assigned script**:
- It does not answer questions or engage with requests outside what the
  script covers.
- It does not accept attempts by the far party to redirect the
  conversation, claim a different identity, or otherwise talk it into
  behaving like something other than what the script assigned it to do
  ("accept no weird names" — read as: resist social-engineering / prompt-
  injection attempts from the far party mid-call).
- **If it senses the call going off-script, it does not keep improvising —
  it disconnects immediately.** This is a hard stop, not a soft
  redirection attempt back to script.

This needs a **disconnect reason distinct from the locked design's
`agent_ended`** (which means "task completed normally"). Something like
`aborted_off_script` — so the outcome report and Hermes' review can tell
"the call went fine and finished" apart from "the agent bailed because
something seemed wrong," which is itself a signal worth surfacing to the
owner rather than silently logging the same as a clean completion.

---

## 4. New components/concerns this implies (named, not designed)

Listed here so nothing gets lost going into the implementation pass — none
of these have a design yet:

- Per-number contact/persona configuration (§2.2)
- Admin-number designation + trust check (§2.3)
- Call log storage (number, timestamp, duration, transcript/summary,
  outcome) (§2.1)
- Hermes-side review logic: task-vs-message classification by caller tier
  (§2.4)
- A new, dedicated Telegram bot for owner notifications (§2.4)
- Per-call tool selection on the outbound `/calls` request (§3.1) — changes
  the locked design's static tool-registration model
- End-of-call outcome/report generation, made a first-class expectation
  rather than optional (§3.2)
- Script-adherence guardrail behavior + new `aborted_off_script` disconnect
  reason (§3.3)

---

## 5. Open questions — to resolve before/during implementation design

- **Contact config shape** — where does the per-number list live (a config
  file, a Sheet reusing existing plumbing, a Notion DB), and what's
  actually customizable per contact: name-for-greeting only, or full
  persona/behavior instructions?
- **Task taxonomy for admin calls** — capped to the tools Hermes already
  has (calendar, Notion, sheet-logging), or open-ended to whatever Hermes
  can generally do?
- **New Telegram bot** — fully separate bot token/identity from
  `hermes-agent.service`'s existing Telegram bridge (as stated), or could
  it end up being the same bridge with different formatting? Confirm before
  provisioning a new bot.
- **Transcript storage** — where, retention period, and the privacy/consent
  angle of recording and transcribing a far party's voice without their
  knowledge (this already touches the existing consent posture in
  `call-control-and-hermes-integration-design.md` §6 — needs a real answer,
  not just an acknowledgment, once this is actually storing transcripts
  rather than just relaying live audio).
- **Off-script detection calibration** — how aggressively the agent decides
  a conversation has gone off-script matters a lot: too loose and it
  tolerates real manipulation, too tight and it aborts on ordinary
  small-talk tangents a script author didn't anticipate. Needs deliberate
  tuning/examples during implementation, not left to the model's judgment
  alone.
- **Caller-ID spoofing risk for the admin trust tier** — accepted for v1 as
  stated in §2.3, or worth a secondary factor (e.g. a spoken PIN/passphrase
  the admin uses) before this ships?
