/**
 * HTTP + WebSocket surface Twilio talks to: the two voice webhooks, the status-callback
 * webhook, and the Media Stream WS itself. No framework — plain node:http + `ws`,
 * mirroring hermes-core/src/server.ts's shape.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import { WebSocketServer } from "ws";
import { validTwilioSignature } from "./twilio-signature.ts";
import { connectStreamTwiml } from "./twiml.ts";

/** The slice of CallSessionManager the HTTP/WS layer drives — narrowed so tests can fake it. */
export interface MediaStreamSink {
  onStreamStart(params: {
    callSid: string;
    streamSid: string;
    customParameters: Record<string, string>;
    sendToTwilio: (frame: string) => void;
  }): void;
  onStreamMedia(callSid: string, payloadB64: string): void;
  onStreamStop(callSid: string): void;
  onStatusCallback(callSid: string, status: string): void;
}

export interface ServerDeps {
  manager: MediaStreamSink;
  twilioAuthToken: string;
  /** No trailing slash — must match what's configured as the Twilio number's Voice webhook base. */
  publicBaseUrl: string;
}

const wsBaseUrl = (httpBase: string): string => httpBase.replace(/^https:/, "wss:").replace(/^http:/, "ws:");

async function readBody(req: IncomingMessage): Promise<string> {
  let s = "";
  for await (const chunk of req) s += chunk;
  return s;
}

function formToObject(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(body)) out[k] = v;
  return out;
}

export function buildServer(deps: ServerDeps): Server {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", deps.publicBaseUrl);
      const rawBody = await readBody(req);
      const params = formToObject(rawBody);
      const fullUrl = `${deps.publicBaseUrl}${req.url}`;
      const signature = req.headers["x-twilio-signature"];
      const authed = validTwilioSignature(deps.twilioAuthToken, fullUrl, params, Array.isArray(signature) ? signature[0] : signature);

      const xml = (status: number, body: string) => {
        res.writeHead(status, { "content-type": "text/xml" });
        res.end(body);
      };
      const empty = (status: number) => {
        res.writeHead(status);
        res.end();
      };

      if (!authed) return empty(403);

      if (req.method === "POST" && url.pathname === "/voice/inbound") {
        const streamUrl = `${wsBaseUrl(deps.publicBaseUrl)}/media-stream`;
        return xml(200, connectStreamTwiml(streamUrl, { from: params.From ?? "" }));
      }

      if (req.method === "POST" && url.pathname === "/voice/outbound") {
        const callId = url.searchParams.get("call_id") ?? "";
        const streamUrl = `${wsBaseUrl(deps.publicBaseUrl)}/media-stream`;
        return xml(200, connectStreamTwiml(streamUrl, { call_id: callId }));
      }

      if (req.method === "POST" && url.pathname === "/voice/status") {
        deps.manager.onStatusCallback(params.CallSid ?? "", params.CallStatus ?? "");
        return empty(200);
      }

      return empty(404);
    } catch (e) {
      console.error("[server] request handling failed:", (e as Error).message);
      res.writeHead(500);
      res.end();
    }
  });

  const mediaWss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", deps.publicBaseUrl);
    if (url.pathname !== "/media-stream") return socket.destroy();
    mediaWss.handleUpgrade(req, socket, head, (ws) => {
      let callSid: string | undefined;
      ws.on("message", (raw) => {
        let msg: any;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }
        switch (msg.event) {
          case "start":
            callSid = msg.start.callSid;
            deps.manager.onStreamStart({
              callSid: msg.start.callSid,
              streamSid: msg.start.streamSid,
              customParameters: msg.start.customParameters ?? {},
              sendToTwilio: (frame) => ws.send(frame),
            });
            return;
          case "media":
            if (callSid) deps.manager.onStreamMedia(callSid, msg.media.payload);
            return;
          case "stop":
            if (callSid) deps.manager.onStreamStop(callSid);
            return;
        }
      });
      ws.on("close", () => {
        if (callSid) deps.manager.onStreamStop(callSid);
      });
    });
  });

  return server;
}
