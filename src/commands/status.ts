import { Store, resolveStorePath } from "../store/index.js";
import { loadCookieJar, isAuthenticated } from "../linkedin/api/cookies.js";
import { printData, info } from "../utils/output.js";

export interface StatusOptions {
  account?: string;
  store?: string;
  json?: boolean;
}

export async function statusCommand(options: StatusOptions): Promise<void> {
  const storePath = resolveStorePath(options.store);
  const store = new Store({ path: storePath });
  await store.init();

  const slugs = options.account
    ? [options.account]
    : await store.accounts.list();

  if (slugs.length === 0) {
    info("No accounts found. Run `lilac login --account <name>` to get started.");
    return;
  }

  const statuses = await Promise.all(
    slugs.map(async (slug) => {
      const record = await store.accounts.read(slug);
      if (!record) return null;
      const jar = loadCookieJar(record);
      const hasValidCookies = await isAuthenticated(jar);
      const config = await store.accounts.readConfig(slug);
      return {
        account: slug,
        name: record.name,
        status: record.status,
        cookiesValid: hasValidCookies,
        cookiesUpdatedAt: record.cookiesUpdatedAt,
        lastSyncAt: record.lastSyncAt,
        profileUrn: record.urn,
        proxy: config.proxy ? `${config.proxy.host}:${config.proxy.port}` : null,
        storePath,
      };
    })
  );

  const results = statuses.filter(Boolean);

  if (options.json) {
    printData(results);
    return;
  }

  for (const s of results) {
    if (!s) continue;
    const cookieStatus = s.cookiesValid ? "✓ valid" : "✗ expired";
    process.stdout.write(`Account: ${s.account}\n`);
    process.stdout.write(`  Name:    ${s.name ?? "unknown"}\n`);
    process.stdout.write(`  Status:  ${s.status}\n`);
    process.stdout.write(`  Cookies: ${cookieStatus}\n`);
    if (s.lastSyncAt) process.stdout.write(`  Synced:  ${new Date(s.lastSyncAt).toLocaleString()}\n`);
    if (s.proxy) process.stdout.write(`  Proxy:   ${s.proxy}\n`);
    process.stdout.write(`  Store:   ${s.storePath}\n\n`);
  }
}
