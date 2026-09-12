import { describe, it, expect } from "vitest";
import { freshDb } from "../test/db.ts";
import { WhatsappRepo } from "./whatsapp.ts";

describe("WhatsappRepo", () => {
  it("records a message and lists it back, camelCased, oldest first", async () => {
    const repo = new WhatsappRepo(await freshDb());
    const a = await repo.record({ direction: "outbound", peer: "+15551230000", body: "first", status: "queued" });
    const b = await repo.record({ direction: "inbound", peer: "+15551230000", body: "second", status: "received" });

    const rows = await repo.list();
    expect(rows.map((r) => r.id)).toEqual([a.id, b.id]);
    expect(rows[0]).toMatchObject({ direction: "outbound", peer: "+15551230000", body: "first", status: "queued" });
    expect(rows[1]).toMatchObject({ direction: "inbound", peer: "+15551230000", body: "second", status: "received" });
  });

  it("list respects the limit", async () => {
    const repo = new WhatsappRepo(await freshDb());
    for (let i = 0; i < 3; i++) await repo.record({ direction: "outbound", peer: "+1555", body: `m${i}`, status: "queued" });
    const rows = await repo.list(2);
    expect(rows).toHaveLength(2);
  });

  it("updateStatus advances the ladder and records an error on failure", async () => {
    const repo = new WhatsappRepo(await freshDb());
    const { id } = await repo.record({ direction: "outbound", peer: "+15551230000", body: "hi", status: "queued" });

    await repo.updateStatus(id, "sent");
    expect((await repo.list())[0]).toMatchObject({ status: "sent", error: null });

    await repo.updateStatus(id, "delivered");
    expect((await repo.list())[0]).toMatchObject({ status: "delivered" });

    await repo.updateStatus(id, "read");
    expect((await repo.list())[0]).toMatchObject({ status: "read" });
  });

  it("updateStatus never downgrades along the ladder (queued -> sent -> delivered -> read)", async () => {
    const repo = new WhatsappRepo(await freshDb());
    const { id } = await repo.record({ direction: "outbound", peer: "+1555", body: "x", status: "queued" });
    await repo.updateStatus(id, "read");
    await repo.updateStatus(id, "sent"); // a late "sent" ack arriving after "read"
    expect((await repo.list())[0]!.status).toBe("read");
  });

  it("updateStatus never overwrites a terminal failed row", async () => {
    const repo = new WhatsappRepo(await freshDb());
    const { id } = await repo.record({ direction: "outbound", peer: "+1555", body: "x", status: "queued" });
    await repo.updateStatus(id, "failed", "not connected");
    await repo.updateStatus(id, "sent"); // a stale send resolving after we already gave up
    expect((await repo.list())[0]).toMatchObject({ status: "failed", error: "not connected" });
  });

  it("pendingOutbound returns only queued outbound rows, oldest first, across all peers", async () => {
    const repo = new WhatsappRepo(await freshDb());
    const a = await repo.record({ direction: "outbound", peer: "+1555", body: "1", status: "queued" });
    await repo.record({ direction: "outbound", peer: "+1555", body: "2", status: "sent" });
    const c = await repo.record({ direction: "outbound", peer: "+1666", body: "3", status: "queued" });
    await repo.record({ direction: "inbound", peer: "+1555", body: "4", status: "received" });

    const pending = await repo.pendingOutbound();
    expect(pending.map((r) => r.id)).toEqual([a.id, c.id]);
  });
});
