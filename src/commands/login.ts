import { Store, resolveStorePath } from "../store/index.js";
import { runLogin } from "../linkedin/auth/playwright-auth.js";
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

  // Determine account slug — required for login
  const accountSlug = options.account ?? process.env["LILAC_ACCOUNT"];
  if (!accountSlug) {
    output.error(
      'Account name required. Use --account <name>, e.g.: lilac login --account work',
      1
    );
    return;
  }

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

  // Load existing account if any (for re-auth cookie injection)
  const existingRecord = await store.accounts.read(accountSlug);
  const existingCookieJar = existingRecord?.cookieJar ?? null;

  if (existingRecord?.status === "authenticated" && existingCookieJar) {
    output.info(`Re-authenticating account "${accountSlug}" (existing cookies will be tried first)`);
  } else {
    output.info(`Logging in to LinkedIn as "${accountSlug}"...`);
  }

  // Save proxy config if provided
  if (proxyConfig) {
    await store.accounts.writeConfig(accountSlug, { proxy: proxyConfig });
    output.info(`Proxy configured: ${proxyConfig.host}:${proxyConfig.port}`);
  }

  // Run the interactive browser login
  const result = await runLogin({ existingCookieJar });

  if (!result.success) {
    output.error(`Login failed: ${result.error ?? "unknown error"}`, 1);
    return;
  }

  // Save to store
  await store.accounts.write(
    accountSlug,
    {
      urn: result.profileUrn,
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
    `login: ${accountSlug}`
  );

  await store.git.flush();

  if (options.json) {
    output.printData({
      account: accountSlug,
      status: "authenticated",
      name: result.name,
      profileUrn: result.profileUrn,
      storePath,
    });
  } else {
    output.success(`Logged in as: ${result.name ?? "unknown"}`);
    output.info(`  Account: ${accountSlug}`);
    output.info(`  Store:   ${storePath}`);
    if (result.profileUrn) output.info(`  URN:     ${result.profileUrn}`);
  }
}
