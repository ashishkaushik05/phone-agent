# Deploying hermes-core

**Live since 2026-09-12** on the `prod` VPS — see
[`../deploy/README.md`](../deploy/README.md) for the actual deployment record
(what's really running, hostnames, gotchas hit). What follows below is the
general single-container recipe; the real deployment used a **dedicated**
Postgres container (not the VPS's shared Supabase one — deliberately
isolated from other apps on that box) and no Redis (single instance, local
bus is enough), via [`../deploy/docker-compose.yml`](../deploy/docker-compose.yml)
rather than the `docker-compose.yml` in this directory.

Single container. Can point at any Postgres + Cloudflare Tunnel.

## 1. Database
`hermes-core` runs `migrate()` on boot (from `src/main.ts`) against `DATABASE_URL`. Point it at
the existing Supabase Postgres. All objects live in schema `hermes` — no conflict with Supabase's
own tables.

## 2. Env
Set in `.env` next to `docker-compose.yml`:
- `PHONE_AGENT_CONTROL_TOKEN` — shared secret; also goes in the phone-connector build.
- `DATABASE_URL` — `postgres://USER:PASS@HOST:5432/postgres`
- `REDIS_URL` — `redis://HOST:6379` (optional; without it, single-instance mode)
- `MODEL_API_KEY` — Meta Model API key from dev.meta.ai
- `gemini_key` — the Gemini Live key (carried through for parity; phone holds its own copy)

## 3. Run
`docker compose up -d --build`

## 3a. WhatsApp session (Baileys)
`hermes-core` writes its WhatsApp session to `data/whatsapp-auth/`, resolved relative to
`src/main.ts`'s own location (not `cwd`) — inside the container that's `/app/data/whatsapp-auth`
(the `Dockerfile`'s `WORKDIR /app`, with `src/` copied under it). Created automatically on first
write (see §3a below).
`docker-compose.yml` already mounts this as a named volume (`whatsapp-auth`) so a redeploy
doesn't force re-pairing.

First boot starts "unpaired" — open the dashboard's WhatsApp tab and click **Pair device** to
scan the QR (one-time; the session then persists in the volume across restarts/redeploys).

## 4. Ingress (existing Cloudflare Tunnel)
Add two hostnames to the existing `cloudflared` config's ingress list, both → `http://localhost:8787`:
- `phonectl.<domain>` — the phone-connector connects its WSS to `wss://phonectl.<domain>/phone`
- `hermes.<domain>` — the dashboard

No new tunnel, no new firewall port, no new TLS cert.

## 5. Verify
- `curl https://hermes.<domain>/health` → `{"ok":true,...}`
- open `https://hermes.<domain>/` → dashboard loads
- `smoke/run-smoke.sh` still passes locally against the container (set `HERMES_PORT`, `DATABASE_URL`).
