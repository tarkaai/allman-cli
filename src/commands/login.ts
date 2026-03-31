import { Store, resolveStorePath } from "../store/index.js";
import { runLogin } from "../linkedin/auth/playwright-auth.js";
import { buildApiClient } from "../linkedin/api/client.js";
import { loadCookieJar } from "../linkedin/api/cookies.js";
import { getProfileUrnBySlug } from "../linkedin/api/endpoints/profiles.js";
import * as output from "../utils/output.js";

export interface LoginOptions {
  account?: string;
  store?: string;
  proxy?: string;
  json?: boolean;
}

export async function loginCommand(options: LoginOptions): Promise<void> {
  const storePath = resolveStorePath(options.store);
  const store = new Store({ path: storePath });
  await store.init();

  // Parse proxy config if provided
  let proxyConfig: { host: string; port: number; username?: string; password?: string } | undefined;
  if (options.proxy) {
    const parts = options.proxy.split(":");
    if (parts.length < 2) {
      output.error(`Invalid proxy format. Expected host:port[:username:password]`, 1);
      return;
    }
    proxyConfig = {
      host: parts[0]!,
      port: parseInt(parts[1]!, 10),
      ...(parts[2] ? { username: parts[2] } : {}),
      ...(parts[3] ? { password: parts[3] } : {}),
    };
  }

  // Check for existing account to inject cookies (re-auth flow)
  // If --account is provided, try resolving it to an existing profile ID
  let existingCookieJar: object | null = null;
  let _existingProfileId: string | null = null;

  if (options.account) {
    const resolved = await store.accounts.resolveId(options.account);
    if (resolved) {
      const existing = await store.accounts.read(resolved);
      existingCookieJar = existing?.cookieJar ?? null;
      _existingProfileId = resolved;
      if (existingCookieJar) {
        output.info(`Re-authenticating existing account (${options.account})...`);
      }
    }
  }

  output.info("Opening LinkedIn in browser — please complete login in the browser window.");
  output.info(`Waiting up to 5 minutes...`);

  const result = await runLogin({ existingCookieJar });

  if (!result.success) {
    output.error(`Login failed: ${result.error ?? "unknown error"}`, 1);
    return;
  }

  // Extract profile ID from the URN
  let profileId = result.profileUrn?.replace("urn:li:fsd_profile:", "") ?? null;

  // Extract profile slug from the URL (e.g. "dan-moore" from linkedin.com/in/dan-moore)
  const profileSlug =
    result.profileUrl?.match(/linkedin\.com\/in\/([^/?]+)/)?.[1] ?? null;

  // If we didn't get a URN from the browser, try the API
  if (!profileId && profileSlug) {
    output.info(`Fetching profile URN for "${profileSlug}" via API...`);
    try {
      // Build a temporary client using the cookies we just got
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
      const jar = loadCookieJar(tempRecord);
      const apiClient = buildApiClient(tempRecord, async () => {}, undefined);
      apiClient.updateJar(jar);
      const fetchedUrn = await getProfileUrnBySlug(apiClient, profileSlug);
      if (fetchedUrn) {
        profileId = fetchedUrn.replace("urn:li:fsd_profile:", "");
      }
    } catch (err) {
      output.debug(`API URN lookup failed: ${String(err)}`);
    }
  }

  if (!profileId) {
    output.error("Could not determine LinkedIn profile ID. Try logging in again.", 1);
    return;
  }

  const profileUrn = `urn:li:fsd_profile:${profileId}`;

  // Save account record
  await store.accounts.write(profileId, {
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
  }, `login: ${profileId.slice(0, 12)}`);

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

  await store.git.flush();

  if (options.json) {
    output.printData({
      profileId,
      profileSlug,
      status: "authenticated",
      name: result.name,
      storePath,
    });
  } else {
    output.success(`Logged in as: ${result.name ?? profileSlug ?? profileId}`);
    output.info(`  Profile ID: ${profileId}`);
    if (profileSlug) output.info(`  Slug:       ${profileSlug}`);
    output.info(`  Store:      ${storePath}`);
  }
}
