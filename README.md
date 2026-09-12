# phone-call-agent

Give an AI agent its own phone: it places and receives **real phone calls**,
holds a live voice-to-voice conversation on them, and is steered mid-call by a
smarter supervisor agent running on a server.

The live conversation runs on Google Gemini Live (fast, cheap
voice-to-voice). A slower **director** (a frontier LLM via API) watches the
transcript from the server and only wakes on off-script attempts, requests
needing real data, escalations, or closings — it steers by silently injecting
context, never by being on the critical path of every turn.

---

## Components

| Dir | What it is | Status |
|---|---|---|
| [`phone-connector/`](./phone-connector/) | The on-device half. Android priv-app, no-Gradle build. Dumb I/O: call audio ↔ Gemini Live, call control (answer / hangup / outbound dial), SMS send/receive, transcript relay, one persistent authenticated WSS to `hermes-core`. No AI, no tools except a local `end_call`. | **Built & live-tested** — inbound, silent inject, remote hangup, mic-mute, outbound, dial-timeout verified on real calls; SMS send/receive live-tested. |
| [`hermes-core/`](./hermes-core/) | The brain. One TypeScript/Node Docker image: phone-control REST API + WSS link, per-call state, keyword trigger matcher, the director tool-loop, post-call review, a no-build web dashboard, Redis fan-out. Postgres-backed (in-process PGlite for dev/tests). WhatsApp (Baileys) runs here too — server-side only. | **Built, tested (`tsc` clean), deployed** — see [`deploy/`](./deploy/). |
| [`hermes-mcp/`](./hermes-mcp/) | The harness-facing layer: an MCP server exposing every `hermes-core` REST capability (calls, SMS, WhatsApp, personas, contacts) as a tool call, over Streamable HTTP. Thin and stateless — no state of its own, calls `hermes-core` purely over REST. | **Built, tested (`tsc` clean), deployed** — see [`deploy/`](./deploy/). |
| [`twilio-connector/`](./twilio-connector/) | A Twilio number as a second `hermes-core` device: bridges Twilio Media Streams to a server-side Gemini Live session while speaking the same `/phone` protocol as `phone-connector`. | **Implemented & unit-tested** — not yet verified against a live Twilio number. |

```
┌──────────────────────────── Android phone ───────────────────────────────────┐
│  stock Dialer (untouched)          phone-connector  (priv-app, headless)      │
│                          Telecom ─▶ ConnectorService : InCallService          │
│                                       call audio ─▶ Gemini Live              │
│                                     LinkService : one persistent WSS ─────────┼──┐
└─────────────────────────────────────────────────────────────────────────────┘  │
                                                                                 │  bearer-auth
┌───────────────────────────── VPS (Docker) ─────────────────────────────────┐  │  WSS /phone
│  hermes-core   call-engine (state + trigger matcher) ─▶ director (LLM)     │◀─┘
│                REST /calls /sms /whatsapp /personas /contacts · dashboard  │
│                Postgres · Redis fan-out · web dashboard                     │
└───────────────────────────────────────△────────────────────────────────────┘
                                         │ REST, bearer-auth
┌────────────────────────────────────────────────────────────────────────────┐
│  hermes-mcp   MCP Streamable HTTP /mcp ─▶ one tool per hermes-core route   │
└────────────────────────────────────────────────────────────────────────────┘
                                         △
                                         │ MCP, bearer-auth
                              harness / agent (see Roadmap)
```

---

## Documentation

- [`phone-connector/README.md`](./phone-connector/README.md) · [`phone-connector/DEPLOY.md`](./phone-connector/DEPLOY.md) · [`phone-connector/LATENCY.md`](./phone-connector/LATENCY.md)
- [`hermes-core/README.md`](./hermes-core/README.md) · [`hermes-core/DEPLOY.md`](./hermes-core/DEPLOY.md) · [`hermes-core/OUTBOUND-CALLS.md`](./hermes-core/OUTBOUND-CALLS.md)
- [`hermes-mcp/README.md`](./hermes-mcp/README.md)
- [`twilio-connector/README.md`](./twilio-connector/README.md)
- [`deploy/README.md`](./deploy/README.md) — production deployment record (tunnel, hostnames, gateway wiring, gotchas).
- [`docs/`](./docs/) — background reading: behavior/policy spec, the abandoned gateway design (history), on-device tool protocol notes, and the `probe-app`-era architecture record.

---

## Roadmap

- **Calls + SMS** — done, live-tested on real hardware.
- **WhatsApp channel** — outbound send + delivery confirmed live; inbound and the owner-notify director tool are unit-tested, live retest pending.
- **Email / calendar** — not started.
- **CRM** — deliberately **not built here**. CRM attaches later as an **external MCP server**; contacts already carry a `crm_ref` field as the attach point, so no schema change will be needed.
- **Autonomy** — a between-call outreach loop plus the phone-agent-specific harness that drives `hermes-mcp`'s tools. Not built yet.

---

## Config

One repo-root `.env` (git-ignored) is shared. See [`.env.example`](./.env.example).
- `gemini_key` — **required.** Gemini Live API key. Baked into the connector APK by `build.sh`; also carried in `hermes-core` for the smoke test.
- `hermes_ws_url`, `hermes_device_id`, `hermes_token` — the connector's link to `hermes-core` (baked into the APK). Unset → the link is disabled and inbound calls run on the baked-in fallback persona.
- `max_call_ms` — connector watchdog cap (default 600000).

`hermes-core` also reads its own [`hermes-core/.env.example`](./hermes-core/.env.example) (`DATABASE_URL`, `REDIS_URL`, `PHONE_AGENT_CONTROL_TOKEN`, `MODEL_API_KEY`, …).
`hermes-mcp` reads its own [`hermes-mcp/.env.example`](./hermes-mcp/.env.example) (`HERMES_MCP_PORT`, `HERMES_CORE_URL`) plus the repo-root `PHONE_AGENT_CONTROL_TOKEN` — the same token both ways, see its README.
`twilio-connector` reads its own [`twilio-connector/.env.example`](./twilio-connector/.env.example).

## Quickstart

```sh
# hermes-core — dev (in-process Postgres + local bus, no Docker)
cd hermes-core && npm install && npm test && npm start   # :8787, dashboard at /

# hermes-mcp — the MCP tool-call layer over hermes-core's REST API
cd hermes-mcp && npm install && npm test && npm start     # :8788, proxies to :8787

# twilio-connector — Twilio voice bridge (needs Twilio creds + public URL)
cd twilio-connector && npm install && npm test && npm start

# phone-connector — build + deploy to the device (see phone-connector/DEPLOY.md)
bash phone-connector/build.sh
bash phone-connector/selftest.sh                          # host-JVM pure-logic tests
```
