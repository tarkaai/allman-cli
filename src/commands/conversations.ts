import { Store, resolveStorePath } from "../store/index.js";
import { printData, relativeTime, info } from "../utils/output.js";

export interface ConversationsOptions {
  account?: string;
  store?: string;
  json?: boolean;
  limit?: number;
}

export async function conversationsCommand(options: ConversationsOptions): Promise<void> {
  const storePath = resolveStorePath(options.store);
  const store = new Store({ path: storePath });
  await store.init();

  const profileId = await store.accounts.getDefault(options.account);
  const conversations = store.forAccount(profileId);
  const bareIds = await conversations.list();

  if (bareIds.length === 0) {
    info(`No conversations found. Run \`lilac sync\` to pull history.`);
    return;
  }

  const limit = options.limit ?? 50;

  // Read all records, sort by lastActivityAt, then slice
  const records = (
    await Promise.all(
      bareIds.map(async (id) => {
        const r = await conversations.read(id);
        return r ? { bareId: id, record: r } : null;
      })
    )
  )
    .filter(Boolean)
    .sort((a, b) => {
      const at = a!.record.lastActivityAt ?? "";
      const bt = b!.record.lastActivityAt ?? "";
      return bt.localeCompare(at);
    })
    .slice(0, limit);

  if (options.json) {
    printData(records.map((r) => r!.record));
    return;
  }

  const lines = records.map((r) => {
    const rec = r!.record;
    const time = rec.lastActivityAt
      ? relativeTime(new Date(rec.lastActivityAt).getTime())
      : "never";
    const unread = rec.unreadCount > 0 ? ` [${rec.unreadCount} unread]` : "";
    return `  ${rec.name.padEnd(30)} ${time.padEnd(12)}${unread}`;
  });

  process.stdout.write(lines.join("\n") + "\n");
}
