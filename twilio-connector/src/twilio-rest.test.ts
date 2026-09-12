import { describe, expect, it, vi } from "vitest";
import { TwilioRest } from "./twilio-rest.ts";

function fakeFetch(status: number, body: unknown) {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  })) as unknown as typeof fetch;
}

describe("TwilioRest.createCall", () => {
  it("POSTs to the account's Calls endpoint with Basic Auth and form-encoded params", async () => {
    const fetchImpl = fakeFetch(201, { sid: "CA999" });
    const client = new TwilioRest({ accountSid: "AC123", authToken: "secret-token", fetchImpl });

    const result = await client.createCall({ to: "+15551230000", from: "+15559990000", url: "https://x.test/voice/outbound?call_id=abc" });

    expect(result.sid).toBe("CA999");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchImpl as any).mock.calls[0];
    expect(url).toBe("https://api.twilio.com/2010-04-01/Accounts/AC123/Calls.json");
    expect(init.method).toBe("POST");
    expect(init.headers.authorization).toBe(`Basic ${Buffer.from("AC123:secret-token").toString("base64")}`);
    const body = new URLSearchParams(init.body as string);
    expect(body.get("To")).toBe("+15551230000");
    expect(body.get("From")).toBe("+15559990000");
    expect(body.get("Url")).toBe("https://x.test/voice/outbound?call_id=abc");
  });

  it("throws with the response body on a non-2xx status", async () => {
    const fetchImpl = fakeFetch(400, { message: "invalid number" });
    const client = new TwilioRest({ accountSid: "AC123", authToken: "secret-token", fetchImpl });
    await expect(client.createCall({ to: "bad", from: "+15559990000", url: "https://x.test" })).rejects.toThrow(
      /invalid number/,
    );
  });
});

describe("TwilioRest.endCall", () => {
  it("POSTs status=completed to the call's resource", async () => {
    const fetchImpl = fakeFetch(200, { sid: "CA999", status: "completed" });
    const client = new TwilioRest({ accountSid: "AC123", authToken: "secret-token", fetchImpl });

    await client.endCall("CA999");

    const [url, init] = (fetchImpl as any).mock.calls[0];
    expect(url).toBe("https://api.twilio.com/2010-04-01/Accounts/AC123/Calls/CA999.json");
    const body = new URLSearchParams(init.body as string);
    expect(body.get("Status")).toBe("completed");
  });
});
