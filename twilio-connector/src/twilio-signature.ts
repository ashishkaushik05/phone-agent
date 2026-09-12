/**
 * Validates the `X-Twilio-Signature` header Twilio sends on every webhook request, per
 * https://www.twilio.com/docs/usage/security#validating-requests — the full request URL
 * plus every POST param (sorted by key, key+value concatenated) is HMAC-SHA1'd with the
 * account's auth token and base64-encoded. Rejecting an unsigned/mismatched request keeps
 * an attacker from forging call events against this connector's public webhook endpoint.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export function validTwilioSignature(
  authToken: string,
  fullUrl: string,
  params: Record<string, string>,
  signature: string | undefined,
): boolean {
  if (!signature) return false;
  const data = fullUrl + Object.keys(params).sort().map((k) => k + params[k]).join("");
  const expected = createHmac("sha1", authToken).update(Buffer.from(data, "utf-8")).digest("base64");
  const a = Buffer.from(expected, "utf-8");
  const b = Buffer.from(signature, "utf-8");
  return a.length === b.length && timingSafeEqual(a, b);
}
