# hermes-mcp

An MCP (Model Context Protocol) server that exposes every `hermes-core` REST
capability as a tool call — the harness-facing layer (one tool per REST
route, over Streamable HTTP; see `src/tools.ts`).

**Status: implemented and unit-tested (2026-09-12).** 35 tests green, `tsc`
clean. Manually round-tripped against a real hermes-core over a real MCP
Streamable HTTP session (initialize → tools/list → tools/call, both a
success and an error path) — not yet exercised by an actual MCP-speaking
harness/agent.

## What it is

A thin, stateless adapter: every tool call is exactly one REST call to
`hermes-core`, no more. It holds no state of its own — no DB, no in-memory
call tracking — and never touches hermes-core's internals directly, only
its public REST API. This keeps the two independently deployable and keeps
hermes-core free to change internally as long as its REST contract holds.

```
harness / agent  ──MCP (Streamable HTTP)──▶  hermes-mcp  ──REST (bearer)──▶  hermes-core
```

## Layout

```
src/
  config.ts        # env loader (repo-root .env + hermes-mcp/.env + process.env)
  hermesClient.ts   # the only way this adapter reaches hermes-core — fetch + auth + error mapping
  tools.ts          # one HermesTool per REST endpoint: input schema (zod) + request builder
  server.ts         # buildHttpServer() — bearer-gated /mcp, stateless per-request McpServer+transport
  main.ts           # entrypoint: config + buildHttpServer + listen
```

## Run the tests

```sh
npm install
npm test         # vitest — 35 tests, fakes fetch, no real hermes-core needed
npm run typecheck
```

## Run it

```sh
npm start        # :8788, proxies to hermes-core at HERMES_CORE_URL (default :8787)
```

Point any MCP client at `http://localhost:8788/mcp` with
`Authorization: Bearer <PHONE_AGENT_CONTROL_TOKEN>` — every request needs it,
GETs included, unlike hermes-core's own REST API (which leaves reads open).

## Tools

One tool per `hermes-core` REST endpoint — 19 total: persona and contact
CRUD (`list_personas`, `get_persona`, `upsert_persona`, `delete_persona`,
`list_contacts`, `upsert_contact`, `delete_contact`), call control
(`list_calls`, `get_call`, `place_call`, `hangup_call`, `inject_guidance`),
messaging (`list_sms`, `send_sms`, `list_whatsapp`, `send_whatsapp`,
`whatsapp_status`, `whatsapp_pair`), and `get_status`. See
[`src/tools.ts`](./src/tools.ts) for exact input schemas, or call
`tools/list` on a running server.

A non-2xx REST response (or hermes-core being unreachable) becomes a clean
MCP tool error (`isError: true`) with a plain-text message — never a thrown
error or a broken connection.

## Why stateless Streamable HTTP

Every tool is a stateless REST proxy with nothing to preserve between
calls, so a persistent multi-request MCP session buys nothing but
complexity. `buildHttpServer` builds a fresh `McpServer` + transport per
request (`sessionIdGenerator: undefined`), torn down once the response
closes — the standard pattern for a stateless MCP HTTP server, and the only
one that supports more than one concurrent client (a single shared
stateful transport rejects a second client's `initialize` outright).

## Config

Copy `.env.example` → `.env`, or rely on the repo-root `.env` (same pattern
as `hermes-core`/`phone-connector`):
- `HERMES_MCP_PORT` — default `8788`.
- `HERMES_CORE_URL` — default `http://localhost:8787`.
- `PHONE_AGENT_CONTROL_TOKEN` — **shared** with hermes-core's own token: sent
  as this adapter's bearer to hermes-core, and required from any MCP client
  calling this server. One secret, one trust domain — see the design spec §3.
