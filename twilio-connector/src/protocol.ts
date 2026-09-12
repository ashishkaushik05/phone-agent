/**
 * Wire protocol for the hermes-core `/phone` WebSocket link — copied from
 * hermes-core/src/protocol.ts. Duplicated rather than imported: each service in this
 * repo (hermes-core, hermes-mcp, twilio-connector) is an independent npm package with
 * its own node_modules, none of them a workspace member of the others. Keep in sync by
 * hand if the wire protocol changes.
 */

export type Role = "caller" | "agent" | "director" | "system";
export type CallDirection = "inbound" | "outbound";
export type EndReason =
  | "agent_ended"
  | "remote_hangup"
  | "aborted_off_script"
  | "watchdog"
  | "far_party"
  | "dial_timeout"
  | "error";

export interface TriggerConfig {
  needsData: string[];
  escalation: string[];
  offScript: string[];
  closing: string[];
}

/** phone -> core (this connector plays "phone") */
export type PhoneMsg =
  | { type: "hello"; device_id: string }
  | { type: "call.inbound"; call_id: string; from: string; device_id: string }
  | { type: "call.dialing"; call_id: string; to: string; device_id: string }
  | { type: "call.active"; call_id: string; device_id: string }
  | { type: "transcript"; call_id: string; role: Role; text: string; ts: number; device_id: string }
  | { type: "call.ended"; call_id: string; reason: EndReason; summary?: string; device_id: string }
  | { type: "sms.inbound"; from: string; body: string; ts: number; device_id: string }
  | { type: "sms.sent"; client_ref: string; ok: boolean; error?: string; device_id: string }
  | { type: "sms.delivered"; client_ref: string; ok: boolean; error?: string; device_id: string }
  | { type: "heartbeat"; device_id: string };

/** core -> phone */
export type CoreMsg =
  | { type: "hello_ack"; device_id: string }
  | { type: "call.accept"; call_id: string; system_instruction: string; trigger_config: TriggerConfig }
  | { type: "call.place"; call_id: string; to: string; system_instruction: string; trigger_config: TriggerConfig }
  | { type: "call.inject"; call_id: string; text: string }
  | { type: "call.hangup"; call_id: string; reason: EndReason }
  | { type: "sms.send"; to: string; body: string; client_ref: string };

export const isCoreMsg = (v: unknown): v is CoreMsg =>
  typeof v === "object" && v !== null && typeof (v as { type?: unknown }).type === "string";
