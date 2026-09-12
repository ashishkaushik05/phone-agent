/** TwiML generation for the webhook responses this connector returns to Twilio. */

const xmlEscape = (s: string): string => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");

/**
 * `<Connect><Stream>` response opening a bidirectional Media Stream to `streamUrl` —
 * used for both inbound answer and outbound answer, the two are symmetric (see the
 * design spec's Data flow section). Twilio's Media Stream `start` event carries no
 * caller/callee number and no application state of its own, so anything call-session
 * needs at `start` time — the caller's number (inbound) or hermes-core's `call_id`
 * (outbound) — travels as a `<Parameter>` child and comes back in `start.customParameters`.
 */
export function connectStreamTwiml(streamUrl: string, params?: Record<string, string>): string {
  const paramTags = Object.entries(params ?? {})
    .map(([name, value]) => `<Parameter name="${xmlEscape(name)}" value="${xmlEscape(value)}"/>`)
    .join("");
  const stream = paramTags ? `<Stream url="${xmlEscape(streamUrl)}">${paramTags}</Stream>` : `<Stream url="${xmlEscape(streamUrl)}"/>`;
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Connect>${stream}</Connect></Response>`;
}
