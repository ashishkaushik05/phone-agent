import { WebSocket } from "ws";
import { config } from "./config.ts";
import { HermesClient } from "./hermes-client.ts";
import { TwilioRest } from "./twilio-rest.ts";
import { GeminiLiveClient } from "./gemini-live-client.ts";
import { CallSessionManager } from "./call-session.ts";
import { buildServer } from "./server.ts";

const twilioRest = new TwilioRest({ accountSid: config.twilioAccountSid, authToken: config.twilioAuthToken });

const manager = new CallSessionManager({
  hermes: { send: (msg) => hermesClient.send(msg) },
  twilioRest,
  geminiFactory: () => new GeminiLiveClient({ wsFactory: (url) => new WebSocket(url) as any }),
  config: {
    deviceId: config.deviceId,
    geminiApiKey: config.geminiApiKey,
    twilioNumber: config.twilioNumber,
    outboundAnswerUrl: (callId) => `${config.publicBaseUrl}/voice/outbound?call_id=${encodeURIComponent(callId)}`,
    statusCallbackUrl: `${config.publicBaseUrl}/voice/status`,
  },
});

const hermesClient = new HermesClient({
  url: config.hermesWsUrl,
  token: config.phoneToken,
  deviceId: config.deviceId,
  onMessage: (msg) => void manager.onCoreMessage(msg),
  onReconnect: () => console.log("[main] reconnected to hermes-core"),
  wsFactory: (url, headers) => new WebSocket(url, { headers }) as any,
});

const server = buildServer({ manager, twilioAuthToken: config.twilioAuthToken, publicBaseUrl: config.publicBaseUrl });

await hermesClient.connect();
console.log(`[main] linked to hermes-core as device ${config.deviceId}`);

server.listen(config.port, () => {
  console.log(`twilio-connector listening on :${config.port}`);
  console.log(`  webhooks  ${config.publicBaseUrl}/voice/inbound · /voice/outbound · /voice/status`);
  console.log(`  media     ${config.publicBaseUrl.replace(/^http/, "ws")}/media-stream`);
});
