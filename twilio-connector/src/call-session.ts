/**
 * Bridges Twilio Media Stream events, a Gemini Live session, and hermes-core's phone
 * protocol for one connector-wide device. Mirrors hermes-core's own CallEngine (a map of
 * live calls keyed by id) — see the design spec's Data flow section for the two call
 * shapes this drives (inbound: call.inbound -> wait for call.accept -> open Gemini;
 * outbound: call.place -> Twilio REST dial -> open Gemini once answered).
 */
import { mulawToPcm16, pcm16ToMulaw, upsample8kTo16k, downsample24kTo8k } from "./audio.ts";
import type { CoreMsg, EndReason, PhoneMsg, TriggerConfig } from "./protocol.ts";

export interface GeminiLiveListenerLike {
  onAudioChunk(pcm24k: Int16Array): void;
  onTranscript(role: "caller" | "agent", text: string): void;
  onTurnComplete(): void;
  onInterrupted(): void;
  onClosed(reason: string): void;
  onError(err: Error): void;
}

/** The slice of GeminiLiveClient's API this module drives — narrowed so tests can fake it. */
export interface GeminiLike {
  setListener(l: GeminiLiveListenerLike): void;
  connect(apiKey: string, systemInstruction: string): Promise<void>;
  sendAudioChunk(pcm16kMono: Int16Array): void;
  sendTextTurn(text: string): void;
  close(): void;
}

export interface TwilioRestLike {
  createCall(params: { to: string; from: string; url: string; statusCallback?: string }): Promise<{ sid: string }>;
  endCall(callSid: string): Promise<void>;
}

export interface HermesSend {
  send(msg: PhoneMsg): void;
}

export interface CallSessionManagerConfig {
  deviceId: string;
  geminiApiKey: string;
  twilioNumber: string;
  outboundAnswerUrl: (callId: string) => string;
  /** Twilio POSTs CallStatus updates here — the only way onStatusCallback ever fires. */
  statusCallbackUrl: string;
}

export interface CallSessionManagerDeps {
  hermes: HermesSend;
  twilioRest: TwilioRestLike;
  geminiFactory: () => GeminiLike;
  config: CallSessionManagerConfig;
}

interface Session {
  callId: string;
  callSid: string;
  streamSid: string;
  sendToTwilio: (frame: string) => void;
  gemini?: GeminiLike;
  hangupReason?: EndReason;
  endedSent: boolean;
}

interface PendingOutbound {
  to: string;
  systemInstruction: string;
  callSid?: string;
}

/** Maps a subset of Twilio's CallStatus values (for a call that never reached a Media
 *  Stream) onto hermes-core's EndReason vocabulary. */
function reasonForStatus(status: string): EndReason {
  switch (status) {
    case "no-answer":
      return "dial_timeout";
    case "busy":
      return "far_party";
    case "failed":
    case "canceled":
      return "error";
    default:
      return "remote_hangup";
  }
}

export class CallSessionManager {
  private readonly deps: CallSessionManagerDeps;
  private readonly sessionsByCallSid = new Map<string, Session>();
  private readonly sessionsByCallId = new Map<string, Session>();
  private readonly pendingOutbound = new Map<string, PendingOutbound>();
  private readonly callSidToCallId = new Map<string, string>();

  constructor(deps: CallSessionManagerDeps) {
    this.deps = deps;
  }

  private send(msg: PhoneMsg): void {
    this.deps.hermes.send(msg);
  }

  private startGemini(session: Session, systemInstruction: string): void {
    const gemini = this.deps.geminiFactory();
    session.gemini = gemini;
    gemini.setListener({
      onAudioChunk: (pcm24k) => {
        const pcm8k = downsample24kTo8k(pcm24k);
        const payload = Buffer.from(pcm16ToMulaw(pcm8k)).toString("base64");
        session.sendToTwilio(JSON.stringify({ event: "media", streamSid: session.streamSid, media: { payload } }));
      },
      onTranscript: (role, text) => {
        this.send({ type: "transcript", call_id: session.callId, role, text, ts: Date.now(), device_id: this.deps.config.deviceId });
      },
      onTurnComplete: () => {},
      onInterrupted: () => {},
      onClosed: () => {},
      onError: (err) => console.error(`[call-session] gemini error for ${session.callId}:`, err.message),
    });
    void gemini.connect(this.deps.config.geminiApiKey, systemInstruction).then(() => {
      this.send({ type: "call.active", call_id: session.callId, device_id: this.deps.config.deviceId });
    });
  }

  /** Twilio Media Stream `start` event — the call has been answered and audio is live. */
  onStreamStart(params: {
    callSid: string;
    streamSid: string;
    customParameters: Record<string, string>;
    sendToTwilio: (frame: string) => void;
  }): void {
    const { callSid, streamSid, customParameters, sendToTwilio } = params;

    if (customParameters.call_id) {
      // Outbound leg answered: the system instruction is already known from call.place.
      const callId = customParameters.call_id;
      const pending = this.pendingOutbound.get(callId);
      if (!pending) {
        console.error(`[call-session] outbound stream start for unknown call_id ${callId}`);
        return;
      }
      const session: Session = { callId, callSid, streamSid, sendToTwilio, endedSent: false };
      this.sessionsByCallSid.set(callSid, session);
      this.sessionsByCallId.set(callId, session);
      this.pendingOutbound.delete(callId);
      this.startGemini(session, pending.systemInstruction);
      return;
    }

    // Inbound ring: mint a call_id and hand off to hermes-core for persona resolution
    // before opening Gemini — call.accept (via onCoreMessage) carries the instruction.
    const callId = `twilio-${callSid}`;
    const session: Session = { callId, callSid, streamSid, sendToTwilio, endedSent: false };
    this.sessionsByCallSid.set(callSid, session);
    this.sessionsByCallId.set(callId, session);
    this.send({ type: "call.inbound", call_id: callId, from: customParameters.from ?? "", device_id: this.deps.config.deviceId });
  }

  /** One Twilio Media Stream `media` event's base64 mu-law payload from the caller. */
  onStreamMedia(callSid: string, payloadB64: string): void {
    const session = this.sessionsByCallSid.get(callSid);
    if (!session?.gemini) return;
    const pcm8k = mulawToPcm16(Buffer.from(payloadB64, "base64"));
    session.gemini.sendAudioChunk(upsample8kTo16k(pcm8k));
  }

  /** Twilio Media Stream `stop` — the call ended, one way or another. */
  onStreamStop(callSid: string): void {
    const session = this.sessionsByCallSid.get(callSid);
    if (!session || session.endedSent) return;
    session.endedSent = true;
    const reason = session.hangupReason ?? "remote_hangup";
    this.send({ type: "call.ended", call_id: session.callId, reason, device_id: this.deps.config.deviceId });
    this.sessionsByCallSid.delete(callSid);
    this.sessionsByCallId.delete(session.callId);
  }

  /** A Twilio status-callback CallStatus — only acted on if the call never reached a
   *  Media Stream (a stream that did start is finalized by onStreamStop instead). */
  onStatusCallback(callSid: string, status: string): void {
    if (this.sessionsByCallSid.has(callSid)) return;
    const callId = this.callSidToCallId.get(callSid);
    if (!callId) return;
    const pending = this.pendingOutbound.get(callId);
    if (!pending) return;
    this.pendingOutbound.delete(callId);
    this.callSidToCallId.delete(callSid);
    this.send({ type: "call.ended", call_id: callId, reason: reasonForStatus(status), device_id: this.deps.config.deviceId });
  }

  /** hermes-core -> connector. */
  async onCoreMessage(msg: CoreMsg): Promise<void> {
    switch (msg.type) {
      case "call.accept": {
        const session = this.sessionsByCallId.get(msg.call_id);
        if (session && !session.gemini) this.startGemini(session, msg.system_instruction);
        return;
      }
      case "call.place": {
        this.pendingOutbound.set(msg.call_id, { to: msg.to, systemInstruction: msg.system_instruction });
        this.send({ type: "call.dialing", call_id: msg.call_id, to: msg.to, device_id: this.deps.config.deviceId });
        const { sid } = await this.deps.twilioRest.createCall({
          to: msg.to,
          from: this.deps.config.twilioNumber,
          url: this.deps.config.outboundAnswerUrl(msg.call_id),
          statusCallback: this.deps.config.statusCallbackUrl,
        });
        const pending = this.pendingOutbound.get(msg.call_id);
        if (pending) {
          pending.callSid = sid;
          this.callSidToCallId.set(sid, msg.call_id);
        }
        return;
      }
      case "call.inject": {
        this.sessionsByCallId.get(msg.call_id)?.gemini?.sendTextTurn(msg.text);
        return;
      }
      case "call.hangup": {
        const session = this.sessionsByCallId.get(msg.call_id);
        if (session) {
          session.hangupReason = msg.reason;
          session.gemini?.close();
          await this.deps.twilioRest.endCall(session.callSid).catch((e) =>
            console.error(`[call-session] endCall failed for ${session.callSid}:`, e.message),
          );
          return;
        }
        // Hung up before the outbound leg was ever answered (still dialing).
        const pending = this.pendingOutbound.get(msg.call_id);
        if (pending?.callSid) {
          await this.deps.twilioRest.endCall(pending.callSid).catch(() => {});
          this.pendingOutbound.delete(msg.call_id);
        }
        return;
      }
      default:
        return;
    }
  }
}

export type { TriggerConfig };
