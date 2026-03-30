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

  const accountSlug = await store.accounts.getDefault(options.account);
  const existing = await store.accounts.read(accountSlug);

  if (!existing) {
    error(`Account "${accountSlug}" not found.`, 1);
    return;
  }

  await store.accounts.update(
    accountSlug,
    {
      status: "unauthenticated",
      cookieJar: null,
      cookiesUpdatedAt: null,
    },
    `logout: ${accountSlug}`
  );

  await store.git.flush();
  success(`Logged out: ${accountSlug}`);
  info("Cookies cleared. Run `lilac login` to re-authenticate.");
}
