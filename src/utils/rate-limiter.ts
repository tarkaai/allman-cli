/**
 * Per-account rate limiters.
 *
 * Two distinct limiters live here:
 *
 *   1. RateLimiter — outbound message sends. Default 3000ms minimum interval.
 *      Triggered before every POST to the messages endpoint.
 *
 *   2. DownloadRateLimiter — inbound message fetches. Default 500 messages
 *      per 60 seconds, sliding window. Triggered before each `fetchMessages`
 *      page so backfills can't accidentally hammer LinkedIn.
 *
 * LinkedIn returns HTTP 429 on violation. Both limiters enforce our own floor
 * so we stay well under the bank's threshold and reduce ban risk.
 */

export interface RateLimiterOptions {
  /** Minimum milliseconds between message sends. Default: 3000 */
  minIntervalMs?: number;
  /** Persisted timestamp of the last send (Unix ms). Enforces limits across process restarts. */
  initialLastSendAt?: number;
}

export class RateLimiter {
  private readonly minIntervalMs: number;
  private lastSendAt: number;
  private pending: Promise<void> = Promise.resolve();

  constructor(options: RateLimiterOptions = {}) {
    this.minIntervalMs = options.minIntervalMs ?? 3000;
    this.lastSendAt = options.initialLastSendAt ?? 0;
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

export function buildRateLimiter(options: RateLimiterOptions = {}): RateLimiter {
  return new RateLimiter(options);
}

/** Per-account singleton registry. Returns the same limiter instance for the same account slug. */
const _registry = new Map<string, RateLimiter>();

export function getRateLimiter(accountSlug: string, options?: RateLimiterOptions): RateLimiter {
  let limiter = _registry.get(accountSlug);
  if (!limiter) {
    limiter = new RateLimiter(options);
    _registry.set(accountSlug, limiter);
  }
  return limiter;
}

// ---------------------------------------------------------------------------
// Download rate limiter
// ---------------------------------------------------------------------------

export interface DownloadRateLimiterOptions {
  /** Maximum messages per window. Default: 500 */
  maxMessages?: number;
  /** Window length in ms. Default: 60_000 (1 minute) */
  windowMs?: number;
}

/**
 * Sliding-window rate limiter for inbound message downloads.
 *
 * Tracks the timestamp of every message acquired in the last `windowMs`. If
 * acquiring `count` more would exceed `maxMessages`, sleeps until enough old
 * timestamps have aged out. Acquires are serialized so concurrent fetchers
 * queue cleanly.
 */
export class DownloadRateLimiter {
  private readonly maxMessages: number;
  private readonly windowMs: number;
  private readonly events: number[] = [];
  private pending: Promise<void> = Promise.resolve();

  constructor(options: DownloadRateLimiterOptions = {}) {
    this.maxMessages = options.maxMessages ?? 500;
    this.windowMs = options.windowMs ?? 60_000;
  }

  /**
   * Reserve `count` message slots. Resolves once they're available.
   * Records the slots immediately so concurrent acquires don't double-count.
   */
  async acquire(count: number): Promise<void> {
    if (count <= 0) return;

    const previous = this.pending;
    let release!: () => void;
    this.pending = new Promise<void>((r) => {
      release = r;
    });
    await previous;

    try {
      while (true) {
        this.prune();
        if (this.events.length + count <= this.maxMessages) break;
        // Wait until enough events age out. The earliest expiry is the
        // (count + events.length - maxMessages)-th event from the front.
        const overflow = this.events.length + count - this.maxMessages;
        const idx = Math.max(0, overflow - 1);
        const oldest = this.events[idx];
        if (oldest === undefined) break;
        const wait = oldest + this.windowMs - Date.now();
        if (wait <= 0) continue;
        await sleep(wait);
      }
      const now = Date.now();
      for (let i = 0; i < count; i++) this.events.push(now);
    } finally {
      release();
    }
  }

  /** How many messages can be acquired right now without waiting. */
  available(): number {
    this.prune();
    return Math.max(0, this.maxMessages - this.events.length);
  }

  /** Drop events outside the window. */
  private prune(): void {
    const cutoff = Date.now() - this.windowMs;
    let i = 0;
    while (i < this.events.length && (this.events[i] ?? 0) < cutoff) i++;
    if (i > 0) this.events.splice(0, i);
  }
}

/** Per-account singleton registry for download limiters. */
const _downloadRegistry = new Map<string, DownloadRateLimiter>();

export function getDownloadRateLimiter(
  accountKey: string,
  options?: DownloadRateLimiterOptions
): DownloadRateLimiter {
  let limiter = _downloadRegistry.get(accountKey);
  if (!limiter) {
    limiter = new DownloadRateLimiter(options);
    _downloadRegistry.set(accountKey, limiter);
  }
  return limiter;
}
