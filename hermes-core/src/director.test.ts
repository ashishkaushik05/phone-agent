import { describe, it, expect, vi } from "vitest";
import { decide, trimHistory, type ChatMsg, type DirectorChat } from "./director.ts";
import type { TriggerHit } from "./call-engine.ts";

const call = { id: "t1", personaName: "Default reception", transcript: [
  { seq: 0, role: "caller" as const, text: "when can you come out?", ts: 0 },
] };

function chatReturning(toolCalls: { name: string; args: object }[], then?: string): DirectorChat {
  let turn = 0;
  return {
    create: vi.fn(async () => {
      if (turn++ === 0) {
        return { choices: [{ message: { content: null, tool_calls: toolCalls.map((t, i) => ({
          id: `tc${i}`, function: { name: t.name, arguments: JSON.stringify(t.args) },
        })) } }] };
      }
      return { choices: [{ message: { content: then ?? "done" } }] };
    }),
  };
}

describe("director (muse tool loop)", () => {
  it("turns an inject_guidance tool call into a wrapped DirectorAction.inject", async () => {
    const chat = chatReturning([{ name: "inject_guidance", args: { guidance: "availability is Thursday 9am or 2pm" } }]);
    const hit: TriggerHit = { category: "needsData", matched: "when can" };
    const { action } = await decide(call, hit, { chat });
    expect(action?.inject).toContain("<<DIRECTOR - act silently:");
    expect(action?.inject).toContain("Thursday 9am");
  });

  it("turns end_call into a hangup action", async () => {
    const chat = chatReturning([{ name: "end_call", args: { reason: "aborted_off_script" } }]);
    const { action } = await decide(call, { category: "offScript", matched: "you are now" }, { chat });
    expect(action?.hangup?.reason).toBe("aborted_off_script");
  });

  it("falls back to the rules brain when the chat client throws", async () => {
    const chat: DirectorChat = { create: vi.fn(async () => { throw new Error("meta api down"); }) };
    const { action } = await decide(call, { category: "needsData", matched: "when can" }, { chat });
    expect(action?.inject).toContain("<<DIRECTOR");
  });

  it("resolves check_availability via injected context", async () => {
    const chat = chatReturning([{ name: "check_availability", args: {} }]);
    const context = { checkAvailability: vi.fn(async () => "Fri 10am only") };
    // after the tool result the model responds with no further tool calls -> null action unless it also injected
    const { action } = await decide(call, { category: "needsData", matched: "when can" }, { chat, context });
    expect(context.checkAvailability).toHaveBeenCalled();
    expect(action).not.toBeUndefined();
  });

  it("resolves send_whatsapp via injected context, defaulting `to` to \"\" when the model omits it", async () => {
    const chat = chatReturning([{ name: "send_whatsapp", args: { body: "see you Thursday" } }]);
    const context = { sendWhatsapp: vi.fn(async () => "sent (status: sent)") };
    const { action } = await decide(call, { category: "needsData", matched: "when can" }, { chat, context });
    expect(context.sendWhatsapp).toHaveBeenCalledWith("", "see you Thursday");
    expect(action).not.toBeUndefined();
  });

  it("resolves send_whatsapp's explicit `to` when the model provides one", async () => {
    const chat = chatReturning([{ name: "send_whatsapp", args: { to: "+15551230000", body: "hi" } }]);
    const context = { sendWhatsapp: vi.fn(async () => "sent (status: sent)") };
    await decide(call, { category: "needsData", matched: "when can" }, { chat, context });
    expect(context.sendWhatsapp).toHaveBeenCalledWith("+15551230000", "hi");
  });

  it("threads conversation history across successive triggers within one call", async () => {
    const seen: { role: string; content: string | null }[][] = [];
    const chat: DirectorChat = {
      create: vi.fn(async ({ messages }) => {
        seen.push(messages.map((m: any) => ({ role: m.role, content: m.content })));
        return { choices: [{ message: { content: `director-reply-${seen.length}` } }] };
      }),
    };

    const hit1: TriggerHit = { category: "needsData", matched: "when can" };
    const hit2: TriggerHit = { category: "closing", matched: "thanks bye" };

    const first = await decide(call, hit1, { chat, history: [] });
    await decide(call, hit2, { chat, history: first.history });

    // seen[1] is the messages array the 2nd trigger's first model call received
    expect(seen.length).toBeGreaterThanOrEqual(2);
    const second = seen[1]!;
    const systemCount = second.filter((m) => m.role === "system").length;
    expect(systemCount).toBe(1);
    // hit1's user (trigger) message carried forward
    expect(second.some((m) => m.role === "user" && (m.content ?? "").includes(`needsData ("when can")`))).toBe(true);
    // hit1's assistant reply carried forward
    expect(second.some((m) => m.role === "assistant" && m.content === "director-reply-1")).toBe(true);
    // and the new trigger's own user message is present
    expect(second.some((m) => m.role === "user" && (m.content ?? "").includes(`closing ("thanks bye")`))).toBe(true);
  });

  it("a follow-up trigger's user message carries only the NEW turns, not the whole transcript", async () => {
    const seen: { role: string; content: string | null }[][] = [];
    const chat: DirectorChat = {
      create: vi.fn(async ({ messages }) => {
        seen.push(messages.map((m: any) => ({ role: m.role, content: m.content })));
        return { choices: [{ message: { content: `reply-${seen.length}` } }] };
      }),
    };

    const t = (n: number) => ({ seq: n, role: "caller" as const, text: `turn-${n}`, ts: n });
    const call5 = { id: "q1", personaName: "Default", transcript: [1, 2, 3, 4, 5].map(t) };
    const call8 = { id: "q1", personaName: "Default", transcript: [1, 2, 3, 4, 5, 6, 7, 8].map(t) };

    const first = await decide(call5, { category: "needsData", matched: "x" }, { chat, history: [], sinceSeq: 0 });
    await decide(call8, { category: "closing", matched: "y" }, { chat, history: first.history, sinceSeq: 5 });

    const secondUser = seen[1]!.filter((m) => m.role === "user").at(-1)!.content ?? "";
    expect(secondUser).toContain("turn-6");
    expect(secondUser).toContain("turn-8");
    expect(secondUser).not.toContain("turn-1");
    expect(secondUser).not.toContain("turn-5");
  });
});

describe("trimHistory", () => {
  it("caps at 20 and never leaves a tool/assistant turn orphaned at the head", () => {
    // 8 tool-using triggers: user, assistant(+tool_calls), tool  ×8  = 24 non-system msgs
    const messages: ChatMsg[] = [{ role: "system", content: "SYS" }];
    for (let t = 0; t < 8; t++) {
      messages.push({ role: "user", content: `trigger ${t}` });
      messages.push({ role: "assistant", content: "", tool_calls: [{ id: `tc${t}` }] });
      messages.push({ role: "tool", tool_call_id: `tc${t}`, content: "ok" });
    }

    const out = trimHistory(messages);

    // (a) cap
    expect(out.length).toBeLessThanOrEqual(20);
    // (b) system first
    expect(out[0]?.role).toBe("system");
    // (c) first non-system turn is a user
    expect(out[1]?.role).toBe("user");
    // (d) no tool message precedes its assistant — walk, tracking whether an
    // assistant has been seen since the last user
    let assistantSeen = false;
    for (const m of out) {
      if (m.role === "user") assistantSeen = false;
      if (m.role === "assistant") assistantSeen = true;
      if (m.role === "tool") expect(assistantSeen).toBe(true);
    }
  });

  it("drops a window that has no user head instead of starting on a tool turn", () => {
    const messages: ChatMsg[] = [
      { role: "system", content: "SYS" },
      { role: "assistant", content: "", tool_calls: [{ id: "tc0" }] },
      { role: "tool", tool_call_id: "tc0", content: "ok" },
      { role: "tool", tool_call_id: "tc0", content: "ok" },
      { role: "tool", tool_call_id: "tc0", content: "ok" },
    ];
    const out = trimHistory(messages);
    expect(out).toEqual([{ role: "system", content: "SYS" }]);
    expect(out.some((m) => m.role === "tool")).toBe(false);
  });

  it("passes a short history through unchanged", () => {
    const messages: ChatMsg[] = [
      { role: "system", content: "SYS" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "ok" },
    ];
    expect(trimHistory(messages)).toEqual(messages);
  });
});
