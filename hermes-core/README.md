# hermes-core

The VPS brain for the Hermes phone system: phone-control API + call-steering
director. See the repo-root [README](../README.md) for the system overview.

**Status: Phase 1 (+ Phase 3 WhatsApp, 2026-09-12).** Postgres-backed (schema `hermes`;
in-process PGlite when `DATABASE_URL` is unset). Per-caller persona resolution, the
Muse-Spark director tool loop (`rules` fallback), post-call review,
persona/contact/call/SMS/WhatsApp REST CRUD, a no-build web dashboard, Redis
dashboard fan-out (local-bus fallback), and a Docker image. WhatsApp (Baileys) runs
entirely here — no `phone-connector`/Android involvement, unlike calls/SMS.
The Android `phone-connector` call/SMS side is documented in
[`../phone-connector/README.md`](../phone-connector/README.md).

**Dashboard (redesigned 2026-09-05).** Vanilla HTML/JS/CSS "command console" UI —
calls (live transcript, silent inject, end call), personas (edit instruction +
trigger keywords), contacts, SMS threads, WhatsApp threads + pairing card,
connected devices. One WebSocket
(`/dashboard?token=...`, gated by `PHONE_AGENT_CONTROL_TOKEN` — pass it in the
query string since a browser `WebSocket` can't set an `Authorization` header) is
the live-update source of truth, with exponential-backoff reconnect and a
bad-token detector; there is no blind polling loop. Design reference (validated
before implementation): https://claude.ai/code/artifact/a6029868-ed4d-4edb-b24e-3afb5fd01306.

## Layout

```
src/
  config.ts          # env loader (repo-root .env + hermes-core/.env + process.env)
  protocol.ts        # phone <-> core WebSocket message types (frozen)
  db.ts              # Db interface — makePgDb (pg) / makePgliteDb (in-process, tests)
  migrate.ts         # runs migrations/*.sql on boot
  migrations/        # 001_init.sql (schema) ... 005_sms_status.sql, 006_whatsapp_messages.sql
  persona-rules.ts   # shared HARD RULES block (identity lock, DIRECTOR-only steering,
                     #   "speak slowly") + DEFAULT_TRIGGER_CONFIG; withHardRules / stripHardRules
  repos/             # personas / contacts / calls / sms / whatsapp repos + resolvePersona; index.ts = makeRepos
  whatsapp.ts        # Baileys wrapper: the one socket, pairing state machine, send/receive
  call-engine.ts     # per-call state, keyword trigger matcher, director dispatch, persistence
  director.ts        # trigger-based supervisor: Muse Spark tool loop | rules brain
  director-tools.ts  # the director tools (inject_guidance, end_call, check_availability, send_whatsapp, ...)
  director-review.ts # post-call outcome summary + owner notification
  http.ts            # REST route handlers + static dashboard serving
  server.ts          # buildServer() — side-effect-free, exported for tests
  main.ts            # entrypoint: db + migrate + repos + engine + buildServer + listen
  redis.ts           # Bus (makeBus / makeLocalBus) + mirrorCall
  dashboard/         # index.html + app.js + style.css — the command-console UI, vanilla, no build
smoke/
  mock-phone.mjs     # stands in for the Android phone-connector
  scenarios/*.json   # scripted caller lines
  run-smoke.sh       # boots core, runs the mock phone, asserts persistence
```

## Run the tests

```sh
npm install
npm test               # vitest — 120 tests across 19 files, uses in-process PGlite
npm run typecheck      # tsc --noEmit
```

## Run the end-to-end smoke

```sh
bash smoke/run-smoke.sh                 # smoke/scenarios/reception.json
bash smoke/run-smoke.sh smoke/scenarios/quick.json
```

Boots `hermes-core` on fresh in-process PGlite, connects `mock-phone.mjs` (which
opens a **real** `gemini-3.1-flash-live-preview` session using `gemini_key` from
the repo-root `.env`), drives a scripted call, then asserts the call + transcript
+ director actions persisted (`call <id>: N turns, M actions, status=ended`).

## Run the server / dashboard

```sh
npm start                              # :8787 — dashboard at http://localhost:8787/
curl localhost:8787/health
```

### Place an outbound call — `POST /calls`

`{ to, persona_id?, script?, device_id? }` (bearer-auth). Persona resolution:

| body | agent runs on |
|---|---|
| `persona_id` only | that saved persona |
| `persona_id` + `script` | that persona, with `script` folded in as a per-call goal (HARD RULES kept last) |
| `script` only | an ad-hoc persona built from the script text (not persisted) |
| neither | the `default` persona |

Unknown `persona_id` → `404`. `device_id` may be omitted when exactly one phone is
connected; `0` or `2+` connected without it → `409`.

```sh
curl -s -XPOST localhost:8787/calls -H 'authorization: Bearer smoke-token' \
  -H 'content-type: application/json' \
  -d '{"to":"+15551230000","persona_id":"appointment-booker","script":"Confirm Tue 3pm with Dr. Lee."}'
```

In the **dashboard**, the Calls tab has a **＋ New call** button: number + persona
dropdown + optional per-call script, then *Place call*. The new call appears in the
list and moves queued → dialing → active off the existing WS `status` events.

### Preset personas

`004_seed_personas.sql` seeds four alongside `default` (all `is_default = false`,
editable/deletable in the dashboard):

| id | direction | purpose |
|---|---|---|
| `appointment-booker` | outbound | book / confirm / reschedule an appointment on the owner's behalf |
| `info-gatherer` | outbound | get one specific fact (a price, hours, an order status), confirm it, end |
| `call-screener` | inbound | screen unknown callers, decline sales/spam, take a message for genuine ones |
| `after-hours` | inbound | outside hours — take a detailed message + callback, no scheduling |

## Deploy (Docker)

```sh
docker compose up -d --build
```

Env-only wiring — points at the existing VPS Supabase Postgres + Redis + Cloudflare
Tunnel. See [`DEPLOY.md`](./DEPLOY.md).

## Config

Copy `.env.example` → `.env` (or set env vars):
- `DATABASE_URL` — Postgres; unset → in-process PGlite (dev/tests).
- `REDIS_URL` — optional; unset → single-instance local bus.
- `PHONE_AGENT_CONTROL_TOKEN` — bearer for the `/phone` link and mutating REST (default `smoke-token`).
- `MODEL_API_KEY` — Meta Model API key ([dev.meta.ai](https://dev.meta.ai)); set → director runs on Muse Spark (`muse-spark-1.2`), else the deterministic `rules` brain.
- `OWNER_WHATSAPP` — owner's real phone, E.164; when set, the director WhatsApps them a caller's message once it's complete (via `send_whatsapp`).
