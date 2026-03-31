import { Store, resolveStorePath } from "../store/index.js";
import { info, success } from "../utils/output.js";

export interface StoreCmdOptions {
  store?: string;
}

export async function storePathCommand(options: StoreCmdOptions): Promise<void> {
  const storePath = resolveStorePath(options.store);
  process.stdout.write(storePath + "\n");
}

export async function storeCommitCommand(
  message: string | undefined,
  options: StoreCmdOptions
): Promise<void> {
  const storePath = resolveStorePath(options.store);
  const store = new Store({ path: storePath });
  await store.init();

  store.git.scheduleCommit(message ?? "chore: manual commit");
  await store.git.flush();
  success("Committed.");
}

export async function storeStatusCommand(options: StoreCmdOptions): Promise<void> {
  const storePath = resolveStorePath(options.store);
  const store = new Store({ path: storePath });
  await store.init();

  const accounts = await store.accounts.list();
  let conversationCount = 0;
  for (const id of accounts) {
    const convs = store.forAccount(id);
    const convIds = await convs.list();
    conversationCount += convIds.length;
  }

  info(`Store: ${storePath}`);
  info(`  Accounts:      ${accounts.length}`);
  info(`  Conversations: ${conversationCount}`);
}
