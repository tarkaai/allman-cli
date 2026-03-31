import { Store, resolveStorePath } from "../store/index.js";
import { success, error, info } from "../utils/output.js";

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

  await store.accounts.update(profileId, {
    status: "unauthenticated",
    cookieJar: null,
    cookiesUpdatedAt: null,
  });

  await store.git.flush();
  success(`Logged out: ${existing.profileSlug ?? profileId}`);
  info("Cookies cleared. Run `lilac login` to re-authenticate.");
}
