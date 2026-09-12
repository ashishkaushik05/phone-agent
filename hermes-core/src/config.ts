import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");

/** Tiny .env reader — merges repo-root .env then hermes-core/.env, strips surrounding quotes. */
function loadEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of [join(repoRoot, ".env"), join(here, "..", ".env")]) {
    let raw: string;
    try {
      raw = readFileSync(p, "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n")) {
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
      if (!m || line.trimStart().startsWith("#")) continue;
      const v = m[2]!.trim().replace(/^["']|["']$/g, "");
      if (v === "") continue; // set-but-empty (e.g. `DIRECTOR_MODE=`) means "use the default"
      out[m[1]!] = v;
    }
  }
  return { ...out, ...process.env } as Record<string, string>;
}

const env = loadEnv();

export const config = {
  port: Number(env.HERMES_PORT ?? 8787),
  /** Bearer token the phone-connector presents on the WSS link. */
  phoneToken: env.PHONE_AGENT_CONTROL_TOKEN ?? "smoke-token",
  /** Gemini Live API key (repo-root .env: gemini_key). Only the mock phone uses it in Phase 0. */
  geminiApiKey: env.gemini_key ?? env.GEMINI_API_KEY ?? "",
  /** "rules" (deterministic, no external calls) or "muse" (Meta Model API). */
  directorMode: (env.DIRECTOR_MODE ?? (env.MODEL_API_KEY ? "muse" : "rules")) as "rules" | "muse",
  /** Meta Model API — serves Muse Spark / Muse Code. OpenAI-SDK compatible. */
  museApiKey: env.MODEL_API_KEY ?? env.META_API_KEY ?? "",
  museBaseUrl: env.MUSE_BASE_URL ?? "https://api.meta.ai/v1",
  directorModel: env.DIRECTOR_MODEL ?? "muse-spark-1.2",
  /** Owner's real phone, E.164 — where the director WhatsApps a caller's message. Empty → no target. */
  ownerWhatsapp: env.OWNER_WHATSAPP ?? "",
  /** Postgres connection string; empty → in-process PGlite (dev/tests). */
  databaseUrl: env.DATABASE_URL ?? "",
  /** Redis connection string; empty → no external queue (Phase 1). */
  redisUrl: env.REDIS_URL ?? "",
};

export { repoRoot };
