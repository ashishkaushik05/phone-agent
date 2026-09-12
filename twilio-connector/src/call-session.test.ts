import { describe, expect, it, vi } from "vitest";
import { CallSessionManager } from "./call-session.ts";
import type { CoreMsg, PhoneMsg } from "./protocol.ts";
import { mulawToPcm16, pcm16ToMulaw } from "./audio.ts";

function fakeGemini() {
  const g: any = {
    listener: undefined,
    setListener: vi.fn((l) => (g.listener = l)),
    connect: vi.fn(async () => {}),
    sendAudioChunk: vi.fn(),
    sendTextTurn: vi.fn(),
    close: vi.fn(),
  };
  return g;
}

function setUp() {
  const sent: PhoneMsg[] = [];
  const hermes = { send: vi.fn((m: PhoneMsg) => sent.push(m)) };
  const created: ReturnType<typeof fakeGemini>[] = [];
  const geminiFactory = vi.fn(() => {
    const g = fakeGemini();
    created.push(g);
    return g;
  });
  const twilioRest = {
    createCall: vi.fn(async () => ({ sid: "CAoutbound" })),
    endCall: vi.fn(async () => {}),
  };
  const manager = new CallSessionManager({
    hermes,
    twilioRest,
    geminiFactory,
    config: {
      deviceId: "twilio-main",
      geminiApiKey: "gk-123",
      twilioNumber: "+15559990000",
      outboundAnswerUrl: (callId: string) => `https://x.test/voice/outbound?call_id=${callId}`,
      statusCallbackUrl: "https://x.test/voice/status",
    },
  });
  return { manager, hermes, sent, created, twilioRest, geminiFactory };
}

describe("CallSessionManager inbound", () => {
  it("runs the full inbound flow: inbound -> accept -> gemini -> audio + transcript + inject + hangup", async () => {
    const { manager, sent, created } = setUp();
    const twilioFrames: string[] = [];

    manager.onStreamStart({
      callSid: "CAinbound1",
      streamSid: "MZ1",
      customParameters: { from: "+15551230000" },
      sendToTwilio: (f) => twilioFrames.push(f),
    });

    expect(sent[0]).toEqual({ type: "call.inbound", call_id: "twilio-CAinbound1", from: "+15551230000", device_id: "twilio-main" });

    const coreMsg: CoreMsg = {
      type: "call.accept",
      call_id: "twilio-CAinbound1",
      system_instruction: "be a helpful receptionist",
      trigger_config: { needsData: [], escalation: [], offScript: [], closing: [] },
    };
    await manager.onCoreMessage(coreMsg);

    const gemini = created[0]!;
    expect(gemini.connect).toHaveBeenCalledWith("gk-123", "be a helpful receptionist");
    expect(sent.at(-1)).toEqual({ type: "call.active", call_id: "twilio-CAinbound1", device_id: "twilio-main" });

    // caller audio: base64 mulaw in -> gemini gets upsampled PCM16
    const callerPcm8 = new Int16Array([1000, -1000, 2000]);
    const payloadB64 = Buffer.from(pcm16ToMulaw(callerPcm8)).toString("base64");
    manager.onStreamMedia("CAinbound1", payloadB64);
    expect(gemini.sendAudioChunk).toHaveBeenCalledTimes(1);
    const gotPcm: Int16Array = gemini.sendAudioChunk.mock.calls[0][0];
    expect(gotPcm.length).toBe(6); // upsampled 2x

    // caller transcript -> forwarded to hermes-core with role "caller"
    gemini.listener.onTranscript("caller", "hello there");
    expect(sent.at(-1)).toMatchObject({ type: "transcript", call_id: "twilio-CAinbound1", role: "caller", text: "hello there" });

    // model audio -> downsampled + mulaw-encoded media frame sent back to Twilio
    const modelPcm24 = new Int16Array([300, 300, 300, -300, -300, -300]); // two groups of 3
    gemini.listener.onAudioChunk(modelPcm24);
    expect(twilioFrames.length).toBe(1);
    const frame = JSON.parse(twilioFrames[0]!);
    expect(frame).toEqual({ event: "media", streamSid: "MZ1", media: { payload: expect.any(String) } });
    const decoded = mulawToPcm16(Buffer.from(frame.media.payload, "base64"));
    expect(decoded.length).toBe(2);

    // director inject
    await manager.onCoreMessage({ type: "call.inject", call_id: "twilio-CAinbound1", text: "<<DIRECTOR - act silently: wrap up>>" });
    expect(gemini.sendTextTurn).toHaveBeenCalledWith("<<DIRECTOR - act silently: wrap up>>");

    // director hangup -> ends the Twilio call and closes gemini; call.ended sent once Twilio confirms
    await manager.onCoreMessage({ type: "call.hangup", call_id: "twilio-CAinbound1", reason: "agent_ended" });
    expect(gemini.close).toHaveBeenCalledTimes(1);

    manager.onStreamStop("CAinbound1");
    expect(sent.at(-1)).toEqual({ type: "call.ended", call_id: "twilio-CAinbound1", reason: "agent_ended", device_id: "twilio-main" });
  });

  it("defaults to remote_hangup when the stream stops with no prior director hangup", async () => {
    const { manager, sent } = setUp();
    manager.onStreamStart({
      callSid: "CAinbound2",
      streamSid: "MZ2",
      customParameters: { from: "+15551230000" },
      sendToTwilio: () => {},
    });
    await manager.onCoreMessage({
      type: "call.accept",
      call_id: "twilio-CAinbound2",
      system_instruction: "hi",
      trigger_config: { needsData: [], escalation: [], offScript: [], closing: [] },
    });
    manager.onStreamStop("CAinbound2");
    expect(sent.at(-1)).toEqual({ type: "call.ended", call_id: "twilio-CAinbound2", reason: "remote_hangup", device_id: "twilio-main" });
  });
});

describe("CallSessionManager outbound", () => {
  it("places the call via Twilio REST, then opens gemini directly once the stream starts", async () => {
    const { manager, sent, created, twilioRest } = setUp();

    await manager.onCoreMessage({
      type: "call.place",
      call_id: "abc-out-1",
      to: "+15551230000",
      system_instruction: "you are booking an appointment",
      trigger_config: { needsData: [], escalation: [], offScript: [], closing: [] },
    });

    expect(sent[0]).toEqual({ type: "call.dialing", call_id: "abc-out-1", to: "+15551230000", device_id: "twilio-main" });
    expect(twilioRest.createCall).toHaveBeenCalledWith({
      to: "+15551230000",
      from: "+15559990000",
      url: "https://x.test/voice/outbound?call_id=abc-out-1",
      statusCallback: "https://x.test/voice/status",
    });

    manager.onStreamStart({
      callSid: "CAoutbound",
      streamSid: "MZ3",
      customParameters: { call_id: "abc-out-1" },
      sendToTwilio: () => {},
    });
    await Promise.resolve(); // let the connect() promise chain settle

    const gemini = created[0]!;
    expect(gemini.connect).toHaveBeenCalledWith("gk-123", "you are booking an appointment");
    expect(sent.at(-1)).toEqual({ type: "call.active", call_id: "abc-out-1", device_id: "twilio-main" });
  });

  it("ends the call with dial_timeout if Twilio reports no-answer before any stream ever starts", async () => {
    const { manager, sent, created } = setUp();
    await manager.onCoreMessage({
      type: "call.place",
      call_id: "abc-out-2",
      to: "+15551230000",
      system_instruction: "hi",
      trigger_config: { needsData: [], escalation: [], offScript: [], closing: [] },
    });

    manager.onStatusCallback("CAoutbound", "no-answer");

    expect(sent.at(-1)).toEqual({ type: "call.ended", call_id: "abc-out-2", reason: "dial_timeout", device_id: "twilio-main" });
    expect(created.length).toBe(0); // gemini was never opened for a call that never connected
  });
});
