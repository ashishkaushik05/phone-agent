import { describe, it, expect, vi } from "vitest";
import { DeviceRegistry } from "./devices.ts";

/** Minimal ws-like stub: a `.close` spy plus the `readyState`/`OPEN` pair the registry reads. */
function fakeWs() {
  return { readyState: 1, OPEN: 1, close: vi.fn(), send: vi.fn() } as unknown as import("ws").WebSocket;
}

describe("DeviceRegistry", () => {
  it("tracks multiple sockets, resolves soleId, and replaces a conn by id", () => {
    const reg = new DeviceRegistry();
    const wsA = fakeWs();
    const wsB = fakeWs();

    reg.register("a", wsA);
    reg.register("b", wsB);
    expect(reg.list().length).toBe(2);
    expect(reg.soleId()).toBeUndefined();

    reg.drop("b");
    expect(reg.list().length).toBe(1);
    expect(reg.soleId()).toBe("a");

    const wsA2 = fakeWs();
    reg.register("a", wsA2);
    expect(wsA.close).toHaveBeenCalledTimes(1);
    expect(reg.get("a")?.ws).toBe(wsA2);
    expect(reg.list().length).toBe(1);
  });

  it("re-registering the SAME socket under the same id does not close it", () => {
    const reg = new DeviceRegistry();
    const wsA = fakeWs();
    reg.register("a", wsA);
    reg.register("a", wsA); // device sent `hello` twice on one socket
    expect(wsA.close).not.toHaveBeenCalled();
    expect(reg.get("a")?.ws).toBe(wsA);
    expect(reg.list().length).toBe(1);
  });

  it("dropSocket removes the conn whose ws matches", () => {
    const reg = new DeviceRegistry();
    const wsA = fakeWs();
    reg.register("a", wsA);
    reg.dropSocket(fakeWs()); // unknown socket: no-op
    expect(reg.get("a")).toBeTruthy();
    reg.dropSocket(wsA);
    expect(reg.get("a")).toBeUndefined();
  });

  it("dropSocket removes EVERY conn that owns the socket (no phantom left behind)", () => {
    const reg = new DeviceRegistry();
    const ws = fakeWs();
    reg.register("a", ws);
    reg.register("b", ws); // one socket, two ids
    expect(reg.list().length).toBe(2);
    reg.dropSocket(ws);
    expect(reg.get("a")).toBeUndefined();
    expect(reg.get("b")).toBeUndefined();
    expect(reg.list().length).toBe(0);
    expect(reg.soleId()).toBeUndefined();
  });

  it("touch bumps lastSeen", () => {
    const reg = new DeviceRegistry();
    reg.register("a", fakeWs());
    const before = reg.get("a")!.lastSeen;
    vi.spyOn(Date, "now").mockReturnValue(before + 1000);
    reg.touch("a");
    expect(reg.get("a")!.lastSeen).toBe(before + 1000);
    vi.restoreAllMocks();
  });
});
