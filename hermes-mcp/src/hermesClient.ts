/** Talks to hermes-core's REST API. The one and only way this adapter reaches hermes-core —
 *  no direct DB/repo access: a thin, stateless wrapper. */

export interface HermesClientDeps {
  baseUrl: string;
  token: string;
  /** Injection point for tests — defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

export interface HermesResult {
  ok: boolean;
  status: number;
  data?: unknown;
  /** Set only when ok is false. */
  errorMessage?: string;
}

export async function callHermes(
  deps: HermesClientDeps,
  method: string,
  path: string,
  body?: unknown,
): Promise<HermesResult> {
  const f = deps.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await f(`${deps.baseUrl}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${deps.token}`,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    // hermes-core unreachable (connection refused, DNS failure, etc.) — never let this
    // become an uncaught rejection; callers turn it into a clean tool-error result.
    return { ok: false, status: 0, errorMessage: `hermes-core unreachable: ${(err as Error).message}` };
  }

  if (res.status === 204) return { ok: true, status: 204 };

  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = text; // non-JSON body (shouldn't happen against hermes-core, but don't crash on it)
  }

  if (!res.ok) {
    const errorMessage =
      parsed && typeof parsed === "object" && "error" in (parsed as Record<string, unknown>)
        ? String((parsed as Record<string, unknown>).error)
        : (typeof parsed === "string" && parsed) || res.statusText;
    return { ok: false, status: res.status, errorMessage };
  }

  return { ok: true, status: res.status, data: parsed };
}
