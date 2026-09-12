/** Thin wrapper over the slice of Twilio's REST API this connector needs: originating an
 *  outbound call and ending a call the director wants hung up. */

export interface TwilioRestConfig {
  accountSid: string;
  authToken: string;
  /** Injected for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

export interface CreateCallParams {
  to: string;
  from: string;
  /** TwiML URL Twilio requests once the call is answered. */
  url: string;
  statusCallback?: string;
}

export class TwilioRest {
  private readonly base: string;
  private readonly authHeader: string;
  private readonly fetchImpl: typeof fetch;

  constructor(cfg: TwilioRestConfig) {
    this.base = `https://api.twilio.com/2010-04-01/Accounts/${cfg.accountSid}`;
    this.authHeader = `Basic ${Buffer.from(`${cfg.accountSid}:${cfg.authToken}`).toString("base64")}`;
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  private async post(path: string, form: Record<string, string | undefined>): Promise<any> {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(form)) if (v !== undefined) body.set(k, v);
    const res = await this.fetchImpl(`${this.base}${path}`, {
      method: "POST",
      headers: { authorization: this.authHeader, "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Twilio API ${path} failed (${res.status}): ${JSON.stringify(json)}`);
    return json;
  }

  /** Originates an outbound call. Resolves once Twilio accepts the request — not once answered. */
  async createCall(params: CreateCallParams): Promise<{ sid: string }> {
    return this.post("/Calls.json", {
      To: params.to,
      From: params.from,
      Url: params.url,
      StatusCallback: params.statusCallback,
    });
  }

  /** Ends a live call — used when the director issues `call.hangup`. */
  async endCall(callSid: string): Promise<void> {
    await this.post(`/Calls/${callSid}.json`, { Status: "completed" });
  }
}
