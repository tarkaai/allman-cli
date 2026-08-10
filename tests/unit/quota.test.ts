/**
 * Rolling-window volume quotas for the two sensitive endpoints.
 * Pure/synchronous — time is injected, so no fake timers needed.
 */
import { describe, expect, it } from "vitest";
import { resolveQuotaWindow } from "@/utils/account-quota.js";
import {
  DAY_MS,
  defaultEnrichmentQuota,
  defaultInviteQuota,
  describeWait,
  describeWindow,
  HOUR_MS,
  Quota,
} from "@/utils/quota.js";

const T0 = 1_800_000_000_000; // fixed epoch — tests must not depend on wall clock

describe("seat-aware defaults", () => {
  it("gives a Sales Navigator seat the higher allowances", () => {
    expect(defaultEnrichmentQuota(true)).toEqual({ max: 100, windowMs: HOUR_MS });
    expect(defaultInviteQuota(true)).toEqual({ max: 40, windowMs: DAY_MS });
  });

  it("falls back to conservative daily caps without a seat", () => {
    expect(defaultEnrichmentQuota(false)).toEqual({ max: 25, windowMs: DAY_MS });
    expect(defaultInviteQuota(false)).toEqual({ max: 10, windowMs: DAY_MS });
  });
});

describe("Quota", () => {
  it("allows up to max, then refuses", () => {
    const q = new Quota({ max: 3, windowMs: HOUR_MS });
    expect(q.tryConsume(T0)).toBe(true);
    expect(q.tryConsume(T0)).toBe(true);
    expect(q.tryConsume(T0)).toBe(true);
    expect(q.tryConsume(T0)).toBe(false);
    expect(q.status(T0)).toMatchObject({ used: 3, remaining: 0, max: 3 });
  });

  it("frees capacity as events age out of the window", () => {
    const q = new Quota({ max: 2, windowMs: HOUR_MS });
    q.tryConsume(T0);
    q.tryConsume(T0 + 10 * 60_000); // +10min
    expect(q.tryConsume(T0 + 20 * 60_000)).toBe(false);
    // The first event ages out one hour after it happened.
    expect(q.tryConsume(T0 + HOUR_MS + 1)).toBe(true);
  });

  it("reports when the next slot frees up", () => {
    const q = new Quota({ max: 1, windowMs: HOUR_MS });
    q.tryConsume(T0);
    expect(q.status(T0).nextFreeAt).toBe(T0 + HOUR_MS);
    // With capacity available there's nothing to wait for.
    expect(new Quota({ max: 5, windowMs: HOUR_MS }).status(T0).nextFreeAt).toBeNull();
  });

  it("round-trips through persisted state (survives a restart)", () => {
    const first = new Quota({ max: 2, windowMs: DAY_MS });
    first.tryConsume(T0);
    first.tryConsume(T0);
    // A fresh process re-reads the ledger and must NOT get a new allowance.
    const resumed = new Quota({ max: 2, windowMs: DAY_MS }, first.toState());
    expect(resumed.tryConsume(T0)).toBe(false);
  });

  it("drops stale timestamps loaded from disk", () => {
    const stale = { timestamps: [T0 - 2 * DAY_MS, T0 - 3 * DAY_MS] };
    const q = new Quota({ max: 1, windowMs: DAY_MS }, stale);
    expect(q.tryConsume(T0)).toBe(true);
  });
});

describe("resolveQuotaWindow", () => {
  it("uses seat-aware defaults when config is empty", () => {
    expect(resolveQuotaWindow("enrichment", {}, true)).toEqual({ max: 100, windowMs: HOUR_MS });
    expect(resolveQuotaWindow("invite", {}, false)).toEqual({ max: 10, windowMs: DAY_MS });
  });

  it("honors per-account overrides", () => {
    const config = {
      rateLimit: {
        minMessageIntervalMs: 3000,
        maxEnrichments: 5,
        enrichmentWindowMs: 60_000,
        maxInvitesPerDay: 2,
      },
    };
    expect(resolveQuotaWindow("enrichment", config, true)).toEqual({ max: 5, windowMs: 60_000 });
    expect(resolveQuotaWindow("invite", config, true)).toEqual({ max: 2, windowMs: DAY_MS });
  });
});

describe("formatting helpers", () => {
  it("describes windows the way the docs do", () => {
    expect(describeWindow({ max: 100, windowMs: HOUR_MS })).toBe("100/hour");
    expect(describeWindow({ max: 40, windowMs: DAY_MS })).toBe("40/day");
  });

  it("describes the wait in minutes then hours", () => {
    expect(describeWait(T0 + 5 * 60_000, T0)).toBe("5 minutes");
    expect(describeWait(T0 + 2 * HOUR_MS, T0)).toBe("2 hours");
    expect(describeWait(null, T0)).toBe("now");
  });
});
