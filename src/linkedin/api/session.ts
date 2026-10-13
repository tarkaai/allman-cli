/**
 * Shared session helper — builds an authenticated API client for an account.
 *
 * Every command that talks to LinkedIn goes through this.
 * Ensures proxy config is always loaded from config.json.
 */

import type { CookieJar } from "tough-cookie";
import type { Store } from "../../store/index.js";
import type { AccountRecord } from "../../store/types.js";
import { buildRateLimiter } from "../../utils/rate-limiter.js";
import { buildApiClient, type LinkedInApiClient } from "./client.js";
import { loadCookieJar, mergeCookies, serializeCookieJar } from "./cookies.js";

export interface SessionResult {
  apiClient: LinkedInApiClient;
  profileId: string;
  accountRecord: AccountRecord;
  myProfileUrn: string;
}

/**
 * Load account, cookies, proxy config, and build an authenticated API client.
 * Returns everything a command needs to talk to LinkedIn.
 *
 * Throws if account is not authenticated or has no URN.
 */
export async function loadSession(store: Store, accountOption?: string): Promise<SessionResult> {
  const profileId = await store.accounts.getDefault(accountOption);
  const accountRecord = await store.accounts.read(profileId);

  if (!accountRecord || accountRecord.status !== "authenticated") {
    throw new Error("Account not authenticated. Run `allman login`.");
  }

  if (!accountRecord.urn) {
    throw new Error("Account has no profile URN. Re-run `allman login`.");
  }

  const accountConfig = await store.accounts.readConfig(profileId);
  const rateState = await store.accounts.readRateState(profileId);
  const jar = loadCookieJar(accountRecord);

  const rateLimiter = buildRateLimiter({
    minIntervalMs: accountConfig.rateLimit?.minMessageIntervalMs,
    initialLastSendAt: rateState?.lastMessageSentAt,
  });

  const apiClient = buildApiClient(
    accountRecord,
    async (_updatedJar, setCookieHeaders) => {
      // Merge into the jar on disk rather than overwriting it with this
      // process's snapshot — see persistSetCookies. Then adopt the merged jar
      // so a long-running process (listen) picks up cookies written by others,
      // e.g. a fresh `allman login`.
      const merged = await persistSetCookies(store, profileId, setCookieHeaders);
      if (merged) apiClient.updateJar(merged);
    },
    accountConfig.proxy,
    rateLimiter,
    async (lastMessageSentAt) => {
      await store.accounts.writeRateState(profileId, { lastMessageSentAt });
    }
  );
  apiClient.updateJar(jar);

  return {
    apiClient,
    profileId,
    accountRecord,
    myProfileUrn: accountRecord.urn,
  };
}

/**
 * Persist freshly received Set-Cookie headers by merging them into the jar
 * currently ON DISK, not into the caller's in-memory snapshot.
 *
 * Why: every allman process loads COOKIES.json once at startup. If each one
 * wrote its whole in-memory jar back after every response, the last writer
 * would win and a long-running `allman listen` would keep clobbering cookies
 * written by other processes — including the Sales Navigator seat captured by
 * a fresh `allman login`. Re-reading the file and applying only the cookies
 * this response actually set keeps every process's contributions.
 *
 * Returns the merged jar, or null when the account no longer has a jar on
 * disk (logged out meanwhile). Nothing is written in that case, so a stale
 * process cannot resurrect a session the user deliberately cleared.
 */
export async function persistSetCookies(
  store: Store,
  profileId: string,
  setCookieHeaders: string[]
): Promise<CookieJar | null> {
  const current = await store.accounts.readCookies(profileId);
  if (!current?.cookieJar) return null;
  const jar = loadCookieJar({ cookieJar: current.cookieJar });
  await mergeCookies(jar, setCookieHeaders);
  await store.accounts.writeCookies(profileId, {
    cookieJar: serializeCookieJar(jar),
    cookiesUpdatedAt: new Date().toISOString(),
  });
  return jar;
}
