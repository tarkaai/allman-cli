/**
 * Shared session helper — builds an authenticated API client for an account.
 *
 * Every command that talks to LinkedIn goes through this.
 * Ensures proxy config is always loaded from config.json.
 */

import type { Store } from "../../store/index.js";
import type { AccountRecord } from "../../store/types.js";
import { buildApiClient, type LinkedInApiClient } from "./client.js";
import { loadCookieJar, serializeCookieJar } from "./cookies.js";

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
export async function loadSession(
  store: Store,
  accountOption?: string
): Promise<SessionResult> {
  const profileId = await store.accounts.getDefault(accountOption);
  const accountRecord = await store.accounts.read(profileId);

  if (!accountRecord || accountRecord.status !== "authenticated") {
    throw new Error("Account not authenticated. Run `lilac login`.");
  }

  if (!accountRecord.urn) {
    throw new Error("Account has no profile URN. Re-run `lilac login`.");
  }

  const accountConfig = await store.accounts.readConfig(profileId);
  const jar = loadCookieJar(accountRecord);

  const apiClient = buildApiClient(
    accountRecord,
    async (updatedJar) => {
      await store.accounts.writeCookies(profileId, {
        cookieJar: serializeCookieJar(updatedJar),
        cookiesUpdatedAt: new Date().toISOString(),
      });
    },
    accountConfig.proxy
  );
  apiClient.updateJar(jar);

  return {
    apiClient,
    profileId,
    accountRecord,
    myProfileUrn: accountRecord.urn,
  };
}
