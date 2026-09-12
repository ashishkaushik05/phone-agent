import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { validTwilioSignature } from "./twilio-signature.ts";

// Reference algorithm (Twilio's own): base64(HMAC-SHA1(authToken, url + sorted "key"+"value" params concatenated)).
// Computed independently here rather than imported from the module under test, per
// test-driven-development's "assert on real behavior, not mock behavior."
function referenceSignature(authToken: string, url: string, params: Record<string, string>): string {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  return createHmac("sha1", authToken).update(Buffer.from(data, "utf-8")).digest("base64");
}

describe("validTwilioSignature", () => {
  const authToken = "test-auth-token";
  const url = "https://example.test/voice/inbound";
  const params = { CallSid: "CA123", From: "+15551230000", To: "+15559990000" };

  it("accepts a correctly computed signature", () => {
    const sig = referenceSignature(authToken, url, params);
    expect(validTwilioSignature(authToken, url, params, sig)).toBe(true);
  });

  it("rejects a tampered signature", () => {
    const sig = referenceSignature(authToken, url, params);
    const tampered = sig.slice(0, -1) + (sig.at(-1) === "A" ? "B" : "A");
    expect(validTwilioSignature(authToken, url, params, tampered)).toBe(false);
  });

  it("rejects when the params don't match what was signed", () => {
    const sig = referenceSignature(authToken, url, params);
    expect(validTwilioSignature(authToken, url, { ...params, From: "+19998887777" }, sig)).toBe(false);
  });

  it("rejects a missing signature", () => {
    expect(validTwilioSignature(authToken, url, params, undefined)).toBe(false);
  });
});
