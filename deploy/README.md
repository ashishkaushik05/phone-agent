# VPS deployment (prod, 2026-09-12)

`hermes-core` + `hermes-mcp` run in production on the `prod` VPS
(`<your-vps-ip>`, alongside Twenty CRM, Akaunting, Supabase, Coolify, and
your pre-existing **Hermes Agent Gateway** — an unrelated product, see the
naming note below). This directory holds the compose file and deploy notes;
secrets live only in `deploy/.env` on the VPS itself (git-ignored).

## Layout on the VPS

```
/srv/phone-agent/
  hermes-core/      # rsync'd from this repo (no .git, no node_modules)
  hermes-mcp/
  deploy/
    docker-compose.yml   # this directory, rsync'd
    .env                 # real secrets — never committed, VPS-only
```

Three containers, one compose project (`docker compose` run from
`/srv/phone-agent/deploy`): `postgres` (dedicated `postgres:16-alpine`, own
volume — **not** shared with supabase-db, coolify-db, or the box's native
`:5432` postgres), `hermes-core`, `hermes-mcp`. `hermes-mcp` talks to
`hermes-core` over the compose network (`http://hermes-core:8787`), not the
public internet. Both app ports are published as `127.0.0.1:PORT:PORT` —
loopback only, reachable solely through the Cloudflare Tunnel (Docker is
known to bypass ufw via its own iptables rules, so binding to `0.0.0.0`
would have actually been reachable from the open internet despite ufw).

## Cloudflare Tunnel

A **new**, dedicated, persistent named tunnel — `phone-agent-vps`
(`<tunnel-id>`) — created with the account's
existing origin cert (`/srv/twenty/.cloudflared/cert.pem`, used originally
for the Twenty CRM tunnel; same account manages this one too). An
already-existing tunnel named `phone-server` was found (idle, 0
connections, no local credentials on this box — likely created elsewhere,
provenance unknown) and deliberately **not** reused, to avoid depending on
credentials that don't exist here.

Runs as a systemd service (`cloudflared.service`, `/etc/cloudflared/config.yml`
+ `/etc/cloudflared/<tunnel-id>.json`), so it survives reboots — this
replaces the old local-dev pattern of a disposable `cloudflared tunnel --url`
quick tunnel whose hostname changed every restart.

**Domain note:** the account's DNS-edit permission (via this origin cert)
is scoped to `example.com`, not `example-alt.net`, even though `example-alt.net` uses
the same Cloudflare nameservers — `cloudflared tunnel route dns` for an
`example-alt.net` hostname silently created an inert stray record
(`phone.example-alt.net.example.com` / `phone-mcp.example-alt.net.example.com`, still
sitting in the zone, harmless — matches no ingress rule so it 404s; couldn't
delete via CLI, needs dashboard access). The real, working hostnames are:

| Hostname | Routes to |
|---|---|
| `phone.example.com` | `hermes-core` (REST, WSS `/phone`, `/dashboard`) |
| `phone-mcp.example.com` | `hermes-mcp` (`/mcp`) |

## Naming collision — read this before touching anything under `/root/.hermes`

This VPS already runs a **separate, pre-existing, unrelated** product also
called "Hermes" — the **Hermes Agent Gateway** (`hermes-gateway.service`,
root-owned, `/usr/local/lib/hermes-agent`, `HERMES_HOME=/root/.hermes`): a
personal AI assistant with Telegram/Slack/WhatsApp integration, kanban,
skills, cron, running on the same Muse Spark model our own director uses.
**It is not part of this project.** "hermes-core" / "hermes-mcp" here are
this repo's own components; "Hermes Agent" is theirs, came first, and nothing
in this repo should modify it beyond the one MCP registration below.

## Wiring `hermes-mcp` into the Hermes Agent Gateway

The gateway has a first-class MCP client (`hermes mcp add/list/test/...`).
Registered as:

```yaml
# /root/.hermes/config.yaml
mcp_servers:
  phone-agent:
    url: http://localhost:8788/mcp
    headers:
      Authorization: Bearer ${MCP_PHONE_AGENT_API_KEY}
    enabled: true
```

`MCP_PHONE_AGENT_API_KEY` (the shared `PHONE_AGENT_CONTROL_TOKEN` value) is
stored in `/root/.hermes/.env`. Verify with:

```sh
sudo -H /usr/local/lib/hermes-agent/venv/bin/python -m hermes_cli.main mcp test phone-agent
```

should report `✓ Connected` and `Tools discovered: 19`. After any config
change, reload (not restart — keeps the process, no downtime) with:

```sh
sudo systemctl reload hermes-gateway.service
```

**Gotcha hit during setup:** `hermes mcp add ... --auth header`'s own
pre-save connectivity test failed with 401 even with the correct token
(looked like a stale-value bug in its own add-flow), which auto-disables
the new entry. `hermes mcp test <name>` — a separate, freshly-run
command — worked immediately with the exact same stored value. If `mcp add`
reports a failure, don't trust it: fix/verify the stored
`MCP_<NAME>_API_KEY` value in `.env` directly, flip `enabled: true` in
`config.yaml`, then confirm with `mcp test`, not by re-running `mcp add`.

## Redeploying

```sh
# from your machine
rsync -az --delete --exclude node_modules --exclude .env --exclude data \
  hermes-core/ deploy@<your-vps-ip>:/srv/phone-agent/hermes-core/ \
  -e "ssh -p <ssh-port> -i ~/.ssh/vps_key"
rsync -az --delete --exclude node_modules --exclude .env \
  hermes-mcp/ deploy@<your-vps-ip>:/srv/phone-agent/hermes-mcp/ \
  -e "ssh -p <ssh-port> -i ~/.ssh/vps_key"

# on the VPS
cd /srv/phone-agent/deploy
sudo docker compose --env-file .env up -d --build
```

`deploy/.env` on the VPS is the source of truth for secrets — `PHONE_AGENT_CONTROL_TOKEN`,
`POSTGRES_PASSWORD`, `MODEL_API_KEY`, `DIRECTOR_MODEL`, `OWNER_WHATSAPP`. See
`.env.example` in this directory for the full list; generate real random
values, never reuse dev defaults like `smoke-token`.

## What did NOT move to the VPS

- **WhatsApp pairing.** The Baileys session (`whatsapp-auth` docker volume)
  is fresh on the VPS — the dev-machine pairing doesn't transfer. Needs one
  QR re-scan via the dashboard at `https://phone.example.com/` after first
  deploy.
- **The phone-connector's `hermes_ws_url`** — rebuilt and redeployed
  separately to point at `wss://phone.example.com/phone` instead of the old
  disposable local quick-tunnel URL; see the repo-root `.env` and
  `phone-connector/DEPLOY.md`.
- Local dev (`hermes-core`/`hermes-mcp` running directly via `npm start` on
  your machine, its own disposable `cloudflared tunnel --url`) is untouched
  and still works independently for local iteration — it's a completely
  separate hermes-core instance/database from the VPS one.
