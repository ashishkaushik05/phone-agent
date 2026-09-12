import { describe, it, expect, vi } from "vitest";
import { freshDb } from "./test/db.ts";
import { makeRepos } from "./repos/index.ts";
import { reviewCall } from "./director-review.ts";
import type { DirectorChat } from "./director.ts";

async function seedEndedCall(repos: ReturnType<typeof makeRepos>) {
  await repos.calls.create({ id: "r1", direction: "outbound", toNumber: "+15550001111", status: "active" });
  await repos.calls.appendTranscript("r1", 0, "agent", "Hi, confirming your Tuesday 3pm appointment.");
  await repos.calls.appendTranscript("r1", 1, "caller", "Yes that works, thanks.");
  await repos.calls.finalize("r1", "agent_ended");
}

describe("reviewCall", () => {
  it("writes an outcome summary and a notification row (chat path)", async () => {
    const db = await freshDb();
    const repos = makeRepos(db);
    await seedEndedCall(repos);
    const chat: DirectorChat = {
      create: vi.fn(async () => ({ choices: [{ message: { content: "Appointment confirmed for Tuesday 3pm." } }] })),
    };
    const out = await reviewCall("r1", repos, { chat });
    expect(out.outcomeSummary).toContain("Tuesday 3pm");

    const detail = await repos.calls.get("r1");
    expect(detail?.outcomeSummary).toContain("Tuesday 3pm");

    const notes = await db.query<{ text: string }>(`SELECT text FROM hermes.notifications WHERE call_id = 'r1'`);
    expect(notes.rows).toHaveLength(1);
  });

  it("falls back to a deterministic summary when chat throws", async () => {
    const db = await freshDb();
    const repos = makeRepos(db);
    await seedEndedCall(repos);
    const chat: DirectorChat = { create: vi.fn(async () => { throw new Error("down"); }) };
    const out = await reviewCall("r1", repos, { chat });
    expect(out.outcomeSummary).toMatch(/outbound call/i);
    expect(out.outcomeSummary).toMatch(/agent_ended/);
  });
});
