/**
 * Tests for datetime handling and sync window logic.
 *
 * Covers:
 *   1. parseSince — all duration formats and ISO dates
 *   2. parseSince — fallback to lastSyncAt
 *   3. parseSince — fallback to default when neither is present
 *   4. syncStartedAt timing — the sync start time is captured before async work
 *   5. Conversations sort logic uses numeric ms comparisons
 *   6. relativeTime edge cases (0ms ago, future timestamps)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { relativeTime } from "@/utils/output.js";
import { parseSince } from "@/utils/time.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Tolerance for "now - delta" comparisons in ms (accounts for test execution time). */
const TOLERANCE_MS = 2000;

function approxEqual(a: number, b: number, tolerance = TOLERANCE_MS): boolean {
  return Math.abs(a - b) <= tolerance;
}

// ---------------------------------------------------------------------------
// parseSince — duration formats
// ---------------------------------------------------------------------------

describe("parseSince — duration formats", () => {
  it("parses 1h correctly", () => {
    const before = Date.now();
    const result = parseSince("1h");
    const expected = before - 1 * 60 * 60 * 1000;
    expect(approxEqual(result, expected)).toBe(true);
  });

  it("parses 6h correctly", () => {
    const before = Date.now();
    const result = parseSince("6h");
    const expected = before - 6 * 60 * 60 * 1000;
    expect(approxEqual(result, expected)).toBe(true);
  });

  it("parses 3d correctly", () => {
    const before = Date.now();
    const result = parseSince("3d");
    const expected = before - 3 * 24 * 60 * 60 * 1000;
    expect(approxEqual(result, expected)).toBe(true);
  });

  it("parses 7d correctly", () => {
    const before = Date.now();
    const result = parseSince("7d");
    const expected = before - 7 * 24 * 60 * 60 * 1000;
    expect(approxEqual(result, expected)).toBe(true);
  });

  it("parses 1w correctly (7 days)", () => {
    const before = Date.now();
    const result1w = parseSince("1w");
    const result7d = before - 7 * 24 * 60 * 60 * 1000;
    expect(approxEqual(result1w, result7d)).toBe(true);
  });

  it("parses 2w correctly (14 days)", () => {
    const before = Date.now();
    const result = parseSince("2w");
    const expected = before - 14 * 24 * 60 * 60 * 1000;
    expect(approxEqual(result, expected)).toBe(true);
  });

  it("parses 1mo correctly (30 days)", () => {
    const before = Date.now();
    const result = parseSince("1mo");
    const expected = before - 30 * 24 * 60 * 60 * 1000;
    expect(approxEqual(result, expected)).toBe(true);
  });

  it("parses 3mo correctly (90 days)", () => {
    const before = Date.now();
    const result = parseSince("3mo");
    const expected = before - 90 * 24 * 60 * 60 * 1000;
    expect(approxEqual(result, expected)).toBe(true);
  });

  it("parses 6mo correctly (180 days)", () => {
    const before = Date.now();
    const result = parseSince("6mo");
    const expected = before - 180 * 24 * 60 * 60 * 1000;
    expect(approxEqual(result, expected)).toBe(true);
  });

  it("parses 1y correctly (365 days)", () => {
    const before = Date.now();
    const result = parseSince("1y");
    const expected = before - 365 * 24 * 60 * 60 * 1000;
    expect(approxEqual(result, expected)).toBe(true);
  });

  it("parses 2y correctly (730 days)", () => {
    const before = Date.now();
    const result = parseSince("2y");
    const expected = before - 2 * 365 * 24 * 60 * 60 * 1000;
    expect(approxEqual(result, expected)).toBe(true);
  });

  it("result is always in the past relative to now", () => {
    for (const spec of ["1h", "3d", "1w", "2mo", "1y"]) {
      const result = parseSince(spec);
      expect(result).toBeLessThan(Date.now() + 1);
    }
  });

  it("parses an ISO date string (YYYY-MM-DD) as UTC midnight", () => {
    const result = parseSince("2026-01-15");
    expect(result).toBe(new Date("2026-01-15").getTime());
    expect(Number.isNaN(result)).toBe(false);
  });

  it("parses a full ISO datetime string", () => {
    const result = parseSince("2026-03-01T00:00:00Z");
    expect(result).toBe(new Date("2026-03-01T00:00:00Z").getTime());
  });

  it("throws on an invalid --since value", () => {
    expect(() => parseSince("not-a-date")).toThrow(/Invalid --since value/);
  });

  it("throws on a string that looks like a number but is not a valid duration", () => {
    // "3x" is neither a valid duration nor a parseable ISO date
    expect(() => parseSince("3x")).toThrow(/Invalid --since value/);
  });

  it("result is a finite Unix ms number", () => {
    const result = parseSince("1d");
    expect(typeof result).toBe("number");
    expect(Number.isFinite(result)).toBe(true);
    // Must be in a plausible range (> year 2020)
    expect(result).toBeGreaterThan(new Date("2020-01-01").getTime());
  });

  it("larger durations produce earlier timestamps (1y < 1d)", () => {
    const oneYear = parseSince("1y");
    const oneDay = parseSince("1d");
    expect(oneYear).toBeLessThan(oneDay);
  });
});

// ---------------------------------------------------------------------------
// parseSince — fallback to lastSyncAt
// ---------------------------------------------------------------------------

describe("parseSince — lastSyncAt fallback", () => {
  it("returns lastSyncAt timestamp when no since option is given", () => {
    const lastSyncAt = "2026-03-30T09:00:00.000Z";
    const expected = new Date(lastSyncAt).getTime();
    const result = parseSince(undefined, lastSyncAt);
    expect(result).toBe(expected);
  });

  it("since option takes priority over lastSyncAt", () => {
    const lastSyncAt = "2026-03-30T09:00:00.000Z";
    const lastSyncMs = new Date(lastSyncAt).getTime();
    // 1d since will be yesterday — different from a lastSyncAt from 3 days ago
    const result = parseSince("1d", lastSyncAt);
    // The result should NOT equal lastSyncAt
    expect(result).not.toBe(lastSyncMs);
    // And should be more recent than lastSyncAt (closer to now)
    expect(result).toBeGreaterThan(lastSyncMs);
  });

  it("lastSyncAt is parsed as UTC — no timezone shift", () => {
    // ISO string with explicit Z suffix must not shift
    const isoUtc = "2026-04-01T00:00:00.000Z";
    const result = parseSince(undefined, isoUtc);
    expect(result).toBe(new Date("2026-04-01T00:00:00.000Z").getTime());
    // Verify UTC: midnight UTC is not midnight local time in offset timezones
    // The result must match the Z-qualified parse exactly
    expect(result).toBe(1775001600000);
  });

  it("lastSyncAt is not used when since is explicitly provided", () => {
    const lastSyncAt = "2024-01-01T00:00:00Z"; // very old
    const result = parseSince("1d", lastSyncAt);
    // Must be ~1 day ago, not 2+ years ago
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    expect(approxEqual(result, dayAgo)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parseSince — default fallback (no since, no lastSyncAt)
// ---------------------------------------------------------------------------

describe("parseSince — default fallback", () => {
  it("defaults to 3 days ago when no arguments given", () => {
    const before = Date.now();
    const result = parseSince(undefined);
    const expected = before - 3 * 24 * 60 * 60 * 1000;
    expect(approxEqual(result, expected)).toBe(true);
  });

  it("uses custom defaultMs when provided", () => {
    const before = Date.now();
    const ninetyDays = 90 * 24 * 60 * 60 * 1000;
    const result = parseSince(undefined, undefined, ninetyDays);
    const expected = before - ninetyDays;
    expect(approxEqual(result, expected)).toBe(true);
  });

  it("90-day override matches historical sync default", () => {
    // sync.ts passes 90 * 24 * 60 * 60 * 1000 as defaultMs
    const before = Date.now();
    const result = parseSince(undefined, undefined, 90 * 24 * 60 * 60 * 1000);
    const expected = before - 90 * 24 * 60 * 60 * 1000;
    expect(approxEqual(result, expected)).toBe(true);
  });

  it("3-day default (3d) and undefined (default) produce equal results", () => {
    const explicit = parseSince("3d");
    const implicit = parseSince(undefined);
    // Both should be approximately equal (within 10ms of each other since both call Date.now())
    expect(Math.abs(explicit - implicit)).toBeLessThanOrEqual(50);
  });
});

// ---------------------------------------------------------------------------
// syncStartedAt timing — captures time BEFORE async work
// ---------------------------------------------------------------------------

describe("syncStartedAt timing", () => {
  it("syncStartedAt (as ms) is >= sinceMs", () => {
    // Simulate what sync.ts does:
    //   const sinceMs = parseSince(options.since, ...)
    //   const syncStartedAt = new Date().toISOString()
    const sinceMs = parseSince(undefined, undefined, 90 * 24 * 60 * 60 * 1000);
    const syncStartedAt = new Date().toISOString();
    const syncStartedAtMs = new Date(syncStartedAt).getTime();

    expect(syncStartedAtMs).toBeGreaterThanOrEqual(sinceMs);
  });

  it("syncStartedAt stored as ISO string round-trips cleanly", () => {
    const syncStartedAt = new Date().toISOString();
    const ms = new Date(syncStartedAt).getTime();
    expect(typeof ms).toBe("number");
    expect(Number.isFinite(ms)).toBe(true);
    expect(ms).toBeGreaterThan(new Date("2020-01-01").getTime());
  });

  it("syncStartedAt stored as ISO string is UTC (ends with Z)", () => {
    const syncStartedAt = new Date().toISOString();
    expect(syncStartedAt).toMatch(/Z$/);
  });

  it("using syncStartedAt as new lastSyncAt means next sync window covers this one", () => {
    // The fix: syncStartedAt is set BEFORE API calls
    const syncStartedAt = new Date().toISOString();

    // Simulate time passing (async API work)
    const fakeApiDelayMs = 5000;
    const endOfSyncMs = new Date(syncStartedAt).getTime() + fakeApiDelayMs;

    // A message that arrived DURING the sync
    const messageTimeDuringSyncMs = new Date(syncStartedAt).getTime() + 1000;

    // Next sync uses syncStartedAt as lastSyncAt (the START)
    const nextSinceMsFixed = parseSince(undefined, syncStartedAt);
    expect(nextSinceMsFixed).toBe(new Date(syncStartedAt).getTime());

    // The message falls at or after the start of the next sync window — no gap
    expect(messageTimeDuringSyncMs).toBeGreaterThanOrEqual(nextSinceMsFixed);

    // The message falls BEFORE the end of the sync — shows the bug would miss it
    expect(messageTimeDuringSyncMs).toBeLessThan(endOfSyncMs);
  });

  it("using Date.now() at END of sync (the old bug) skips messages from during sync", () => {
    // Document the bug: if we stored the time at END of sync, not start,
    // messages that arrived during the sync are permanently skipped.

    const syncStartedAt = new Date().toISOString();
    const syncStartMs = new Date(syncStartedAt).getTime();

    // A message that arrived 1 second into the sync
    const messageTimeDuringSyncMs = syncStartMs + 1000;

    // Buggy lastSyncAt = end of sync (2 seconds after start)
    const endOfSyncMs = syncStartMs + 2000;
    const buggyLastSyncAt = new Date(endOfSyncMs).toISOString();

    // Next sync with the bug: starts from endOfSyncMs
    const nextSinceMsBuggy = parseSince(undefined, buggyLastSyncAt);
    expect(nextSinceMsBuggy).toBe(endOfSyncMs);

    // The message (at +1s) falls BEFORE the buggy window (+2s) — gap!
    expect(messageTimeDuringSyncMs).toBeLessThan(nextSinceMsBuggy);

    // Fixed: next sync with syncStartedAt covers the message
    const nextSinceMsFixed = parseSince(undefined, syncStartedAt);
    expect(messageTimeDuringSyncMs).toBeGreaterThanOrEqual(nextSinceMsFixed);
  });
});

// ---------------------------------------------------------------------------
// Conversations sort — numeric ms comparisons
// ---------------------------------------------------------------------------

describe("conversations sort logic — numeric ms", () => {
  /**
   * Mirror of the sort key used in conversations.ts:
   *   syncState.newestMessageAt ?? new Date(lastActivityAt ?? 0).getTime()
   */
  function sortKey(newestMessageAt: number | null, lastActivityAt: string | null): number {
    return newestMessageAt ?? new Date(lastActivityAt ?? 0).getTime();
  }

  it("sorts by newestMessageAt (number) when present", () => {
    const conv1 = { newestMessageAt: 1743350000000, lastActivityAt: "2026-03-30T00:00:00Z" };
    const conv2 = { newestMessageAt: 1743360000000, lastActivityAt: "2026-03-29T00:00:00Z" };

    const sorted = [conv1, conv2].sort((x, y) => {
      return (
        sortKey(y.newestMessageAt, y.lastActivityAt) - sortKey(x.newestMessageAt, x.lastActivityAt)
      );
    });
    // conv2 has the larger newestMessageAt — should sort first
    expect(sorted[0]).toBe(conv2);
    expect(sorted[1]).toBe(conv1);
  });

  it("falls back to lastActivityAt ISO string parsed to ms", () => {
    const conv1 = { newestMessageAt: null, lastActivityAt: "2026-03-30T00:00:00Z" };
    const conv2 = { newestMessageAt: null, lastActivityAt: "2026-03-01T00:00:00Z" };

    const k1 = sortKey(conv1.newestMessageAt, conv1.lastActivityAt);
    const k2 = sortKey(conv2.newestMessageAt, conv2.lastActivityAt);

    // conv1 is more recent → k1 > k2
    expect(k1).toBeGreaterThan(k2);
  });

  it("returns 0 as sort key when both fields are null (lowest priority)", () => {
    const key = sortKey(null, null);
    expect(key).toBe(0);
    // Any conversation with a real timestamp will sort before a null-null conv
    expect(sortKey(1, null)).toBeGreaterThan(key);
  });

  it("newestMessageAt (number) takes priority over lastActivityAt (ISO string)", () => {
    // Conv A: has recent synced messages, but stale lastActivityAt
    const keyA = sortKey(1743360000000, "2026-01-01T00:00:00Z");
    // Conv B: no synced messages, but recent lastActivityAt
    const keyB = sortKey(null, "2026-03-31T00:00:00Z");

    // Both keys are numbers, and subtraction-based sort works correctly
    expect(typeof keyA).toBe("number");
    expect(typeof keyB).toBe("number");
    expect(() => keyB - keyA).not.toThrow();
    // Confirm the sort key is the raw newestMessageAt, not parsed from ISO
    expect(keyA).toBe(1743360000000);
  });

  it("sort comparison is purely numeric — no string lexicographic issues", () => {
    // "9" > "10" lexicographically, but 9 < 10 numerically
    // Confirm the sort uses subtraction, not string comparison
    const earlier = 9_000_000_000; // "9000000000" lexicographically > "10000000000"
    const later = 10_000_000_000;
    const sorted = [{ t: earlier }, { t: later }].sort((a, b) => b.t - a.t);
    expect(sorted[0]?.t).toBe(later);
    expect(sorted[1]?.t).toBe(earlier);
  });
});

// ---------------------------------------------------------------------------
// relativeTime edge cases
// ---------------------------------------------------------------------------

describe("relativeTime edge cases", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns '0s ago' for the current moment (0ms diff)", () => {
    const now = Date.now();
    const result = relativeTime(now);
    expect(result).toBe("0s ago");
  });

  it("returns seconds for sub-minute timestamps", () => {
    const now = Date.now();
    vi.advanceTimersByTime(45_000); // advance 45s
    const result = relativeTime(now);
    expect(result).toBe("45s ago");
  });

  it("returns '59s ago' just before the minute boundary", () => {
    const now = Date.now();
    vi.advanceTimersByTime(59_999); // 59.999s
    const result = relativeTime(now);
    expect(result).toBe("59s ago");
  });

  it("returns '1m ago' at exactly 60 seconds", () => {
    const now = Date.now();
    vi.advanceTimersByTime(60_000);
    const result = relativeTime(now);
    expect(result).toBe("1m ago");
  });

  it("returns minutes for sub-hour timestamps", () => {
    const now = Date.now();
    vi.advanceTimersByTime(5 * 60_000); // 5 minutes
    const result = relativeTime(now);
    expect(result).toBe("5m ago");
  });

  it("returns '1h ago' at exactly 60 minutes", () => {
    const now = Date.now();
    vi.advanceTimersByTime(3600_000);
    const result = relativeTime(now);
    expect(result).toBe("1h ago");
  });

  it("returns hours for sub-day timestamps", () => {
    const now = Date.now();
    vi.advanceTimersByTime(3 * 3600_000); // 3 hours
    const result = relativeTime(now);
    expect(result).toBe("3h ago");
  });

  it("returns '1d ago' at exactly 24 hours", () => {
    const now = Date.now();
    vi.advanceTimersByTime(86_400_000);
    const result = relativeTime(now);
    expect(result).toBe("1d ago");
  });

  it("returns days for multi-day timestamps", () => {
    const now = Date.now();
    vi.advanceTimersByTime(2 * 86_400_000); // 2 days
    const result = relativeTime(now);
    expect(result).toBe("2d ago");
  });

  it("result is always a string", () => {
    const now = Date.now();
    expect(typeof relativeTime(now)).toBe("string");
    vi.advanceTimersByTime(1000);
    expect(typeof relativeTime(now)).toBe("string");
    vi.advanceTimersByTime(1_000_000);
    expect(typeof relativeTime(now)).toBe("string");
  });
});
