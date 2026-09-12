import { describe, it, expect } from "vitest";
import { freshDb } from "../test/db.ts";
import { SmsRepo } from "./sms.ts";

describe("SmsRepo", () => {
  it("records a message and lists it back, camelCased, oldest first", async () => {
    const repo = new SmsRepo(await freshDb());
    const a = await repo.record({ direction: "outbound", peer: "+15551230000", body: "first", status: "queued", deviceId: "phone-a" });
    const b = await repo.record({ direction: "inbound", peer: "+15551230000", body: "second", status: "received" });

    const rows = await repo.list();
    expect(rows.map((r) => r.id)).toEqual([a.id, b.id]);
    expect(rows[0]).toMatchObject({ direction: "outbound", peer: "+15551230000", body: "first", status: "queued", deviceId: "phone-a" });
    expect(rows[1]).toMatchObject({ direction: "inbound", peer: "+15551230000", body: "second", status: "received", deviceId: null });
  });

  it("list respects the limit", async () => {
    const repo = new SmsRepo(await freshDb());
    for (let i = 0; i < 3; i++) await repo.record({ direction: "outbound", peer: "+1555", body: `m${i}`, status: "queued" });
    const rows = await repo.list(2);
    expect(rows).toHaveLength(2);
  });

  it("updateStatus moves a row's status and records an error", async () => {
    const repo = new SmsRepo(await freshDb());
    const { id } = await repo.record({ direction: "outbound", peer: "+15551230000", body: "hi", status: "queued", deviceId: "ginkgo-1" });

    await repo.updateStatus(id, "sent");
    expect((await repo.list())[0]).toMatchObject({ status: "sent", error: null });

    await repo.updateStatus(id, "failed", "resultCode=2");
    expect((await repo.list())[0]).toMatchObject({ status: "failed", error: "resultCode=2" });
  });

  it("updateStatus never downgrades a delivered row", async () => {
    const repo = new SmsRepo(await freshDb());
    const { id } = await repo.record({ direction: "outbound", peer: "+1555", body: "x", status: "queued", deviceId: "ginkgo-1" });
    await repo.updateStatus(id, "delivered");
    await repo.updateStatus(id, "sent"); // a late sms.sent arriving after sms.delivered
    expect((await repo.list())[0]!.status).toBe("delivered");
  });

  it("pendingOutbound returns only this device's queued outbound rows, oldest first", async () => {
    const repo = new SmsRepo(await freshDb());
    const a = await repo.record({ direction: "outbound", peer: "+1555", body: "1", status: "queued", deviceId: "ginkgo-1" });
    await repo.record({ direction: "outbound", peer: "+1555", body: "2", status: "sent", deviceId: "ginkgo-1" });
    await repo.record({ direction: "outbound", peer: "+1555", body: "3", status: "queued", deviceId: "other" });
    await repo.record({ direction: "inbound", peer: "+1555", body: "4", status: "received", deviceId: "ginkgo-1" });

    const pending = await repo.pendingOutbound("ginkgo-1");
    expect(pending.map((r) => r.id)).toEqual([a.id]);
  });
});
