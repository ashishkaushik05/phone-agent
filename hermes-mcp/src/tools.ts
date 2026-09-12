import { z } from "zod";
import { callHermes, type HermesClientDeps } from "./hermesClient.ts";

/** One MCP tool per existing hermes-core REST endpoint. Each `request()` is mechanical:
 *  build the method/path/body the matching REST endpoint expects. No business logic lives
 *  here — that all stays in hermes-core. */
export interface HermesTool {
  name: string;
  description: string;
  /** A zod "raw shape" (plain field map), not z.object(...) — matches McpServer.registerTool's
   *  inputSchema convention. */
  inputSchema: Record<string, z.ZodTypeAny>;
  request(args: Record<string, unknown>): { method: string; path: string; body?: unknown };
}

const triggerConfigSchema = z.object({
  needsData: z.array(z.string()),
  escalation: z.array(z.string()),
  offScript: z.array(z.string()),
  closing: z.array(z.string()),
});

export const TOOLS: HermesTool[] = [
  // ---- personas ----
  {
    name: "list_personas",
    description: "List every saved persona.",
    inputSchema: {},
    request: () => ({ method: "GET", path: "/personas" }),
  },
  {
    name: "get_persona",
    description: "Get one persona by id.",
    inputSchema: { persona_id: z.string() },
    request: (a) => ({ method: "GET", path: `/personas/${encodeURIComponent(String(a.persona_id))}` }),
  },
  {
    name: "upsert_persona",
    description:
      "Create or update a persona (matched by id — an existing id updates it, a new one creates it). " +
      "HARD RULES (identity lock, DIRECTOR-only steering) are reapplied server-side regardless of what's sent here.",
    inputSchema: {
      id: z.string(),
      name: z.string(),
      systemInstruction: z.string(),
      triggerConfig: triggerConfigSchema,
      isDefault: z.boolean().optional(),
    },
    request: (a) => ({ method: "POST", path: "/personas", body: a }),
  },
  {
    name: "delete_persona",
    description: "Delete a persona by id (the built-in default persona cannot be deleted).",
    inputSchema: { persona_id: z.string() },
    request: (a) => ({ method: "DELETE", path: `/personas/${encodeURIComponent(String(a.persona_id))}` }),
  },

  // ---- contacts ----
  {
    name: "list_contacts",
    description: "List every saved contact.",
    inputSchema: {},
    request: () => ({ method: "GET", path: "/contacts" }),
  },
  {
    name: "upsert_contact",
    description: "Create or update a contact — matched by phone number, not id.",
    inputSchema: {
      id: z.string().optional(),
      phoneE164: z.string(),
      name: z.string().optional(),
      personaId: z.string().optional(),
      trustTier: z.enum(["admin", "known", "stranger"]).optional(),
      crmRef: z.string().optional(),
      notes: z.string().optional(),
    },
    request: (a) => ({ method: "POST", path: "/contacts", body: a }),
  },
  {
    name: "delete_contact",
    description: "Delete a contact by id.",
    inputSchema: { contact_id: z.string() },
    request: (a) => ({ method: "DELETE", path: `/contacts/${encodeURIComponent(String(a.contact_id))}` }),
  },

  // ---- calls ----
  {
    name: "list_calls",
    description: "List every call.",
    inputSchema: {},
    request: () => ({ method: "GET", path: "/calls" }),
  },
  {
    name: "get_call",
    description: "Get one call by id, including its full transcript and director actions.",
    inputSchema: { call_id: z.string() },
    request: (a) => ({ method: "GET", path: `/calls/${encodeURIComponent(String(a.call_id))}` }),
  },
  {
    name: "place_call",
    description:
      "Place an outbound call. persona_id alone runs that saved persona; persona_id + script folds the " +
      "script in as a per-call goal; script alone builds an ad-hoc persona from it; neither runs the " +
      "default persona.",
    inputSchema: {
      to: z.string(),
      persona_id: z.string().optional(),
      script: z.string().optional(),
      device_id: z.string().optional(),
    },
    request: (a) => ({ method: "POST", path: "/calls", body: a }),
  },
  {
    name: "hangup_call",
    description: "Hang up a live call by id.",
    inputSchema: { call_id: z.string() },
    request: (a) => ({ method: "POST", path: `/calls/${encodeURIComponent(String(a.call_id))}/hangup` }),
  },
  {
    name: "inject_guidance",
    description: "Silently steer a live call's voice agent with a fact or correction — never read aloud as-is.",
    inputSchema: { call_id: z.string(), text: z.string() },
    request: (a) => ({
      method: "POST",
      path: `/calls/${encodeURIComponent(String(a.call_id))}/inject`,
      body: { text: a.text },
    }),
  },

  // ---- sms ----
  {
    name: "list_sms",
    description: "List every SMS message, oldest first.",
    inputSchema: {},
    request: () => ({ method: "GET", path: "/sms" }),
  },
  {
    name: "send_sms",
    description: "Send an SMS from the phone-connector device.",
    inputSchema: { to: z.string(), body: z.string(), device_id: z.string().optional() },
    request: (a) => ({ method: "POST", path: "/sms", body: a }),
  },

  // ---- whatsapp ----
  {
    name: "list_whatsapp",
    description: "List every WhatsApp message.",
    inputSchema: {},
    request: () => ({ method: "GET", path: "/whatsapp" }),
  },
  {
    name: "send_whatsapp",
    description: "Send a WhatsApp text message from the paired account.",
    inputSchema: { to: z.string(), body: z.string() },
    request: (a) => ({ method: "POST", path: "/whatsapp", body: a }),
  },
  {
    name: "whatsapp_status",
    description: "Get the WhatsApp pairing/connection state (unpaired, qr-pending, connected, disconnected, logged_out).",
    inputSchema: {},
    request: () => ({ method: "GET", path: "/whatsapp/status" }),
  },
  {
    name: "whatsapp_pair",
    description: "Force a fresh WhatsApp pairing QR — first-time pairing or re-pair after a logout.",
    inputSchema: {},
    request: () => ({ method: "POST", path: "/whatsapp/pair" }),
  },

  // ---- status ----
  {
    name: "get_status",
    description: "Get live call count and connected phone-connector devices.",
    inputSchema: {},
    request: () => ({ method: "GET", path: "/health" }),
  },
];

export interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
  // MCP's CallToolResult carries an index signature for protocol extensions — match it so
  // this type is directly assignable as a registerTool callback's return value.
  [key: string]: unknown;
}

/** Runs one tool against hermes-core and maps the result into an MCP-shaped tool result.
 *  A REST error or an unreachable hermes-core both become `isError: true` with a plain-text
 *  message — never a thrown error, so the calling agent always sees a clean tool failure
 *  rather than a broken connection (see spec §5). */
export async function runTool(
  tool: HermesTool,
  args: Record<string, unknown>,
  deps: HermesClientDeps,
): Promise<ToolResult> {
  const { method, path, body } = tool.request(args);
  const r = await callHermes(deps, method, path, body);
  if (!r.ok) {
    return { isError: true, content: [{ type: "text", text: `${r.status || "network"}: ${r.errorMessage}` }] };
  }
  return { content: [{ type: "text", text: r.data === undefined ? "ok" : JSON.stringify(r.data) }] };
}
