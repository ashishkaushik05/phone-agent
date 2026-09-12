import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshDb } from "./test/db.ts";
import { WhatsappRepo } from "./repos/whatsapp.ts";
import { WhatsappClient, type WaSocketLike } from "./whatsapp.ts";

// The client's event handlers fire-and-forget their async work (QR rendering, repo writes) —
// poll instead of a fixed sleep so these don't flake under CI/CPU load (found live: a fixed
// 20ms sleep failed under a loaded machine where QRCode.toDataURL took longer than that).
async function waitFor<T>(
  check: () => T | undefined | null | false | Promise<T | undefined | null | false>,
  timeoutMs = 2000,
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: condition never became true");
    await new Promise((r) => setTimeout(r, 10));
  }
}

// Only for asserting a negative (nothing arrives) — there's no condition to poll for.
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A fake Baileys socket: captures event handlers so a test can fire them directly, and
 *  records every sendMessage call instead of touching the network. `lidMap` seeds a fake
 *  LID -> phone-number-JID mapping for the LID-resolution tests. */
function fakeSocket(lidMap: Record<string, string> = {}) {
  const handlers = new Map<string, ((...args: any[]) => void)[]>();
  const sent: { jid: string; text: string }[] = [];
  let nextSendResult: (() => Promise<{ key?: { id?: string | null } } | undefined>) | null = null;

  const sock: WaSocketLike & {
    emit: (event: string, ...args: any[]) => void;
    sent: typeof sent;
    failNextSend: (message: string) => void;
  } = {
    async sendMessage(jid, content) {
      sent.push({ jid, text: content.text });
      if (nextSendResult) {
        const impl = nextSendResult;
        nextSendResult = null;
        return impl();
      }
      return { key: { id: `wa-${sent.length}` } };
    },
    ev: {
      on(event, cb) {
        (handlers.get(event) ?? handlers.set(event, []).get(event)!).push(cb);
      },
    },
    end() {},
    signalRepository: { lidMapping: { getPNForLID: async (lid: string) => lidMap[lid] ?? null } },
    emit(event, ...args) {
      for (const cb of handlers.get(event) ?? []) cb(...args);
    },
    sent,
    failNextSend(message: string) {
      nextSendResult = () => Promise.reject(new Error(message));
    },
  };
  return sock;
}

const tmpDirs: string[] = [];
async function tmpAuthDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "wa-auth-"));
  tmpDirs.push(d);
  return d;
}

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("WhatsappClient", () => {
  it("starts unpaired, goes qr-pending on a qr event, then connected on open", async () => {
    const sock = fakeSocket();
    const changes: number[] = [];
    const client = new WhatsappClient({
      repo: new WhatsappRepo(await freshDb()),
      authDir: await tmpAuthDir(),
      makeSocket: () => sock,
      onChange: () => changes.push(1),
    });
    await client.start();
    expect(client.status()).toEqual({ state: "unpaired" });

    sock.emit("connection.update", { qr: "1@ABC,DEF,GHI" });
    const s1 = await waitFor(() => (client.status().state === "qr-pending" ? client.status() : null));
    expect(s1.qr).toMatch(/^data:image\/png;base64,/);

    sock.emit("connection.update", { connection: "open" });
    expect(client.status()).toEqual({ state: "connected" });
    expect(changes.length).toBeGreaterThan(0);
  });

  it("logged_out on a loggedOut close, and pair() wipes auth + reconnects", async () => {
    const socks: ReturnType<typeof fakeSocket>[] = [];
    const authDir = await tmpAuthDir();
    const client = new WhatsappClient({
      repo: new WhatsappRepo(await freshDb()),
      authDir,
      makeSocket: () => {
        const s = fakeSocket();
        socks.push(s);
        return s;
      },
    });
    await client.start();
    expect(socks).toHaveLength(1);

    socks[0]!.emit("connection.update", { connection: "close", lastDisconnect: { error: { output: { statusCode: 401 } } } });
    expect(client.status()).toEqual({ state: "logged_out" });

    await client.pair();
    expect(client.status().state).not.toBe("logged_out");
    expect(socks).toHaveLength(2); // wiped + reconnected with a fresh socket
  });

  it("a non-loggedOut close goes disconnected and self-heals (no manual pair needed)", async () => {
    const socks: ReturnType<typeof fakeSocket>[] = [];
    const client = new WhatsappClient({
      repo: new WhatsappRepo(await freshDb()),
      authDir: await tmpAuthDir(),
      makeSocket: () => {
        const s = fakeSocket();
        socks.push(s);
        return s;
      },
    });
    await client.start();
    socks[0]!.emit("connection.update", { connection: "close", lastDisconnect: { error: { output: { statusCode: 408 } } } });
    expect(client.status()).toEqual({ state: "disconnected" });
    // pair() is a no-op while disconnected — it's already retrying on its own (spec §5.3)
    await client.pair();
    expect(socks.length).toBe(1);
  });

  it("send() dispatches immediately while connected and tracks delivery/read acks", async () => {
    const repo = new WhatsappRepo(await freshDb());
    const sock = fakeSocket();
    const client = new WhatsappClient({ repo, authDir: await tmpAuthDir(), makeSocket: () => sock });
    await client.start();
    sock.emit("connection.update", { connection: "open" });

    const r = await client.send("+15551230000", "hi there");
    expect(r.status).toBe("sent");
    expect(sock.sent[0]).toEqual({ jid: "15551230000@s.whatsapp.net", text: "hi there" });
    expect((await repo.list())[0]).toMatchObject({ status: "sent", peer: "+15551230000", body: "hi there" });

    sock.emit("messages.update", [{ key: { id: "wa-1" }, update: { status: 3 } }]); // DELIVERY_ACK
    await waitFor(async () => (await repo.list())[0]?.status === "delivered");
    expect((await repo.list())[0]).toMatchObject({ status: "delivered" });

    sock.emit("messages.update", [{ key: { id: "wa-1" }, update: { status: 4 } }]); // READ
    await waitFor(async () => (await repo.list())[0]?.status === "read");
    expect((await repo.list())[0]).toMatchObject({ status: "read" });
  });

  it("send() while disconnected queues, and replays on the next connection.open", async () => {
    const repo = new WhatsappRepo(await freshDb());
    const sock = fakeSocket();
    const client = new WhatsappClient({ repo, authDir: await tmpAuthDir(), makeSocket: () => sock });
    await client.start();

    const r = await client.send("+15551230000", "queued while offline");
    expect(r.status).toBe("queued");
    expect(sock.sent).toHaveLength(0);

    sock.emit("connection.update", { connection: "open" });
    await waitFor(() => sock.sent.length > 0);
    expect(sock.sent).toHaveLength(1);
    expect((await repo.list()).find((x) => x.id === r.id)).toMatchObject({ status: "sent" });
  });

  it("send() while logged_out fails immediately without touching the socket", async () => {
    const repo = new WhatsappRepo(await freshDb());
    const sock = fakeSocket();
    const client = new WhatsappClient({ repo, authDir: await tmpAuthDir(), makeSocket: () => sock });
    await client.start();
    sock.emit("connection.update", { connection: "close", lastDisconnect: { error: { output: { statusCode: 401 } } } });

    const r = await client.send("+15551230000", "hello?");
    expect(r.status).toBe("failed");
    expect(sock.sent).toHaveLength(0);
    expect((await repo.list())[0]).toMatchObject({ status: "failed", error: expect.stringContaining("re-pair") });
  });

  it("dispatch failure records the row failed with the error message", async () => {
    const repo = new WhatsappRepo(await freshDb());
    const sock = fakeSocket();
    const client = new WhatsappClient({ repo, authDir: await tmpAuthDir(), makeSocket: () => sock });
    await client.start();
    sock.emit("connection.update", { connection: "open" });

    sock.failNextSend("rate limited");
    const r = await client.send("+15551230000", "oops");
    expect(r.status).toBe("failed");
    expect((await repo.list())[0]).toMatchObject({ status: "failed", error: "rate limited" });
  });

  it("inbound: records a 1:1 text message and resolves the peer to E.164", async () => {
    const repo = new WhatsappRepo(await freshDb());
    const sock = fakeSocket();
    const client = new WhatsappClient({ repo, authDir: await tmpAuthDir(), makeSocket: () => sock });
    await client.start();

    sock.emit("messages.upsert", {
      type: "notify",
      messages: [{ key: { fromMe: false, remoteJid: "919876543210@s.whatsapp.net" }, message: { conversation: "hey!" } }],
    });
    await waitFor(async () => (await repo.list()).length > 0);
    expect((await repo.list())[0]).toMatchObject({ direction: "inbound", peer: "+919876543210", body: "hey!" });
  });

  it("inbound: ignores echoes of our own messages, group chats, and media-only messages", async () => {
    const repo = new WhatsappRepo(await freshDb());
    const sock = fakeSocket();
    const client = new WhatsappClient({ repo, authDir: await tmpAuthDir(), makeSocket: () => sock });
    await client.start();

    sock.emit("messages.upsert", {
      type: "notify",
      messages: [
        { key: { fromMe: true, remoteJid: "919876543210@s.whatsapp.net" }, message: { conversation: "our own echo" } },
        { key: { fromMe: false, remoteJid: "123456-78@g.us" }, message: { conversation: "group chat text" } },
        { key: { fromMe: false, remoteJid: "919876543210@s.whatsapp.net" }, message: { imageMessage: {} } }, // no text
      ],
    });
    await sleep(200); // asserting a negative — nothing to poll for, just give any async work a chance to land
    expect(await repo.list()).toHaveLength(0);
  });

  it("inbound: resolves a \"@lid\" remoteJid to a phone number via the socket's LID mapping", async () => {
    const repo = new WhatsappRepo(await freshDb());
    const sock = fakeSocket({ "271751489548424@lid": "919876543210@s.whatsapp.net" });
    const client = new WhatsappClient({ repo, authDir: await tmpAuthDir(), makeSocket: () => sock });
    await client.start();

    sock.emit("messages.upsert", {
      type: "notify",
      messages: [{ key: { fromMe: false, remoteJid: "271751489548424@lid" }, message: { conversation: "hi from a lid" } }],
    });
    await waitFor(async () => (await repo.list()).length > 0);
    expect((await repo.list())[0]).toMatchObject({ direction: "inbound", peer: "+919876543210", body: "hi from a lid" });
  });

  it("inbound: an unmapped \"@lid\" (no PN on record) is skipped, not recorded under a bogus peer", async () => {
    const repo = new WhatsappRepo(await freshDb());
    const sock = fakeSocket(); // empty lidMap -> getPNForLID resolves null
    const client = new WhatsappClient({ repo, authDir: await tmpAuthDir(), makeSocket: () => sock });
    await client.start();

    sock.emit("messages.upsert", {
      type: "notify",
      messages: [{ key: { fromMe: false, remoteJid: "999999999999999@lid" }, message: { conversation: "unmappable" } }],
    });
    await sleep(200); // asserting a negative — nothing to poll for
    expect(await repo.list()).toHaveLength(0);
  });

  it("inbound: also records \"append\"-type messages — Baileys uses that for catch-up after a reconnect, not just old history (the initial bulk history dump is a separate event this module never subscribes to)", async () => {
    const repo = new WhatsappRepo(await freshDb());
    const sock = fakeSocket();
    const client = new WhatsappClient({ repo, authDir: await tmpAuthDir(), makeSocket: () => sock });
    await client.start();

    sock.emit("messages.upsert", {
      type: "append",
      messages: [{ key: { fromMe: false, remoteJid: "919876543210@s.whatsapp.net" }, message: { conversation: "caught up" } }],
    });
    await waitFor(async () => (await repo.list()).length > 0);
    expect((await repo.list())[0]).toMatchObject({ direction: "inbound", peer: "+919876543210", body: "caught up" });
  });
});
