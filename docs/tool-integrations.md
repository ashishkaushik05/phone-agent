# Tool Integrations — Gemini Live function calling

> **⚠️ HISTORICAL (2026-08-26) — `probe-app/` only.** `phone-connector/`
> **removed all three** on-device Gemini tools. The phone now declares exactly
> one local tool, `end_call`; every other capability (contact lookup, calendar,
> availability, notes, off-script flagging, guidance injection) is a
> **`hermes-core` director tool**, run on the VPS off the audio path — see
> `hermes-core/src/director-tools.ts`.
>
> Still useful here: **§1–§2**, the Gemini Live function-calling wire protocol
> and the in-`GeminiLiveClient` tool dispatcher — `phone-connector` keeps that
> exact machinery for `end_call`. §3's three tool implementations live on only in
> `probe-app/`.

**Status (original): built (2026-08-26), in `probe-app/`.** The protocol layer
and three tools below were implemented and confirmed live: with zero tools
configured, the base conversation worked unchanged (no `tools` field sent unless
at least one tool's `.env` config is present).

Companion: [`system-architecture-and-status.md`](./system-architecture-and-status.md)
for the single-app system this plugged into.

---

## 1. How Gemini Live tool calling works

`gemini-3.1-flash-live-preview` supports function calling with one
constraint that matters a lot for a phone call:

> **Function calling is sequential/synchronous only.** The model pauses
> generation and won't resume until the client sends the tool's response
> back — there's no "let me check that" while continuing to talk.
> (`gemini-2.5-flash-live-preview` has an async `scheduling` option;
> `gemini-3.1-flash-live-preview` does not.)

Concretely: far party asks something needing a tool → the AI goes silent →
the tool runs → result sent back → AI resumes. The pause is real, audible
dead air for however long the tool takes. **This is the main constraint on
tool design here** — keep tool execution fast (sub-second, ideally), or
have the system instruction steer the model to only invoke a tool when it's
clearly worth the pause.

**Protocol** (extends the existing `setup`/`realtimeInput`/`clientContent`
messages `GeminiLiveClient` already speaks):

```json
// setup message gains a "tools" array of FunctionDeclarations
{"setup": {"tools": [{"functionDeclarations": [{"name": "...", "description": "...", "parameters": {"type":"object","properties":{...},"required":[...]}}]}]}}

// server asks the client to run a tool
{"toolCall": {"functionCalls": [{"id": "call_1", "name": "append_sheet_row", "args": {"values": ["Jane Doe", "call back at 5pm"]}}]}}

// client sends the result back
{"toolResponse": {"functionResponses": [{"id": "call_1", "name": "append_sheet_row", "response": {"result": "ok"}}]}}
```

`parameters` is the same OpenAPI/JSON-Schema subset the whole Gemini API
family uses — `org.json` (already in use) is sufficient to build it, no new
schema/library needed.

## 2. Architecture: a tool dispatcher inside `GeminiLiveClient`

```
GeminiLiveClient
  ├── Map<String, ToolHandler> tools   (registered by name)
  ├── handleServerMessage(json)
  │     if root.has("toolCall"):
  │         for each functionCall: dispatch to a NEW thread (never inline —
  │         a tool's HTTP call is blocking I/O; running it on the WS reader
  │         thread would stall every subsequent server message, including
  │         the next audio chunk, for as long as the tool took)
  │         -> handler.execute(args) -> sendToolResponse(id, name, response)
  interface ToolHandler { JSONObject execute(JSONObject args) throws Exception; }
```

`CallProbeService.registerTools()` registers whichever handlers have
config present in `BuildConfig` before calling `connect()` (tool
declarations go in the initial `setup` message) — each tool is
independently gated, a missing `.env` config for one just skips that tool,
not an error, not a build failure.

## 3. The three built tools

All three reuse the same on-device HTTPS/OAuth building blocks
(`HttpUtil.java` — plain `HttpsURLConnection` POST helper; `GoogleApiAuth.java`
— Google service-account JWT-bearer flow) rather than pulling in any
external Google client library, consistent with this project's no-Gradle,
no-external-jars constraint. Every piece (`javax.net.ssl`,
`java.security.Signature("SHA256withRSA")`, `org.json`,
`HttpsURLConnection`) is already on the platform.

### 3.1 `append_sheet_row` (Google Sheets)

- **Setup required (once, outside the app):** a GCP project with the
  Sheets API enabled; a service account with a downloaded JSON key
  (`client_email` + PEM `private_key`); share the target spreadsheet with
  that service account's email as an **Editor**; note the spreadsheet ID
  from its URL.
- **`.env` keys:** `sheets_service_account_email`,
  `sheets_service_account_private_key` (paste the JSON key file's
  `private_key` field **exactly as-is**, including literal `\n` sequences —
  not real line breaks), `sheets_spreadsheet_id`.
- **Args:** `values` (array of strings, required — one new row, in column
  order), `sheet_name` (optional, defaults to `"Sheet1"`).
- **Call:** `POST https://sheets.googleapis.com/v4/spreadsheets/{id}/values/{range}:append?valueInputOption=USER_ENTERED`.

### 3.2 `create_calendar_event` (Google Calendar)

- **Setup required:** a **separate** service account from Sheets (project
  decision — not shared), Calendar API enabled, your calendar shared with
  its email with "make changes to events" (not just "see all event
  details"). Writes to `primary` — the calendar of whichever account did
  the sharing.
- **`.env` keys:** `calendar_service_account_email`,
  `calendar_service_account_private_key`.
- **Args:** `summary` (required), `description` (optional),
  `start_time`/`end_time` (required, RFC3339 with UTC offset, e.g.
  `2026-08-27T15:00:00-07:00` — the model works out the offset from
  conversational context; steer via system instruction if it gets this
  wrong in practice).

### 3.3 `handoff_to_hermes` (your server)

Simple, project-defined contract — static bearer token, no Google OAuth:

```
POST {HERMES_API_URL}
Authorization: Bearer {HERMES_API_TOKEN}
Content-Type: application/json

{"task": "look into flights to Denver next weekend", "priority": "normal",
 "context": {"source": "phone-agent", "call_time": "2026-08-27T22:14:03Z"}}
```

- **`.env` keys:** `hermes_api_url`, `hermes_api_token`.
- **Args:** `task` (required, free text), `priority` (optional —
  `low`/`normal`/`high`, model chooses, defaults `normal`).
- Any 2xx response = success; body logged, not otherwise interpreted. The
  endpoint's only job is to durably record the task somewhere Hermes will
  find it — everything past "returns 2xx" is entirely server-side, not
  assumed here.
- **This is the same handoff mechanism the outbound-call design in
  `call-control-and-hermes-integration-design.md` and the behavior spec in
  `call-agent-behavior-and-policy-spec.md` build on** — those specify a
  richer Hermes-side review flow (permission tiers, task vs. message
  classification) than this raw contract implements on its own.

## 4. Build / test order

1. Fill in whichever tools' keys you want in `.env` (`.env.example` at the
   repo root lists every key — only `gemini_key` is required, everything
   else is optional and independently skipped if empty).
2. Rebuild and redeploy (`probe-app/build.sh` — same reboot-required deploy
   as any other change to this priv-app).
3. **Smoke-test each tool independently** via `GeminiSmokeTestReceiver`
   (`adb shell am broadcast -a com.calltap.probe.TEST_GEMINI --es text "..."`)
   — one tool at a time as its config lands, e.g. *"Log 'test row' to my
   sheet"* / *"Schedule a test event tomorrow at 3pm called Test"* /
   *"Hand off a task to Hermes: say hello"*. Check logcat for `tool call
   requested` / `tool "..." succeeded` before ever testing on a real call —
   this is the same cheap-iteration approach that caught the real protocol
   bugs in the base audio pipeline for zero phone-call cost.
4. Only then test on a real call.

## 5. Open items

- **Sequential-only calling means every tool call is audible dead air** —
  worth being deliberate in the system instruction about which requests
  actually warrant a tool call vs. just answering conversationally (this
  gets sharper for outbound scripted calls — see the guardrail
  requirements in `call-agent-behavior-and-policy-spec.md` §3.1's per-call
  tool-selection requirement).
- **Gemini Live's built-in Google Search tool** (declared like a function
  but Google-hosted, no handler code needed) is mentioned in the docs but
  **unconfirmed against this specific model/version** — treat as a
  smoke-test item, not an assumption, before relying on it.
- **No token-refresh/error-handling story yet** for the Sheets/Calendar
  OAuth flow beyond basic caching (expired token, revoked access,
  unshared spreadsheet) — first version should fail loudly (log + a spoken
  "I couldn't save that" tool response) rather than silently.
- **Baked-secret posture** — service account keys and tokens live in
  `BuildConfig.java`, generated from `.env`, same as the Gemini API key.
  Fine for personal/prototype use, not a pattern to carry into anything
  shared or distributed.
- **Extending beyond these three** follows the same `ToolHandler` pattern —
  contacts lookup (`READ_CONTACTS`, on-device, no network), SMS/local
  notes, or any other REST endpoint (usually simpler than the Google OAuth
  flow — many accept a plain API-key header) all fit the same interface
  without touching the protocol layer in §2 again.
