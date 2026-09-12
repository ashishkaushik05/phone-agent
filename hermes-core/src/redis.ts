import { EventEmitter } from "node:events";
import { Redis } from "ioredis";

export interface Bus {
  publish(callId: string, ev: unknown): Promise<void>;
  subscribe(cb: (callId: string, ev: unknown) => void): Promise<void>;
  close(): Promise<void>;
}

const CHANNEL = "hermes:events";

/** Attach a no-op-with-log error handler so an unreachable Redis logs
 *  instead of crashing the process with an unhandled 'error' event. */
function guard(client: Redis, label: string): Redis {
  client.on("error", (e: Error) => {
    console.error(`[redis] ${label} error:`, e.message);
  });
  return client;
}

export function makeLocalBus(): Bus {
  const em = new EventEmitter();
  em.setMaxListeners(100);
  return {
    publish: async (callId, ev) => void em.emit(CHANNEL, callId, ev),
    subscribe: async (cb) => void em.on(CHANNEL, cb),
    close: async () => void em.removeAllListeners(),
  };
}

export function makeBus(redisUrl: string): Bus {
  const pub = guard(new Redis(redisUrl), "pub");
  const sub = guard(new Redis(redisUrl), "sub");
  return {
    publish: async (callId, ev) => {
      await pub.publish(CHANNEL, JSON.stringify({ callId, ev }));
    },
    subscribe: async (cb) => {
      await sub.subscribe(CHANNEL);
      sub.on("message", (_ch: string, raw: string) => {
        try {
          const { callId, ev } = JSON.parse(raw);
          cb(callId, ev);
        } catch (e) {
          console.error("[redis] bad event payload:", (e as Error).message);
        }
      });
    },
    close: async () => {
      await Promise.allSettled([pub.quit(), sub.quit()]);
    },
  };
}

/** Best-effort mirror of a call snapshot into Redis (`hermes:call:<id>`, 1h TTL).
 *  No-op when redisUrl is falsy; never throws. */
export async function mirrorCall(
  redisUrl: string | null,
  callId: string,
  snapshot: unknown,
): Promise<void> {
  if (!redisUrl) return;
  const r = guard(new Redis(redisUrl, { lazyConnect: true }), "mirror");
  try {
    await r.connect();
    await r.set(`hermes:call:${callId}`, JSON.stringify(snapshot), "EX", 3600);
  } catch (e) {
    console.error("[redis] mirror failed:", (e as Error).message);
  } finally {
    r.disconnect();
  }
}
