/**
 * allman search — find contacts/conversations by name.
 */

import { resolveStorePath, Store } from "../store/index.js";
import { search } from "../store/search.js";
import * as output from "../utils/output.js";

export interface SearchOptions {
  account?: string;
  store?: string;
  json?: boolean;
  limit?: number;
}

export async function searchCommand(query: string, options: SearchOptions): Promise<void> {
  const storePath = resolveStorePath(options.store);
  const store = new Store({ path: storePath });
  await store.init();

  const profileId = await store.accounts.getDefault(options.account);
  const conversations = store.forAccount(profileId);

  const results = await search(query, conversations, { limit: options.limit ?? 10 });

  if (options.json) {
    output.printData(results);
    return;
  }

  if (results.length === 0) {
    output.info(`No results for "${query}".`);
    return;
  }

  for (const r of results) {
    const slug = r.slug ?? r.profileId.slice(0, 16);
    process.stdout.write(`  ${String(r.confidence).padStart(3)}%  ${slug.padEnd(30)} ${r.name}\n`);
  }
}
