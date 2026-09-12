import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    hookTimeout: 30_000,
    testTimeout: 20_000,
    // Force the deterministic rules brain — process.env wins in config.ts loadEnv(),
    // so tests never hit the live Muse API even when hermes-core/.env sets MODEL_API_KEY.
    env: { DIRECTOR_MODE: "rules" },
  },
});
