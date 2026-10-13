import { buildApiClient } from "../linkedin/api/client.js";
import { loadCookieJar } from "../linkedin/api/cookies.js";
import { getMyProfile, getProfileUrnBySlug } from "../linkedin/api/endpoints/profiles.js";
import { loadSession } from "../linkedin/api/session.js";
import { runLogin } from "../linkedin/auth/playwright-auth.js";
import { resolveStorePath, Store } from "../store/index.js";
import * as output from "../utils/output.js";
import { fetchOwnProfile } from "./whoami.js";

export interface LoginOptions {
  account?: string;
  store?: string;
  proxy?: string;
  json?: boolean;
  /** Warm + capture the Sales Navigator seat cookie during login. Default true;
   *  set false (via --no-salesnav) to skip the optional SalesNav visit. */
  salesnav?: boolean;
}

export async function loginCommand(options: LoginOptions): Promise<void> {
  const storePath = resolveStorePath(options.store);
  const store = new Store({ path: storePath });
  await store.init();

  // Parse proxy config if provided
  let proxyConfig: { host: string; port: number; username?: string; password?: string } | undefined;
  if (options.proxy) {
    const [host, port, username, password] = options.proxy.split(":");
    if (!host || !port) {
      output.error(`Invalid proxy format. Expected host:port[:username:password]`, 1);
      return;
    }
    proxyConfig = {
      host,
      port: parseInt(port, 10),
      ...(username ? { username } : {}),
      ...(password ? { password } : {}),
    };
  }

  // Check for existing account to inject cookies (re-auth flow)
  // If --account is provided, try resolving it to an existing profile ID
  let existingCookieJar: object | null = null;
  let existingProfileId: string | null = null;

  if (options.account) {
    const resolved = await store.accounts.resolveId(options.account);
    if (resolved) {
      existingProfileId = resolved;
      const existing = await store.accounts.read(resolved);
      existingCookieJar = existing?.cookieJar ?? null;
      if (existingCookieJar) {
        output.info(`Re-authenticating existing account (${options.account})...`);
      }
    }
  }

  output.info("This tool accesses your LinkedIn account on your behalf using your own");
  output.info("credentials. You are responsible for compliance with LinkedIn's Terms of Service.");
  output.info("All data stays on your machine — nothing is sent to Tarka or any third party.");
  output.info("");

  const result = await runLogin({ existingCookieJar, salesnav: options.salesnav !== false });

  if (!result.success) {
    output.error(`Login failed: ${result.error ?? "unknown error"}`, 1);
    return;
  }

  // Extract profile ID from the URN
  let profileId = result.profileUrn?.replace("urn:li:fsd_profile:", "") ?? null;

  // Extract profile slug from the URL (e.g. "jamie-rivera" from linkedin.com/in/jamie-rivera)
  let profileSlug = result.profileUrl?.match(/linkedin\.com\/in\/([^/?]+)/)?.[1] ?? null;

  // The browser flow can miss the profile id (no voyagerIdentityDashProfiles
  // response to sniff, no /in/ redirect). The session is still good, so identify
  // it via the API before giving up — throwing away a captured session (and its
  // Sales Navigator seat) just to retry the browser dance is the worse outcome.
  const tempClient = () => buildTempClient(result);

  // 1. Slug known → look the URN up by slug.
  if (!profileId && profileSlug) {
    output.info(`Fetching profile URN for "${profileSlug}" via API...`);
    try {
      const fetchedUrn = await getProfileUrnBySlug(tempClient(), profileSlug);
      if (fetchedUrn) {
        profileId = fetchedUrn.replace("urn:li:fsd_profile:", "");
      }
    } catch (err) {
      output.debug(`API URN lookup failed: ${String(err)}`);
    }
  }

  // 2. Ask LinkedIn who the session belongs to (voyager/api/me).
  if (!profileId) {
    output.info("Browser didn't expose the profile ID — identifying the session via the API...");
    const me = await getMyProfile(tempClient());
    if (me) {
      profileId = me.urn.replace("urn:li:fsd_profile:", "");
      if (!profileSlug && me.publicIdentifier) profileSlug = me.publicIdentifier;
      output.debug(`Identified session via /me: ${profileId}`);
    }
  }

  // 3. Re-auth of a named existing account → assume it's the same person.
  if (!profileId && existingProfileId) {
    output.warn(
      `Could not confirm the profile ID from LinkedIn; assuming it is the existing account ` +
        `"${options.account}" (${existingProfileId.slice(0, 12)}…). Run \`allman status\` to verify.`
    );
    profileId = existingProfileId;
  }

  if (!profileId) {
    output.error("Could not determine LinkedIn profile ID. Try logging in again.", 1);
    return;
  }

  const profileUrn = `urn:li:fsd_profile:${profileId}`;

  // Save account record
  await store.accounts.write(
    profileId,
    {
      urn: profileUrn,
      profileSlug,
      name: result.name,
      headline: result.headline,
      profileUrl: result.profileUrl,
      imageUrl: result.imageUrl,
      userType: null,
      networkSize: null,
      status: "authenticated",
      cookieJar: result.cookieJar,
      cookiesUpdatedAt: new Date().toISOString(),
      lastSyncAt: null,
    },
    `login: ${profileId.slice(0, 12)}`
  );

  // Save proxy config if provided
  if (proxyConfig) {
    await store.accounts.writeConfig(profileId, { proxy: proxyConfig });
    output.info(`Proxy configured: ${proxyConfig.host}:${proxyConfig.port}`);
  }

  // Create symlinks
  if (profileSlug) {
    await store.accounts.createAlias(profileSlug, profileId);
    output.debug(`Created symlink: ${profileSlug} → ${profileId}`);
  }
  // If --account alias was given and differs from the profile slug, create it too
  if (options.account && options.account !== profileSlug) {
    await store.accounts.createAlias(options.account, profileId);
    output.debug(`Created alias: ${options.account} → ${profileId}`);
  }

  // The browser capture often misses the name/photo; fill them from the API.
  let name = result.name;
  let slug = profileSlug;
  try {
    const session = await loadSession(store, profileId);
    const own = await fetchOwnProfile(session.apiClient, profileId);
    if (own) {
      await store.accounts.update(profileId, own, `account: profile ${profileId.slice(0, 12)}`);
      if (own.profileSlug && own.profileSlug !== profileSlug) {
        await store.accounts.createAlias(own.profileSlug, profileId);
      }
      name = own.name ?? name;
      slug = own.profileSlug ?? slug;
    }
  } catch (err) {
    output.debug(`own profile fetch failed: ${String(err)}`);
  }

  await store.git.flush();

  if (options.json) {
    output.printData({
      profileId,
      profileSlug: slug,
      status: "authenticated",
      name,
      storePath,
    });
  } else {
    output.success(`Logged in as: ${name ?? slug ?? profileId}`);
    output.info(`  Profile ID: ${profileId}`);
    if (slug) output.info(`  Slug:       ${slug}`);
    output.info(`  Store:      ${storePath}`);
  }
}

/**
 * An API client wired to the cookies the browser just captured, for the
 * identity lookups that run before the account record exists.
 */
function buildTempClient(result: Awaited<ReturnType<typeof runLogin>>) {
  const tempRecord = {
    urn: null,
    profileSlug: null,
    name: result.name,
    headline: result.headline,
    profileUrl: result.profileUrl,
    imageUrl: result.imageUrl,
    userType: null as null,
    networkSize: null,
    status: "authenticated" as const,
    cookieJar: result.cookieJar,
    cookiesUpdatedAt: new Date().toISOString(),
    lastSyncAt: null,
  };
  const apiClient = buildApiClient(tempRecord, async () => {}, undefined);
  apiClient.updateJar(loadCookieJar(tempRecord));
  return apiClient;
}
