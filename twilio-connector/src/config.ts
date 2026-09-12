import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");

/** Tiny .env reader — merges repo-root .env then twilio-connector/.env, strips surrounding quotes. */
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
      if (v === "") continue; // set-but-empty means "use the default"
      out[m[1]!] = v;
    }
  }
  return { ...out, ...process.env } as Record<string, string>;
}

const env = loadEnv();

export const config = {
  port: Number(env.TWILIO_CONNECTOR_PORT ?? 8789),
  /** hermes-core's phone WSS endpoint. */
  hermesWsUrl: env.HERMES_WS_URL ?? "ws://localhost:8787/phone",
  /** Shared bearer, same value as hermes-core's PHONE_AGENT_CONTROL_TOKEN. */
  phoneToken: env.PHONE_AGENT_CONTROL_TOKEN ?? "smoke-token",
  /** This connector's device id — must be unique across every connected device. */
  deviceId: env.DEVICE_ID ?? "twilio-main",
  /** Twilio account (Console > Account > API keys & tokens). */
  twilioAccountSid: env.TWILIO_ACCOUNT_SID ?? "",
  twilioAuthToken: env.TWILIO_AUTH_TOKEN ?? "",
  twilioNumber: env.TWILIO_NUMBER ?? "",
  /** Public HTTPS base Twilio can reach (Cloudflare Tunnel hostname), no trailing slash. */
  publicBaseUrl: (env.PUBLIC_BASE_URL ?? "").replace(/\/$/, ""),
  /** Gemini Live API key (repo-root .env: gemini_key — same key phone-connector uses). */
  geminiApiKey: env.gemini_key ?? env.GEMINI_API_KEY ?? "",
};

export { repoRoot };
