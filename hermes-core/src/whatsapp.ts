import { rm } from "node:fs/promises";
import pino from "pino";
import QRCode from "qrcode";
import makeWASocketDefault, {
  useMultiFileAuthState,
  DisconnectReason,
  jidDecode,
  type AuthenticationState,
} from "@whiskeysockets/baileys";
import { normalizeE164 } from "./repos/contacts.ts";
import type { WhatsappRepo } from "./repos/whatsapp.ts";

export type WhatsappState = "unpaired" | "qr-pending" | "connected" | "disconnected" | "logged_out";

export interface WhatsappStatus {
  state: WhatsappState;
  /** PNG data URI, present only while state is "qr-pending". */
  qr?: string;
}

/**
 * The minimal slice of a real Baileys socket (`WASocket`, from `makeWASocket`) this module
 * actually calls. Real sockets satisfy this structurally — it exists so tests can inject a
 * fake one instead of opening a real WhatsApp connection (see whatsapp.test.ts).
 */
export interface WaSocketLike {
  sendMessage(jid: string, content: { text: string }): Promise<{ key?: { id?: string | null } } | undefined>;
  ev: { on(event: string, cb: (...args: any[]) => void): void };
  end(error?: Error): void;
  /** Resolves a WhatsApp "LID" (its newer privacy-preserving address, `<id>@lid`) back to the
   *  underlying phone-number JID — WhatsApp has been routing more and more traffic through LIDs
   *  instead of phone-number JIDs, including some inbound DMs (found live 2026-09-12: an inbound
   *  text arrived with remoteJid="...@lid", not "...@s.whatsapp.net", and was silently dropped
   *  before this was wired in). Optional so a test fake can omit it for non-LID scenarios. */
  signalRepository?: { lidMapping: { getPNForLID(lid: string): Promise<string | null> } };
}

export interface WhatsappClientDeps {
  repo: WhatsappRepo;
  /** Folder for useMultiFileAuthState — see spec §7 for why files, not Postgres/Supabase. */
  authDir: string;
  /** Fired on any state or message change the dashboard should refetch for — the same
   *  ping-only shape SMS uses (onEvent("", { kind: "sms" })), not a payload push. */
  onChange?: () => void;
  /** Test seam — defaults to the real Baileys socket factory. */
  makeSocket?: (auth: AuthenticationState) => WaSocketLike;
}

const MAX_PENDING = 1000; // bounded, same eviction pattern as phone-connector's SmsBridge.RECENT_MAX
const RECONNECT_DELAY_MS = 3000;

function peerToJid(peer: string): string {
  return `${peer.replace(/\D/g, "")}@s.whatsapp.net`;
}

/** null for anything that isn't a direct 1:1 WhatsApp user — groups/broadcast/status excluded. */
function jidToPeer(jid: string | null | undefined): string | null {
  const decoded = jidDecode(jid ?? undefined);
  if (!decoded || decoded.server !== "s.whatsapp.net" || !decoded.user) return null;
  return normalizeE164(`+${decoded.user}`);
}

// proto.WebMessageInfo.Status: ERROR=0, PENDING=1, SERVER_ACK=2, DELIVERY_ACK=3, READ=4, PLAYED=5.
// PENDING (1) maps to nothing -- our row is already "sent" the moment sendMessage() resolves.
function mapAckStatus(status: number): string | null {
  switch (status) {
    case 0:
      return "failed";
    case 2:
      return "sent";
    case 3:
      return "delivered";
    case 4:
    case 5:
      return "read";
    default:
      return null;
  }
}

/**
 * Owns the one Baileys socket for the process lifetime.
 * `send()` is the one function the REST endpoint, the dashboard's reply box, and the in-call
 * director tool all sit on top of identically.
 */
export class WhatsappClient {
  private sock: WaSocketLike | null = null;
  private state: WhatsappState = "unpaired";
  private qr: string | undefined;
  private connecting = false;
  /** WhatsApp message id -> our row id, so a later messages.update ack routes back to the
   *  right row. Lost on restart — an ack for a message sent before a restart is dropped, same
   *  class of limitation as the in-memory dedupe caches elsewhere in this project. */
  private pending = new Map<string, string>();

  constructor(private deps: WhatsappClientDeps) {}

  status(): WhatsappStatus {
    return this.state === "qr-pending" && this.qr ? { state: this.state, qr: this.qr } : { state: this.state };
  }

  /** Called once at boot. Connects with whatever creds exist on disk — silently stays
   *  "unpaired" if there are none yet, waiting for an explicit pair() from the dashboard. */
  async start(): Promise<void> {
    await this.connect();
  }

  /**
   * (Re)start the socket for a first-time pairing or a re-pair after logout. Idempotent: a
   * no-op while already connected, mid-QR, or mid-reconnect-backoff (those self-heal or are
   * already in progress — see spec §5.3) — only "unpaired"/"logged_out" do real work, wiping
   * any stale auth state first so we don't retry dead creds.
   */
  async pair(): Promise<void> {
    if (this.state !== "unpaired" && this.state !== "logged_out") return;
    if (this.state === "logged_out") {
      await rm(this.deps.authDir, { recursive: true, force: true });
      this.setState("unpaired");
    }
    await this.connect();
  }

  /**
   * Send a WhatsApp text. Always records a row first (so nothing is lost even if we're not
   * connected), then dispatches immediately if connected, or leaves it "queued" for
   * replayPending() to pick up on the next connection.open (see spec §5.4/§8).
   */
  async send(peer: string, body: string): Promise<{ id: string; status: string }> {
    const e164 = normalizeE164(peer);
    if (this.state === "logged_out") {
      const { id } = await this.deps.repo.record({
        direction: "outbound",
        peer: e164,
        body,
        status: "failed",
        error: "WhatsApp session logged out — re-pair required",
      });
      this.deps.onChange?.();
      return { id, status: "failed" };
    }
    const { id } = await this.deps.repo.record({ direction: "outbound", peer: e164, body, status: "queued" });
    this.deps.onChange?.();
    if (this.state !== "connected") return { id, status: "queued" };
    return { id, status: await this.dispatch(id, e164, body) };
  }

  private async connect(): Promise<void> {
    if (this.connecting) return;
    this.connecting = true;
    try {
      this.sock?.end(undefined);
      const { state: authState, saveCreds } = await useMultiFileAuthState(this.deps.authDir);
      const logger = pino({ level: "warn" });
      const sock = this.deps.makeSocket
        ? this.deps.makeSocket(authState)
        : (makeWASocketDefault({ auth: authState, logger }) as unknown as WaSocketLike);
      this.sock = sock;
      sock.ev.on("creds.update", saveCreds);
      sock.ev.on("connection.update", (u: any) => this.onConnectionUpdate(u));
      sock.ev.on("messages.upsert", (e: any) => this.onMessagesUpsert(e));
      sock.ev.on("messages.update", (e: any) => this.onMessagesUpdate(e));
    } finally {
      this.connecting = false;
    }
  }

  private onConnectionUpdate(u: { qr?: string; connection?: string; lastDisconnect?: { error?: unknown } }): void {
    if (u.qr) {
      QRCode.toDataURL(u.qr)
        .then((dataUrl) => {
          this.qr = dataUrl;
          this.setState("qr-pending");
        })
        .catch((e) => console.error("[whatsapp] failed to render QR", e));
      return;
    }
    if (u.connection === "open") {
      console.log("[whatsapp] connection open");
      this.setState("connected");
      void this.replayPending();
      return;
    }
    if (u.connection === "close") {
      const statusCode = (u.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output
        ?.statusCode;
      console.log(`[whatsapp] connection closed, statusCode=${statusCode}`, u.lastDisconnect?.error);
      if (statusCode === DisconnectReason.loggedOut) {
        this.setState("logged_out");
        return;
      }
      this.setState("disconnected");
      setTimeout(() => void this.connect(), RECONNECT_DELAY_MS);
    }
  }

  private onMessagesUpsert(e: { messages: any[]; type: string }): void {
    // Both "notify" (received while online) and "append" (added without a notification —
    // per Baileys' own docs this includes catch-up messages delivered after a reconnect, not
    // just old history) are handled the same way. Baileys' bulk initial-history dump comes
    // through a separate "messaging-history-set" event this module never subscribes to, so
    // there's no flood-of-old-messages risk from also handling "append" here — confirmed
    // 2026-09-12 as the fix for inbound messages going missing after a reconnect blip (an
    // earlier version filtered to "notify" only, on the wrong assumption "append" meant replay).
    for (const m of e.messages ?? []) {
      if (m.key?.fromMe) continue; // our own echo
      void this.handleInboundMessage(m);
    }
  }

  private async handleInboundMessage(m: { key?: { remoteJid?: string | null }; message?: any }): Promise<void> {
    const peer = await this.resolveInboundPeer(m.key?.remoteJid);
    if (!peer) return; // group/broadcast/unresolvable @lid — text-only 1:1 is this spec's scope (§1/§10)
    const text: string | undefined = m.message?.conversation ?? m.message?.extendedTextMessage?.text;
    if (!text) return; // media/system message with no text body — out of scope
    try {
      await this.deps.repo.record({ direction: "inbound", peer, body: text, status: "received" });
      this.deps.onChange?.();
    } catch (err) {
      console.error("[whatsapp] failed to record inbound message", err);
    }
  }

  /** Direct 1:1 (`@s.whatsapp.net`) resolves synchronously; `@lid` needs an async reverse
   *  lookup through the socket's own LID<->phone-number mapping store. Everything else
   *  (groups, broadcast, an unmapped LID) is out of scope and resolves to null. */
  private async resolveInboundPeer(remoteJid: string | null | undefined): Promise<string | null> {
    const direct = jidToPeer(remoteJid);
    if (direct) return direct;
    const decoded = jidDecode(remoteJid ?? undefined);
    if (decoded?.server !== "lid" || !this.sock?.signalRepository) return null;
    try {
      const pnJid = await this.sock.signalRepository.lidMapping.getPNForLID(remoteJid!);
      return pnJid ? jidToPeer(pnJid) : null;
    } catch (err) {
      console.error("[whatsapp] LID -> phone-number resolution failed", err);
      return null;
    }
  }

  private onMessagesUpdate(events: { key: { id?: string | null }; update: { status?: number } }[]): void {
    for (const { key, update } of events ?? []) {
      const waId = key?.id;
      const rowId = waId ? this.pending.get(waId) : undefined;
      if (!rowId || update?.status === undefined) continue;
      const mapped = mapAckStatus(update.status);
      if (!mapped) continue;
      void this.deps.repo
        .updateStatus(rowId, mapped)
        .then(() => this.deps.onChange?.())
        .catch((err) => console.error("[whatsapp] failed to update status", err));
      if (mapped === "read" || mapped === "failed") this.pending.delete(waId!);
    }
  }

  private async dispatch(rowId: string, peer: string, body: string): Promise<string> {
    if (!this.sock) return "queued";
    try {
      const result = await this.sock.sendMessage(peerToJid(peer), { text: body });
      const waId = result?.key?.id;
      if (waId) this.trackPending(waId, rowId);
      await this.deps.repo.updateStatus(rowId, "sent");
      this.deps.onChange?.();
      return "sent";
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.deps.repo.updateStatus(rowId, "failed", message);
      this.deps.onChange?.();
      return "failed";
    }
  }

  private async replayPending(): Promise<void> {
    for (const row of await this.deps.repo.pendingOutbound()) {
      await this.dispatch(row.id, row.peer, row.body);
    }
  }

  private trackPending(waId: string, rowId: string): void {
    if (this.pending.size >= MAX_PENDING) {
      const oldest = this.pending.keys().next().value;
      if (oldest !== undefined) this.pending.delete(oldest);
    }
    this.pending.set(waId, rowId);
  }

  private setState(s: WhatsappState): void {
    if (s !== "qr-pending") this.qr = undefined;
    this.state = s;
    this.deps.onChange?.();
  }
}
