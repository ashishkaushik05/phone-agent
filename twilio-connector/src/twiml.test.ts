import { describe, expect, it } from "vitest";
import { connectStreamTwiml } from "./twiml.ts";

describe("connectStreamTwiml", () => {
  it("wraps the stream url in a Connect/Stream response", () => {
    const xml = connectStreamTwiml("wss://example.test/media-stream");
    expect(xml).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="wss://example.test/media-stream"/></Connect></Response>',
    );
  });

  it("XML-escapes an ampersand in a query string", () => {
    const xml = connectStreamTwiml("wss://example.test/media-stream?call_id=abc&foo=bar");
    expect(xml).toContain('url="wss://example.test/media-stream?call_id=abc&amp;foo=bar"');
  });

  it("embeds custom parameters, which Twilio's start event echoes back", () => {
    const xml = connectStreamTwiml("wss://example.test/media-stream", { from: "+15551230000" });
    expect(xml).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="wss://example.test/media-stream">' +
        '<Parameter name="from" value="+15551230000"/></Stream></Connect></Response>',
    );
  });

  it("XML-escapes a parameter value", () => {
    const xml = connectStreamTwiml("wss://example.test/media-stream", { note: 'a "quoted" & value' });
    expect(xml).toContain('value="a &quot;quoted&quot; &amp; value"');
  });
});
