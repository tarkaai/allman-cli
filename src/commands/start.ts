/**
 * allman start — verify auth, sync from last sync date, then start listening.
 */

import { loadSession } from "../linkedin/api/session.js";
import { resolveStorePath, Store } from "../store/index.js";
import * as output from "../utils/output.js";
import { listenCommand } from "./listen.js";
import { loginCommand } from "./login.js";
import { syncCommand } from "./sync.js";

export interface StartOptions {
  account?: string;
  store?: string;
}

export async function startCommand(options: StartOptions): Promise<void> {
  const storePath = resolveStorePath(options.store);
  const store = new Store({ path: storePath });
  await store.init();

  // Check auth; login if needed
  let authenticated = false;
  try {
    await loadSession(store, options.account);
    authenticated = true;
  } catch {
    authenticated = false;
  }

  if (!authenticated) {
    output.info("Not authenticated — starting login...");
    await loginCommand({ account: options.account, store: options.store });
  }

  // Sync from last sync date (uses lastSyncAt automatically when --since is omitted)
  await syncCommand({ account: options.account, store: options.store });

  // Start listen (runs indefinitely)
  await listenCommand({ account: options.account, store: options.store });
}
