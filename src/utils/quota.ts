/**
 * Persistent, rolling-window quotas for the two sensitive endpoints:
 * profile enrichment and outbound connection invitations.
 *
 * These are distinct from `RateLimiter` (which paces *spacing* between calls).
 * A quota caps *volume* over a long window and — critically — **survives
 * process restarts**, because LinkedIn's own limits are per-account-per-day,
 * not per-run. Ten `allman enrich` invocations in a row must not each get a
 * fresh allowance.
 *
 * On exhaustion a quota **refuses rather than sleeps**: the windows here are
 * hours-to-days, so blocking would hang the CLI. Callers stop cleanly and tell
 * the user when capacity returns.
 *
 * Defaults are seat-aware, because a Sales Navigator seat is exactly the signal
 * that an account is provisioned for higher-volume prospecting:
 *
 *                     with seat        without seat
 *   enrichment        100 / hour       25 / day
 *   companies         500 / hour      100 / day
 *   invitations        40 / day        10 / day
 *
 * Every value is overridable per account in `config.json` under `rateLimit`.
 */

export interface QuotaWindow {
  /** Maximum events allowed inside the window. */
  max: number;
  /** Window length in ms. */
  windowMs: number;
}

export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;

/** Seat-aware default quotas. */
export function defaultEnrichmentQuota(hasSalesNavSeat: boolean): QuotaWindow {
  return hasSalesNavSeat ? { max: 100, windowMs: HOUR_MS } : { max: 25, windowMs: DAY_MS };
}

/**
 * Company lookups hit a different resource (`/organization/companies`) than
 * profile enrichment (`/identity/dash/profiles`), so LinkedIn meters them
 * separately. They also read org pages rather than people, which is the less
 * sensitive of the two. Given its own, more generous ledger so that resolving
 * employers never eats the budget for enriching people.
 */
export function defaultCompanyQuota(hasSalesNavSeat: boolean): QuotaWindow {
  return hasSalesNavSeat ? { max: 500, windowMs: HOUR_MS } : { max: 100, windowMs: DAY_MS };
}

export function defaultInviteQuota(hasSalesNavSeat: boolean): QuotaWindow {
  return hasSalesNavSeat ? { max: 40, windowMs: DAY_MS } : { max: 10, windowMs: DAY_MS };
}

export interface QuotaState {
  /** Unix-ms timestamps of events, oldest first. Pruned to the window. */
  timestamps: number[];
}

export interface QuotaStatus {
  used: number;
  remaining: number;
  max: number;
  /** When the next slot frees up (unix ms), or null if capacity is available. */
  nextFreeAt: number | null;
}

/**
 * A rolling-window counter over a persisted timestamp list.
 *
 * Construct from persisted state, call `tryConsume()` before each sensitive
 * call, and persist `timestamps` afterwards. Pure and synchronous — the caller
 * owns I/O, which keeps this trivially testable.
 */
export class Quota {
  private readonly max: number;
  private readonly windowMs: number;
  private stamps: number[];

  constructor(window: QuotaWindow, state?: QuotaState | null) {
    this.max = window.max;
    this.windowMs = window.windowMs;
    this.stamps = [...(state?.timestamps ?? [])].sort((a, b) => a - b);
  }

  /** Drop timestamps that have aged out of the window. */
  private prune(now: number): void {
    const cutoff = now - this.windowMs;
    let i = 0;
    while (i < this.stamps.length && (this.stamps[i] ?? 0) <= cutoff) i++;
    if (i > 0) this.stamps.splice(0, i);
  }

  /**
   * Consume one slot. Returns true if allowed (and records the event),
   * false if the window is full.
   */
  tryConsume(now: number = Date.now()): boolean {
    this.prune(now);
    if (this.stamps.length >= this.max) return false;
    this.stamps.push(now);
    return true;
  }

  status(now: number = Date.now()): QuotaStatus {
    this.prune(now);
    const used = this.stamps.length;
    const remaining = Math.max(0, this.max - used);
    // Capacity returns when the oldest event in the window ages out.
    const oldest = this.stamps[0];
    return {
      used,
      remaining,
      max: this.max,
      nextFreeAt: remaining > 0 || oldest === undefined ? null : oldest + this.windowMs,
    };
  }

  /** The timestamp list to persist. */
  toState(): QuotaState {
    return { timestamps: [...this.stamps] };
  }
}

/** Human-readable "try again in …" for a quota that's full. */
export function describeWait(nextFreeAt: number | null, now: number = Date.now()): string {
  if (nextFreeAt === null) return "now";
  const ms = Math.max(0, nextFreeAt - now);
  const mins = Math.ceil(ms / 60_000);
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"}`;
  const hours = Math.round((mins / 60) * 10) / 10;
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}

/** Render a quota window like "100/hour" or "40/day" for messages. */
export function describeWindow(w: QuotaWindow): string {
  const unit =
    w.windowMs === HOUR_MS
      ? "hour"
      : w.windowMs === DAY_MS
        ? "day"
        : `${Math.round(w.windowMs / 60000)}min`;
  return `${w.max}/${unit}`;
}
