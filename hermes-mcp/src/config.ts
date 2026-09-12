import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");

/** Tiny .env reader — merges repo-root .env then hermes-mcp/.env, strips surrounding quotes.
 *  Mirrors hermes-core/src/config.ts's loadEnv so both components read the same repo-root
 *  .env the same way. */
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
  port: Number(env.HERMES_MCP_PORT ?? 8788),
  hermesCoreUrl: env.HERMES_CORE_URL ?? "http://localhost:8787",
  /** Shared bearer — sent to hermes-core, and required from any MCP client calling this server. */
  token: env.PHONE_AGENT_CONTROL_TOKEN ?? "smoke-token",
};

export { repoRoot };
