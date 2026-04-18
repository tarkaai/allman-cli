import { resolveStorePath, Store } from "../store/index.js";
import { error, info, success } from "../utils/output.js";

export interface LogoutOptions {
  account?: string;
  store?: string;
}

export async function logoutCommand(options: LogoutOptions): Promise<void> {
  const storePath = resolveStorePath(options.store);
  const store = new Store({ path: storePath });
  await store.init();

  const profileId = await store.accounts.getDefault(options.account);
  const existing = await store.accounts.read(profileId);

  if (!existing) {
    error(`Account "${profileId}" not found.`, 1);
    return;
  }

  await store.accounts.writeCookies(profileId, { cookieJar: null, cookiesUpdatedAt: null });
  await store.accounts.writeAuth(profileId, { ...existing, status: "unauthenticated" });

  await store.git.flush();
  success(`Logged out: ${existing.profileSlug ?? profileId}`);
  info("Cookies cleared. Run `allman login` to re-authenticate.");
}
