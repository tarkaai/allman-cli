/**
 * Time utilities shared across commands.
 */

/**
 * Parse a --since option string into a Unix millisecond timestamp.
 *
 * Supported duration formats:
 *   Nh  — N hours ago       (e.g. 1h, 6h, 24h)
 *   Nd  — N days ago        (e.g. 3d, 7d)
 *   Nw  — N weeks ago       (e.g. 1w, 2w)
 *   Nmo — N months ago (30d each) (e.g. 1mo, 3mo, 6mo)
 *   Ny  — N years ago (365d each) (e.g. 1y, 2y)
 *
 * ISO date / datetime strings are also accepted (e.g. 2025-01-15).
 *
 * When `since` is undefined:
 *   - If `lastSyncAt` (ISO string) is provided, returns that timestamp.
 *   - Otherwise falls back to `defaultMs` ago (default: 3 days).
 */
export function parseSince(
  since: string | undefined,
  lastSyncAt?: string,
  defaultMs = 3 * 24 * 60 * 60 * 1000
): number {
  if (!since) {
    if (lastSyncAt) return new Date(lastSyncAt).getTime();
    return Date.now() - defaultMs;
  }

  const durationMatch = since.match(/^(\d+)(h|d|w|mo|y)$/);
  if (durationMatch?.[1] && durationMatch[2]) {
    const n = parseInt(durationMatch[1], 10);
    const unit = durationMatch[2];
    const ms =
      unit === "h"
        ? n * 60 * 60 * 1000
        : unit === "d"
          ? n * 24 * 60 * 60 * 1000
          : unit === "w"
            ? n * 7 * 24 * 60 * 60 * 1000
            : unit === "mo"
              ? n * 30 * 24 * 60 * 60 * 1000
              : n * 365 * 24 * 60 * 60 * 1000; // "y"
    return Date.now() - ms;
  }

  const ts = Date.parse(since);
  if (!Number.isNaN(ts)) return ts;

  throw new Error(
    `Invalid --since value: "${since}". Use a duration (1h, 3d, 1w, 3mo, 1y) or an ISO date (YYYY-MM-DD).`
  );
}
