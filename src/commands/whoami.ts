/**
 * allman whoami — the signed-in member's own profile (name, headline, slug,
 * photo), cached in AUTH.json.
 *
 * Usage:
 *   allman whoami                 cached, fetched once when AUTH.json has no name
 *   allman whoami --refresh       re-fetch from LinkedIn and update AUTH.json
 *   allman whoami --json
 *
 * `allman login` captures the browser's view of the profile, which is often
 * incomplete (null name / photo). Front-ends (TUI, Mac app) call this so the
 * account header can show who is signed in.
 */

import { fetchProfileDetail } from "../linkedin/api/endpoints/profile-detail.js";
import { loadSession } from "../linkedin/api/session.js";
import { resolveStorePath, Store } from "../store/index.js";
import type { AccountAuth } from "../store/types.js";
import * as output from "../utils/output.js";

export interface WhoamiOptions {
  account?: string;
  store?: string;
  refresh?: boolean;
  json?: boolean;
}

export interface WhoamiResult {
  profileId: string;
  urn: string;
  slug: string | null;
  name: string | null;
  headline: string | null;
  profileUrl: string | null;
  imageUrl: string | null;
  status: AccountAuth["status"];
  /** True when this call fetched from LinkedIn (vs. served the cached AUTH.json). */
  refreshed: boolean;
}

/** Fields `whoami` refreshes on AUTH.json. */
export type OwnProfileFields = Pick<
  AccountAuth,
  "profileSlug" | "name" | "headline" | "profileUrl" | "imageUrl"
>;

/** Fetch the signed-in member's profile. Null when LinkedIn returns nothing. */
export async function fetchOwnProfile(
  client: Parameters<typeof fetchProfileDetail>[0],
  profileId: string
): Promise<OwnProfileFields | null> {
  const detail = await fetchProfileDetail(client, profileId);
  if (!detail) return null;
  const name = [detail.firstName, detail.lastName].filter(Boolean).join(" ").trim() || null;
  const slug = detail.publicIdentifier ?? null;
  return {
    profileSlug: slug,
    name,
    headline: detail.headline ?? null,
    profileUrl: slug ? `https://www.linkedin.com/in/${slug}/` : null,
    imageUrl: detail.profilePictureUrl ?? null,
  };
}

export async function whoamiCommand(options: WhoamiOptions): Promise<void> {
  const storePath = resolveStorePath(options.store);
  const store = new Store({ path: storePath });
  await store.init();

  let session: Awaited<ReturnType<typeof loadSession>>;
  try {
    session = await loadSession(store, options.account);
  } catch (err) {
    output.error(String((err as Error).message), 1);
    return;
  }
  const { apiClient, profileId, myProfileUrn } = session;
  let auth = await store.accounts.read(profileId);
  if (!auth) {
    output.error(`Account "${profileId}" not found.`, 1);
    return;
  }

  let refreshed = false;
  if (options.refresh || !auth.name) {
    const fresh = await fetchOwnProfile(apiClient, profileId);
    if (!fresh) {
      output.error("LinkedIn returned no profile for the signed-in member.", 1);
      return;
    }
    auth = await store.accounts.update(
      profileId,
      fresh,
      `account: profile ${profileId.slice(0, 12)}`
    );
    if (fresh.profileSlug) {
      // The friendly `{slug} -> {profileId}` alias is what `--account <slug>` resolves.
      await store.accounts.createAlias(fresh.profileSlug, profileId);
    }
    await store.git.flush();
    refreshed = true;
  }

  const result: WhoamiResult = {
    profileId,
    urn: auth.urn ?? myProfileUrn,
    slug: auth.profileSlug ?? null,
    name: auth.name ?? null,
    headline: auth.headline ?? null,
    profileUrl: auth.profileUrl ?? null,
    imageUrl: auth.imageUrl ?? null,
    status: auth.status,
    refreshed,
  };

  if (options.json) {
    output.printData(result);
    return;
  }
  process.stdout.write(`${result.name ?? "(no name)"}${result.slug ? ` (@${result.slug})` : ""}\n`);
  if (result.headline) process.stdout.write(`  ${result.headline}\n`);
  process.stdout.write(`  ID:     ${result.profileId}\n`);
  process.stdout.write(`  Status: ${result.status}${refreshed ? " · refreshed" : ""}\n`);
}
