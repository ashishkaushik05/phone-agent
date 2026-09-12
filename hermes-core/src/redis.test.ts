import { describe, it, expect, vi } from "vitest";
import { makeLocalBus } from "./redis.ts";

describe("local bus", () => {
  it("delivers published events to subscribers", async () => {
    const bus = makeLocalBus();
    const seen: any[] = [];
    await bus.subscribe((callId, ev) => seen.push({ callId, ev }));
    await bus.publish("c1", { kind: "transcript", text: "hi" });
    await new Promise((r) => setImmediate(r));
    expect(seen).toEqual([{ callId: "c1", ev: { kind: "transcript", text: "hi" } }]);
    await bus.close();
  });

  it("supports multiple subscribers", async () => {
    const bus = makeLocalBus();
    const a = vi.fn();
    const b = vi.fn();
    await bus.subscribe(a);
    await bus.subscribe(b);
    await bus.publish("c2", { kind: "status" });
    await new Promise((r) => setImmediate(r));
    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledOnce();
    await bus.close();
  });
});
