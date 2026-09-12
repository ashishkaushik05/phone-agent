import OpenAI from "openai";
import { config } from "./config.ts";
import type { DirectorChat } from "./director.ts";

let client: OpenAI | null = null;

/** Lazily-constructed OpenAI-SDK client pointed at the Meta Model API (Muse). */
export function defaultChat(): DirectorChat {
  client ??= new OpenAI({ apiKey: config.museApiKey, baseURL: config.museBaseUrl });
  return { create: (args) => client!.chat.completions.create({ ...args, stream: false }) as any };
}
