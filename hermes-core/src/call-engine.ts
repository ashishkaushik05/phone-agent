import { randomUUID } from "node:crypto";
import { config } from "./config.ts";
import { decide, type ChatMsg, type DirectorChat } from "./director.ts";
import { reviewCall } from "./director-review.ts";
import { personaFromScript, type Persona } from "./repos/personas.ts";
import { withHardRules, stripHardRules } from "./persona-rules.ts";
import { resolvePersona, normalizeE164 } from "./repos/contacts.ts";
import { makeRepos, type Repos } from "./repos/index.ts";
import type { CoreMsg, PhoneMsg, Role, TriggerConfig } from "./protocol.ts";

export { makeRepos, type Repos };

export type TriggerCategory = "needsData" | "escalation" | "offScript" | "closing";
export interface TriggerHit {
  category: TriggerCategory;
  matched: string;
}

export function matchTrigger(text: string, cfg: TriggerConfig): TriggerHit | null {
  const order: TriggerCategory[] = ["offScript", "escalation", "needsData", "closing"];
  for (const category of order) {
    for (const kw of cfg[category]) {
      if (text.includes(kw)) return { category, matched: kw };
    }
  }
  return null;
}

interface LiveCall {
  id: string;
  deviceId: string;
  direction: "inbound" | "outbound";
  peer: string;
  personaId: string;
  personaName: string;
  triggerConfig: TriggerConfig;
  transcript: { seq: number; role: Role; text: string; ts: number }[];
  status: "queued" | "dialing" | "active" | "ended";
  evaluatedChars: number;
  directorBusy: boolean;
  hangupPending: boolean;
  lastCategory?: string;
  /** Set once send_whatsapp has notified the owner for this call — refuse a 2nd send
   *  (a multi-hop director tool loop, or a re-triggered category, could otherwise repeat it). */
  ownerNotified: boolean;
  hangupTimer?: ReturnType<typeof setTimeout>;
  directorHistory: ChatMsg[];
  /** transcript.length at the end of the last director turn — the point new turns are counted from. */
  directorLastSeenTurn: number;
}

/** Shape passed to director.decide — a subset of LiveCall it can read. */
export type CallState = Pick<LiveCall, "id" | "personaName" | "transcript">;

/** Every send routes to a specific device — inbound replies to the owning phone, outbound to the placing phone. */
type PhoneSend = (deviceId: string, msg: CoreMsg) => void;
type OnEvent = (callId: string, ev: { kind: "transcript" | "action" | "status" | "sms" | "whatsapp"; [k: string]: unknown }) => void;
/** The slice of WhatsappClient the director tool needs — kept minimal so call-engine.test.ts
 *  can pass a bare `{ send }` fake instead of a real WhatsappClient. */
interface WhatsappSender {
  send(peer: string, body: string): Promise<{ id: string; status: string }>;
}

export class CallEngine {
  private live = new Map<string, LiveCall>();
  constructor(
    private repos: Repos,
    /** `chat` is a test seam only — production wiring (main.ts) never sets it, letting
     *  decide() fall back to config.directorMode/defaultChat() as normal. */
    private opts: { onEvent?: OnEvent; whatsapp?: WhatsappSender; chat?: DirectorChat } = {},
  ) {}

  get(id: string) {
    return this.live.get(id);
  }
  list() {
    return [...this.live.values()];
  }

  /**
   * Manual inject from the dashboard (as opposed to a director trigger). Mirrors
   * maybeSteer's inject persistence — transcript + director_actions row + bus event —
   * so a hand-typed note shows up in the call's history exactly like an automatic one.
   * Returns false (no-op) for a call the engine isn't tracking as live, so the caller
   * can 404 instead of silently firing the inject at whatever device happens to be sole-connected.
   */
  async manualInject(callId: string, wrappedText: string, send: PhoneSend): Promise<boolean> {
    const lc = this.live.get(callId);
    if (!lc) return false;
    const seq = lc.transcript.length;
    lc.transcript.push({ seq, role: "director", text: wrappedText, ts: Date.now() });
    await this.repos.calls.appendTranscript(lc.id, seq, "director", wrappedText);
    await this.repos.calls.appendAction(lc.id, { category: "manual", kind: "inject", payload: { text: wrappedText } });
    this.opts.onEvent?.(lc.id, { kind: "action", category: "manual", inject: wrappedText });
    send(lc.deviceId, { type: "call.inject", call_id: lc.id, text: wrappedText });
    return true;
  }

  /**
   * Place an outbound call. Persona resolution, in order:
   *  - `personaId` given -> that saved persona (throws if it no longer exists). If a `script` is
   *    also given it's folded into the instruction as a per-call goal, with HARD RULES kept last.
   *  - `script` only     -> an ad-hoc persona built from the script (not persisted).
   *  - neither           -> the default persona.
   * `personaId` on the call row is set only for a persona that has a real DB row.
   */
  /** Re-send every outbound SMS still `queued` for this device — called when it (re)connects. */
  async resendPendingSms(deviceId: string, send: PhoneSend): Promise<void> {
    for (const row of await this.repos.sms.pendingOutbound(deviceId)) {
      send(deviceId, { type: "sms.send", to: row.peer, body: row.body, client_ref: row.id });
    }
  }

  async createOutbound(
    to: string,
    opts: { script?: string; personaId?: string },
    deviceId: string,
    send: PhoneSend,
  ): Promise<string> {
    const { script, personaId } = opts;
    let persona: Persona;
    let saved: boolean;
    if (personaId) {
      const base = await this.repos.personas.get(personaId);
      if (!base) throw new Error(`persona not found: ${personaId}`);
      persona = script
        ? { ...base, systemInstruction: withHardRules(`${stripHardRules(base.systemInstruction)}\n\nGoal for this specific call:\n${script.trim()}`) }
        : base;
      saved = true;
    } else if (script) {
      persona = personaFromScript(script);
      saved = false;
    } else {
      persona = await this.repos.personas.getDefault();
      saved = true;
    }
    const id = randomUUID();
    await this.repos.calls.create({
      id,
      direction: "outbound",
      toNumber: to,
      personaId: saved ? persona.id : null,
      status: "queued",
      deviceId,
    });
    this.live.set(id, this.blank(id, "outbound", to, persona, deviceId));
    send(deviceId, {
      type: "call.place",
      call_id: id,
      to,
      system_instruction: persona.systemInstruction,
      trigger_config: persona.triggerConfig,
    });
    return id;
  }

  /**
   * True if `msg` targets a live call owned by a different device — a hijack attempt or a
   * stale connector. Logs and tells the caller to drop the message. `call_id` is globally
   * unique across devices (connectors mint `DEVICE_ID-epochMillis`), so a mismatch is never legitimate.
   */
  private foreignCall(msg: { call_id: string; device_id: string }, lc: LiveCall | undefined): boolean {
    if (lc && lc.deviceId !== msg.device_id) {
      console.warn(`[engine] call ${msg.call_id} owned by ${lc.deviceId}, ignoring message from ${msg.device_id}`);
      return true;
    }
    return false;
  }

  async handlePhoneMessage(msg: PhoneMsg, send: PhoneSend): Promise<void> {
    switch (msg.type) {
      case "call.inbound": {
        if (this.live.has(msg.call_id)) {
          console.warn(`[engine] call.inbound for already-live call ${msg.call_id}, ignoring`);
          return;
        }
        const { persona, contact } = await resolvePersona(msg.from, this.repos.contacts, this.repos.personas);
        await this.repos.calls.create({
          id: msg.call_id,
          direction: "inbound",
          fromNumber: msg.from,
          personaId: persona.isDefault || contact?.personaId === persona.id ? persona.id : null,
          contactId: contact?.id ?? null,
          status: "dialing",
          deviceId: msg.device_id,
        });
        this.live.set(msg.call_id, this.blank(msg.call_id, "inbound", msg.from, persona, msg.device_id));
        send(msg.device_id, {
          type: "call.accept",
          call_id: msg.call_id,
          system_instruction: persona.systemInstruction,
          trigger_config: persona.triggerConfig,
        });
        return;
      }

      case "call.dialing": {
        const lc = this.live.get(msg.call_id);
        if (this.foreignCall(msg, lc)) return;
        await this.repos.calls.setStatus(msg.call_id, "dialing");
        if (lc) lc.status = "dialing";
        return;
      }

      case "call.active": {
        const lc = this.live.get(msg.call_id);
        if (this.foreignCall(msg, lc)) return;
        await this.repos.calls.setStatus(msg.call_id, "active");
        if (lc) lc.status = "active";
        this.opts.onEvent?.(msg.call_id, { kind: "status", status: "active" });
        return;
      }

      case "transcript": {
        const lc = this.live.get(msg.call_id);
        if (this.foreignCall(msg, lc)) return;
        if (!lc) return;
        const seq = lc.transcript.length;
        lc.transcript.push({ seq, role: msg.role, text: msg.text, ts: msg.ts });
        await this.repos.calls.appendTranscript(msg.call_id, seq, msg.role, msg.text);
        this.opts.onEvent?.(msg.call_id, { kind: "transcript", role: msg.role, text: msg.text });
        await this.maybeSteer(lc, send);
        return;
      }

      case "call.ended": {
        const lc = this.live.get(msg.call_id);
        if (this.foreignCall(msg, lc)) return;
        if (lc?.hangupTimer) clearTimeout(lc.hangupTimer);
        await this.repos.calls.finalize(msg.call_id, msg.reason, msg.summary);
        if (lc) lc.status = "ended";
        this.opts.onEvent?.(msg.call_id, { kind: "status", status: "ended", reason: msg.reason });
        void reviewCall(msg.call_id, this.repos).then((r) => {
          this.opts.onEvent?.(msg.call_id, { kind: "status", status: "reviewed", summary: r.outcomeSummary });
        }).catch((e) => console.error("[engine] post-call review failed:", e.message));
        this.live.delete(msg.call_id);
        return;
      }

      case "sms.inbound": {
        await this.repos.sms.record({
          direction: "inbound",
          peer: normalizeE164(msg.from),
          body: msg.body,
          status: "received",
          deviceId: msg.device_id,
        });
        this.opts.onEvent?.("", { kind: "sms" });
        return;
      }

      case "sms.sent": {
        await this.repos.sms.updateStatus(msg.client_ref, msg.ok ? "sent" : "failed", msg.error);
        this.opts.onEvent?.("", { kind: "sms" });
        return;
      }

      case "sms.delivered": {
        await this.repos.sms.updateStatus(msg.client_ref, msg.ok ? "delivered" : "failed", msg.error);
        this.opts.onEvent?.("", { kind: "sms" });
        return;
      }

      default:
        return;
    }
  }

  private async maybeSteer(lc: LiveCall, send: PhoneSend): Promise<void> {
    if (lc.status === "ended" || lc.directorBusy || lc.hangupPending) return;
    const full = lc.transcript.map((t) => t.text).join(" ").toLowerCase();
    if (full.length <= lc.evaluatedChars) return;
    const fresh = full.slice(Math.max(0, lc.evaluatedChars - 40));
    lc.evaluatedChars = full.length;

    const hit = matchTrigger(fresh, lc.triggerConfig);
    if (!hit || hit.category === lc.lastCategory) return;

    lc.directorBusy = true;
    try {
      const { action, history } = await decide(
        { id: lc.id, personaName: lc.personaName, transcript: lc.transcript },
        hit,
        {
          chat: this.opts.chat,
          context: {
            getContact: async (phone) => {
              const c = await this.repos.contacts.getByPhone(phone);
              return c
                ? `${c.name ?? "unknown name"}, trust tier ${c.trustTier}${c.notes ? ", notes: " + c.notes : ""}`
                : "No contact record.";
            },
            sendWhatsapp: this.opts.whatsapp
              ? async (to, body) => {
                  // Only the caller themselves or the configured owner — never an arbitrary
                  // third party the model was talked into naming (prompt injection via the caller).
                  const target = to ? normalizeE164(to) : lc.peer;
                  const isOwner = !!config.ownerWhatsapp && target === normalizeE164(config.ownerWhatsapp);
                  if (target !== lc.peer && !isOwner) {
                    return "refused: WhatsApp may only be sent to the caller or the configured owner number.";
                  }
                  if (isOwner) {
                    if (lc.ownerNotified) return "skipped: owner already notified for this call.";
                    lc.ownerNotified = true;
                  }
                  const r = await this.opts.whatsapp!.send(target, body);
                  return `sent (status: ${r.status})`;
                }
              : undefined,
          },
          history: lc.directorHistory,
          sinceSeq: lc.directorLastSeenTurn,
        },
      );
      lc.directorHistory = history;
      lc.directorLastSeenTurn = lc.transcript.length;
      if (!action) return;
      lc.lastCategory = hit.category;
      if (action.inject) {
        const seq = lc.transcript.length;
        lc.transcript.push({ seq, role: "director", text: action.inject, ts: Date.now() });
        await this.repos.calls.appendTranscript(lc.id, seq, "director", action.inject);
        await this.repos.calls.appendAction(lc.id, {
          category: hit.category,
          matched: hit.matched,
          kind: "inject",
          payload: { text: action.inject },
        });
        this.opts.onEvent?.(lc.id, { kind: "action", category: hit.category, inject: action.inject });
        send(lc.deviceId, { type: "call.inject", call_id: lc.id, text: action.inject });
      }
      if (action.note) {
        await this.repos.calls.appendAction(lc.id, {
          category: hit.category,
          matched: hit.matched,
          kind: "note",
          payload: { note: action.note },
        });
      }
      if (action.hangup) {
        lc.hangupPending = true;
        await this.repos.calls.appendAction(lc.id, {
          category: hit.category,
          matched: hit.matched,
          kind: "hangup",
          payload: { reason: action.hangup.reason },
        });
        lc.hangupTimer = setTimeout(
          () => send(lc.deviceId, { type: "call.hangup", call_id: lc.id, reason: action.hangup!.reason }),
          6000,
        );
      }
    } finally {
      lc.directorBusy = false;
    }
  }

  private blank(
    id: string,
    direction: "inbound" | "outbound",
    peer: string,
    persona: { id: string; name: string; triggerConfig: TriggerConfig },
    deviceId = "",
  ): LiveCall {
    return {
      id,
      deviceId,
      direction,
      peer,
      personaId: persona.id,
      personaName: persona.name,
      triggerConfig: persona.triggerConfig,
      transcript: [],
      status: "queued",
      evaluatedChars: 0,
      directorBusy: false,
      hangupPending: false,
      ownerNotified: false,
      directorHistory: [],
      directorLastSeenTurn: 0,
    };
  }
}
