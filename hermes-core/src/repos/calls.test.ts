import { describe, it, expect } from "vitest";
import { freshDb } from "../test/db.ts";
import { CallsRepo } from "./calls.ts";

describe("CallsRepo", () => {
  it("runs a call through its lifecycle and reads it back with transcript + actions", async () => {
    const repo = new CallsRepo(await freshDb());
    await repo.create({ id: "k1", direction: "inbound", fromNumber: "+15551230000", status: "dialing" });
    await repo.setStatus("k1", "active");
    await repo.appendTranscript("k1", 0, "caller", "hi there");
    await repo.appendTranscript("k1", 1, "agent", "hello, how can I help?");
    await repo.appendAction("k1", { category: "needsData", matched: "when can", kind: "inject", payload: { text: "<<DIRECTOR ...>>" } });
    await repo.finalize("k1", "far_party", "Caller asked about availability.");

    const c = await repo.get("k1");
    expect(c?.status).toBe("ended");
    expect(c?.endReason).toBe("far_party");
    expect(c?.connectedAt).not.toBeNull();
    expect(c?.outcomeSummary).toContain("availability");
    expect(c?.transcript.map((t) => t.text)).toEqual(["hi there", "hello, how can I help?"]);
    expect(c?.actions).toHaveLength(1);
    expect(c?.actions[0]!.kind).toBe("inject");
  });

  it("appendTranscript is idempotent on (call_id, seq)", async () => {
    const repo = new CallsRepo(await freshDb());
    await repo.create({ id: "k2", direction: "outbound", toNumber: "+1555", status: "active" });
    await repo.appendTranscript("k2", 0, "agent", "first");
    await repo.appendTranscript("k2", 0, "agent", "first again");
    const c = await repo.get("k2");
    expect(c?.transcript).toHaveLength(1);
    expect(c?.transcript[0]!.text).toBe("first");
  });

  it("persists device_id and reads it back as deviceId (null when absent)", async () => {
    const repo = new CallsRepo(await freshDb());
    await repo.create({ id: "d1", direction: "inbound", fromNumber: "+1555", status: "dialing", deviceId: "phone-a" });
    await repo.create({ id: "d2", direction: "inbound", fromNumber: "+1555", status: "dialing" });

    const withDevice = await repo.get("d1");
    expect(withDevice?.deviceId).toBe("phone-a");
    const withoutDevice = await repo.get("d2");
    expect(withoutDevice?.deviceId).toBeNull();

    const rows = await repo.list();
    expect(rows.find((r) => r.id === "d1")?.deviceId).toBe("phone-a");
  });

  it("list returns newest first", async () => {
    const repo = new CallsRepo(await freshDb());
    await repo.create({ id: "a", direction: "inbound" });
    await new Promise((r) => setTimeout(r, 5));
    await repo.create({ id: "b", direction: "inbound" });
    const rows = await repo.list();
    expect(rows[0]!.id).toBe("b");
  });
});
