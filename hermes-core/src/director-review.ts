import { config } from "./config.ts";
import type { Repos } from "./repos/index.ts";
import type { DirectorChat } from "./director.ts";
import { defaultChat } from "./muse-client.ts";

export async function reviewCall(
  callId: string,
  repos: Repos,
  deps: { chat?: DirectorChat } = {},
): Promise<{ outcomeSummary: string; ownerNotification: string }> {
  const call = await repos.calls.get(callId);
  if (!call) throw new Error(`reviewCall: no call ${callId}`);

  const deterministic =
    `${call.direction} call with ${call.fromNumber ?? call.toNumber ?? "unknown"}, ` +
    `ended ${call.endReason ?? "unknown"}, ${call.transcript.length} turns`;

  let outcomeSummary = deterministic;
  if (deps.chat || (config.directorMode === "muse" && config.museApiKey)) {
    try {
      const chat = deps.chat ?? defaultChat();
      const transcript = call.transcript.map((t) => `${t.role.toUpperCase()}: ${t.text}`).join("\n");
      const res = await chat.create({
        model: config.directorModel,
        max_tokens: 1200, // muse-spark reasons ~300 tokens before the summary text
        messages: [
          { role: "system", content: "Summarize how this phone call went in 1-3 sentences. State the concrete outcome (what was agreed, what the other party said, any follow-up needed). No preamble." },
          { role: "user", content: `Direction: ${call.direction}\nEnded: ${call.endReason}\n\n${transcript}` },
        ],
      });
      outcomeSummary = res.choices[0]?.message.content?.trim() || deterministic;
    } catch (e) {
      console.error("[review] chat summary failed, using deterministic:", (e as Error).message);
    }
  }

  await repos.calls.setOutcomeSummary(callId, outcomeSummary);

  const peer = call.fromNumber ?? call.toNumber ?? "unknown";
  const ownerNotification = `${call.direction === "inbound" ? "Call from" : "Called"} ${peer}: ${outcomeSummary}`;
  await insertNotification(repos, callId, ownerNotification);

  return { outcomeSummary, ownerNotification };
}

async function insertNotification(repos: Repos, callId: string, text: string): Promise<void> {
  // CallsRepo holds the Db; expose it via a tiny cast rather than threading Db everywhere.
  const db = (repos.calls as unknown as { db: { query: (t: string, p?: unknown[]) => Promise<unknown> } }).db;
  await db.query(`INSERT INTO hermes.notifications (call_id, channel, text) VALUES ($1, 'log', $2)`, [callId, text]);
}
