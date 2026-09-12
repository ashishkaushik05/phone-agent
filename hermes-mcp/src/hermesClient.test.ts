import { describe, it, expect, vi } from "vitest";
import { callHermes } from "./hermesClient.ts";

function fakeFetch(impl: (url: string, init: RequestInit) => Response | Promise<Response>) {
  return vi.fn(impl) as unknown as typeof fetch;
}

const deps = (fetchImpl: typeof fetch) => ({ baseUrl: "http://hermes-core.test", token: "tok123", fetchImpl });

describe("callHermes", () => {
  it("sends method/path/body/bearer correctly and returns parsed JSON on success", async () => {
    const fetchImpl = fakeFetch((url, init) => {
      expect(url).toBe("http://hermes-core.test/sms");
      expect(init.method).toBe("POST");
      expect(init.headers).toMatchObject({ authorization: "Bearer tok123", "content-type": "application/json" });
      expect(JSON.parse(init.body as string)).toEqual({ to: "+1555", body: "hi" });
      return new Response(JSON.stringify({ sms_id: 1, status: "queued" }), { status: 202 });
    });
    const r = await callHermes(deps(fetchImpl), "POST", "/sms", { to: "+1555", body: "hi" });
    expect(r).toEqual({ ok: true, status: 202, data: { sms_id: 1, status: "queued" } });
  });

  it("treats 204 No Content as success with no data", async () => {
    const fetchImpl = fakeFetch(() => new Response(null, { status: 204 }));
    const r = await callHermes(deps(fetchImpl), "DELETE", "/personas/p1");
    expect(r).toEqual({ ok: true, status: 204 });
  });

  it("maps a JSON {error} body on a non-2xx response to errorMessage", async () => {
    const fetchImpl = fakeFetch(() => new Response(JSON.stringify({ error: "persona not found" }), { status: 404 }));
    const r = await callHermes(deps(fetchImpl), "GET", "/personas/nope");
    expect(r).toEqual({ ok: false, status: 404, errorMessage: "persona not found" });
  });

  it("falls back to statusText when the error body isn't JSON with an `error` field", async () => {
    const fetchImpl = fakeFetch(() => new Response("nope", { status: 500, statusText: "Internal Server Error" }));
    const r = await callHermes(deps(fetchImpl), "GET", "/health");
    expect(r.ok).toBe(false);
    expect(r.status).toBe(500);
    expect(r.errorMessage).toBe("nope"); // non-JSON text body is used verbatim when present
  });

  it("maps a fetch rejection (hermes-core unreachable) to a clean ok:false result, never throws", async () => {
    const fetchImpl = fakeFetch(() => {
      throw new Error("connect ECONNREFUSED");
    });
    const r = await callHermes(deps(fetchImpl), "GET", "/health");
    expect(r.ok).toBe(false);
    expect(r.status).toBe(0);
    expect(r.errorMessage).toContain("hermes-core unreachable");
    expect(r.errorMessage).toContain("ECONNREFUSED");
  });

  it("omits the body entirely for a GET (no accidental empty-string body)", async () => {
    const fetchImpl = fakeFetch((_url, init) => {
      expect(init.body).toBeUndefined();
      return new Response(JSON.stringify([]), { status: 200 });
    });
    await callHermes(deps(fetchImpl), "GET", "/calls");
  });
});
