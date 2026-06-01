/**
 * Resolves the flagship people-search `voyagerSearchDashClusters.<hash>` queryId,
 * which rotates with LinkedIn web-app deploys.
 *
 * Resolution order:
 *   1. ALLMAN_SEARCH_CLUSTERS_QID env var — manual override / escape hatch.
 *   2. Store cache (query-cache.json) — fast hot path once captured.
 *   3. Headless-browser capture (captureSearchClustersQueryId) — on cache miss
 *      or when `force` is set (e.g. the cached hash just 400'd as stale). The
 *      captured value is written back to the cache.
 *
 * Flagship-only; unrelated to the Sales Navigator seat.
 */

import type { AccountStore } from "../../store/index.js";
import { captureSearchClustersQueryId } from "../auth/queryid-capture.js";
import type { LinkedInApiClient } from "./client.js";

const QID_RX = /^voyagerSearchDashClusters\.[a-f0-9]{32}$/;

export interface ResolveQueryIdOptions {
  accounts: AccountStore;
  profileId: string;
  /** The account's stored cookie jar (used to drive the headless capture). */
  cookieJar: unknown;
  /** Authenticated client — the capture probes candidate queryIds with it. */
  apiClient: LinkedInApiClient;
  /** Skip the cache and force a fresh headless capture (stale-hash recovery). */
  force?: boolean;
  /** Injected for tests; defaults to the real headless capture. */
  capture?: (cookieJar: unknown, apiClient: LinkedInApiClient) => Promise<string | null>;
}

export async function resolveSearchClustersQueryId(
  opts: ResolveQueryIdOptions
): Promise<string | null> {
  // 1. env override
  const env = process.env.ALLMAN_SEARCH_CLUSTERS_QID;
  if (env && QID_RX.test(env)) return env;

  // 2. cache (unless forcing a refresh)
  if (!opts.force) {
    const cached = await opts.accounts.readQueryCache(opts.profileId);
    if (cached?.searchClustersQueryId && QID_RX.test(cached.searchClustersQueryId)) {
      return cached.searchClustersQueryId;
    }
  }

  // 3. headless capture + persist
  const capture = opts.capture ?? captureSearchClustersQueryId;
  const captured = await capture(opts.cookieJar, opts.apiClient);
  if (captured && QID_RX.test(captured)) {
    await opts.accounts.writeQueryCache(opts.profileId, {
      searchClustersQueryId: captured,
      capturedAt: new Date().toISOString(),
    });
    return captured;
  }
  return null;
}
