import { beforeEach, describe, expect, it, vi } from "vitest";
import { getRateLimiter, RateLimiter } from "@/utils/rate-limiter.js";

describe("RateLimiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("resolves immediately on first acquire", async () => {
    const limiter = new RateLimiter({ minIntervalMs: 3000 });
    const start = Date.now();
    await limiter.acquire();
    expect(Date.now() - start).toBeLessThan(50);
  });

  it("waits the minimum interval before second acquire", async () => {
    const limiter = new RateLimiter({ minIntervalMs: 3000 });
    await limiter.acquire();

    let resolved = false;
    const p = limiter.acquire().then(() => {
      resolved = true;
    });

    // Before the interval elapses, should not have resolved
    vi.advanceTimersByTime(2000);
    await Promise.resolve(); // flush microtasks
    expect(resolved).toBe(false);

    // After full interval, should resolve
    vi.advanceTimersByTime(1100);
    await p;
    expect(resolved).toBe(true);
  });

  it("reports remaining ms correctly", async () => {
    const limiter = new RateLimiter({ minIntervalMs: 3000 });
    await limiter.acquire();
    expect(limiter.remainingMs()).toBeGreaterThan(0);
    vi.advanceTimersByTime(3000);
    expect(limiter.remainingMs()).toBe(0);
  });

  it("reset() clears the state", async () => {
    const limiter = new RateLimiter({ minIntervalMs: 3000 });
    await limiter.acquire();
    limiter.reset();
    expect(limiter.remainingMs()).toBe(0);
  });

  it("serializes concurrent acquires in order", async () => {
    const limiter = new RateLimiter({ minIntervalMs: 100 });
    const order: number[] = [];

    // Kick off 3 concurrent acquires
    const p1 = limiter.acquire().then(() => order.push(1));
    const p2 = limiter.acquire().then(() => order.push(2));
    const p3 = limiter.acquire().then(() => order.push(3));

    // Advance timers to let them all complete
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(200);
      await Promise.resolve();
    }

    await Promise.all([p1, p2, p3]);
    expect(order).toEqual([1, 2, 3]);
  });
});

describe("getRateLimiter", () => {
  it("returns the same instance for the same account slug", () => {
    const l1 = getRateLimiter("test-account-unique-1");
    const l2 = getRateLimiter("test-account-unique-1");
    expect(l1).toBe(l2);
  });

  it("returns different instances for different account slugs", () => {
    const l1 = getRateLimiter("account-a-unique");
    const l2 = getRateLimiter("account-b-unique");
    expect(l1).not.toBe(l2);
  });
});
