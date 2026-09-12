import { createServer, type Server } from "node:http";
import { WebSocketServer } from "ws";
import { config } from "./config.ts";
import { handle, type HttpDeps } from "./http.ts";
import { isPhoneMsg } from "./protocol.ts";

export type { HttpDeps };

export interface BuildServerDeps extends HttpDeps {
  /** Called once with the /dashboard WebSocketServer so the entrypoint can track clients. */
  attachDashboard?: (wss: WebSocketServer) => void;
}

/**
 * Build the HTTP + WebSocket server. Does NOT listen — the caller does that.
 * Side-effect-free on import: no DB, no migrate, no OpenAI, nothing global.
 */
export function buildServer(deps: BuildServerDeps): Server {
  const server = createServer((req, res) => void handle(req, res, deps));

  const phoneWss = new WebSocketServer({ noServer: true });
  const dashWss = new WebSocketServer({ noServer: true });
  deps.attachDashboard?.(dashWss);

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

    if (url.pathname === "/phone") {
      if (req.headers.authorization !== `Bearer ${config.phoneToken}`) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        return socket.destroy();
      }
      return phoneWss.handleUpgrade(req, socket, head, (ws) => {
        // Not registered yet — the device claims its id via `hello`.
        console.log("[server] phone-connector socket opened");

        ws.on("message", async (raw) => {
          let msg: unknown;
          try {
            msg = JSON.parse(raw.toString());
          } catch {
            return console.error("[server] non-json from phone");
          }
          if (!isPhoneMsg(msg)) return console.error("[server] unrecognized phone message", msg);

          if (msg.type === "hello") {
            deps.registry.register(msg.device_id, ws);
            deps.sendToDevice(msg.device_id, { type: "hello_ack", device_id: msg.device_id });
            console.log("[server] device registered:", msg.device_id);
            void deps.engine
              .resendPendingSms(msg.device_id, deps.sendToDevice)
              .catch((e) => console.error("[server] resendPendingSms failed:", e));
            return;
          }

          if (!deps.registry.get(msg.device_id)) {
            return console.error("[server] message from unregistered device, dropping", msg.device_id, msg.type);
          }
          deps.registry.touch(msg.device_id);
          try {
            await deps.engine.handlePhoneMessage(msg, deps.sendToDevice);
          } catch (e) {
            console.error("[server] phone message handler error", e);
          }
        });

        ws.on("close", () => {
          deps.registry.dropSocket(ws);
          console.log("[server] phone-connector socket closed");
        });
      });
    }

    if (url.pathname === "/dashboard") {
      // Browsers can't set an Authorization header on a WebSocket handshake, so the dashboard
      // link is gated by the same shared token passed as a query param instead. Without this,
      // anyone who can reach the port could open a socket and read every live transcript.
      if (url.searchParams.get("token") !== config.phoneToken) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        return socket.destroy();
      }
      return dashWss.handleUpgrade(req, socket, head, (ws) => dashWss.emit("connection", ws, req));
    }

    socket.destroy();
  });

  return server;
}
