import { describe, it, expect } from "vitest";
import { isPhoneMsg } from "./protocol.ts";

describe("protocol", () => {
  it("requires device_id on a call.inbound", () => {
    expect(isPhoneMsg({ type: "call.inbound", call_id: "c1", from: "+1555", device_id: "phone-a" })).toBe(true);
    expect(isPhoneMsg({ type: "call.inbound", call_id: "c1", from: "+1555" })).toBe(false); // no device_id
  });
  it("accepts hello with device_id, rejects junk", () => {
    expect(isPhoneMsg({ type: "hello", device_id: "phone-a" })).toBe(true);
    expect(isPhoneMsg({ nope: 1 })).toBe(false);
  });
});
