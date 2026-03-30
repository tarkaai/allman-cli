/**
 * Per-account rate limiter for outbound LinkedIn messages.
 *
 * Default: minimum 3000ms between messages (configurable via account config).
 * Implementation: simple time-based window. If the minimum interval has not
 * elapsed since the last send, `acquire()` waits the remaining time.
 *
 * LinkedIn returns HTTP 429 on violation. We also enforce our own floor to
 * reduce ban risk. On 429 from LinkedIn, callers should wait 60s before retry.
 */

export interface RateLimiterOptions {
  /** Minimum milliseconds between message sends. Default: 3000 */
  minIntervalMs?: number;
}

export class RateLimiter {
  private readonly minIntervalMs: number;
  private lastSendAt: number = 0;
  private pending: Promise<void> = Promise.resolve();

  constructor(options: RateLimiterOptions = {}) {
    this.minIntervalMs = options.minIntervalMs ?? 3000;
  }

  /**
   * Acquire a send slot. Resolves when it is safe to send the next message.
   * Calls are serialized — concurrent acquires queue up correctly.
   */
  async acquire(): Promise<void> {
    const previous = this.pending;
    let resolve!: () => void;
    this.pending = new Promise<void>((r) => {
      resolve = r;
    });

    await previous;

    const now = Date.now();
    const elapsed = now - this.lastSendAt;
    const wait = this.minIntervalMs - elapsed;

    if (wait > 0) {
      await sleep(wait);
    }

    this.lastSendAt = Date.now();
    resolve();
  }

  /** Reset the limiter (useful in tests). */
  reset(): void {
    this.lastSendAt = 0;
    this.pending = Promise.resolve();
  }

  /** How many ms remain until the next send is allowed (0 if ready). */
  remainingMs(): number {
    return Math.max(0, this.minIntervalMs - (Date.now() - this.lastSendAt));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Global registry of per-account rate limiters (keyed by account slug). */
const limiters = new Map<string, RateLimiter>();

export function getRateLimiter(accountSlug: string, minIntervalMs?: number): RateLimiter {
  let limiter = limiters.get(accountSlug);
  if (!limiter) {
    limiter = new RateLimiter({ minIntervalMs });
    limiters.set(accountSlug, limiter);
  }
  return limiter;
}
