# twilio-connector

Bridges a Twilio phone number's voice calls to `hermes-core`, speaking the exact same
`/phone` protocol a physical Android device (`phone-connector`) does
(see `hermes-core/src/protocol.ts` for the message shapes).

**Status: implemented and unit-tested (2026-09-12).** 42 tests green, `tsc` clean.
Not yet exercised against a live Twilio number or a real Gemini Live session — see
"What's not yet verified" below.

## What it is

`hermes-core` already treats "a device" as anything that registers over its `/phone`
WSS and speaks `PhoneMsg`/`CoreMsg` — nothing in the call-engine, director, personas,
or dashboard cares whether that's an Android phone or this. So this connector is a
second device: it owns a Gemini Live session per call (server-side, since there's no
on-device compute for a Twilio number) and bridges Twilio's raw call audio to it.

```
Twilio (PSTN call)  ──Media Streams (mulaw/8k WSS)──▶  twilio-connector  ──phone protocol (WSS)──▶  hermes-core
                                                              │
                                                              └──BidiGenerateContent (WSS)──▶  Gemini Live
```

## Layout

```
src/
  config.ts              # env loader (repo-root .env + twilio-connector/.env + process.env)
  protocol.ts             # PhoneMsg/CoreMsg — copied from hermes-core/src/protocol.ts, kept in sync by hand
  audio.ts                # mulaw/8k (Twilio) <-> PCM16/16k+24k (Gemini Live) conversion
  twilio-signature.ts     # validates X-Twilio-Signature on every webhook
  twiml.ts                # <Connect><Stream> response generation
  twilio-rest.ts          # Calls.create (outbound) / Calls(sid).update (hangup)
  gemini-live-client.ts   # BidiGenerateContent wire client — TS port of phone-connector's GeminiLiveClient.java
  hermes-client.ts        # this connector's side of the /phone WSS link, with reconnect
  call-session.ts         # the orchestrator: Twilio stream <-> Gemini Live <-> hermes-core, per call
  server.ts               # HTTP webhooks + the Media Stream WS upgrade
  main.ts                 # entrypoint: wires all of the above together
```

## Run the tests

```sh
npm install
npm test         # vitest — 42 tests; every network boundary (Twilio, Gemini, hermes-core) is faked
npm run typecheck
```

## Run it

```sh
npm start        # :8789 by default
```

## Config

Copy `.env.example` → `.env` (same pattern as `hermes-core`/`hermes-mcp`):
- `TWILIO_CONNECTOR_PORT` — default `8789`.
- `HERMES_WS_URL` / `PHONE_AGENT_CONTROL_TOKEN` — hermes-core's `/phone` endpoint and
  its shared bearer, same value as hermes-core's own `PHONE_AGENT_CONTROL_TOKEN`.
- `DEVICE_ID` — must be unique across every connected device (default `twilio-main`).
- `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_NUMBER` — from the Twilio
  console. Rotate the auth token if it was ever pasted anywhere outside this file.
- `PUBLIC_BASE_URL` — the HTTPS hostname Twilio can reach this service at (e.g. a
  Cloudflare Tunnel hostname), no trailing slash. Also set as the Twilio number's
  Voice webhook: `{PUBLIC_BASE_URL}/voice/inbound`.
- `GEMINI_API_KEY` — same key `phone-connector` uses (repo-root `.env`: `gemini_key`).

## What's not yet verified

Unit tests fake every network boundary (Twilio's REST API and webhooks, Twilio Media
Streams, Gemini Live, hermes-core's `/phone` link) — none of them have been exercised
against the real services yet. Per the design spec, live verification is one real
inbound call and one real outbound call through a deployed instance, checked against
the hermes-core dashboard the same way the `phone-connector` checkpoints were.
