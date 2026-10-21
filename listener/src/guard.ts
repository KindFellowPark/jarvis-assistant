// Billing guard. The rule: personal work stays on the Claude subscription, and the owner is told
// the moment a run is billed at API rates. Two fields decide it, read from each run's event stream:
// `apiKeySource` in the init event must be "none" (subscription login), and every rate-limit
// event must carry `isUsingOverage: false`. A missing field counts as a failure.

export type Verdict = { ok: true } | { ok: false; reason: string; beforeModelCall: boolean };

export class BillingWatch {
  private apiKeySource: string | undefined;
  private sawInit = false;
  private sawRateEvent = false;
  private trip: Verdict | null = null;

  /** Feed one parsed stream event. Returns a failing verdict the first time a check fails. */
  observe(ev: any): Verdict | null {
    if (this.trip) return null;
    if (ev?.type === "system" && ev?.subtype === "init") {
      this.sawInit = true;
      this.apiKeySource = ev.apiKeySource;
      if (this.apiKeySource !== "none") {
        this.trip = { ok: false, reason: `apiKeySource is ${JSON.stringify(this.apiKeySource ?? null)}, not "none"`, beforeModelCall: true };
        return this.trip;
      }
    }
    if (ev?.type === "rate_limit_event") {
      this.sawRateEvent = true;
      const info = ev.rate_limit_info;
      if (info?.isUsingOverage !== false) {
        this.trip = { ok: false, reason: `isUsingOverage is ${JSON.stringify(info?.isUsingOverage ?? null)}`, beforeModelCall: false };
        return this.trip;
      }
    }
    return null;
  }

  /**
   * Final verdict once the stream has ended. `modelAnswered` is true when the run produced a
   * successful result, which means a model call was made and billed somewhere, so a missing
   * rate-limit event is a failure. A run that errored before any answer is reported as a failed
   * run by the caller, not as a billing failure.
   */
  finish(modelAnswered: boolean): Verdict {
    if (this.trip) return this.trip;
    if (!this.sawInit) return { ok: false, reason: "no init event, so apiKeySource is unknown", beforeModelCall: false };
    if (modelAnswered && !this.sawRateEvent) return { ok: false, reason: "no rate-limit event, so isUsingOverage is unknown", beforeModelCall: false };
    return { ok: true };
  }
}

/** Environment for a Claude run: an allowlist, so no API key or provider switch can leak in. */
export function runEnv(source: Record<string, string | undefined> = process.env): Record<string, string> {
  const keep = ["HOME", "USER", "LOGNAME", "PATH", "LANG", "TMPDIR", "SHELL"];
  const env: Record<string, string> = {};
  for (const k of keep) if (source[k]) env[k] = source[k]!;
  env.PATH ??= "/usr/bin:/bin";
  return env;
}
