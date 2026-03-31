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

  const accountSlug = await store.accounts.getDefault(options.account);
  const slugs = await store.conversations.list(accountSlug);

  if (slugs.length === 0) {
    info(`No conversations found. Run \`lilac sync --account ${accountSlug}\` to pull history.`);
    return;
  }

  const limit = options.limit ?? 50;
  const records = (
    await Promise.all(
      slugs.map(async (s) => {
        const r = await store.conversations.read(s);
        return r ? { slug: s, record: r } : null;
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

  // Human-readable table
  const lines = records.map((r) => {
    const rec = r!.record;
    const time = rec.lastActivityAt
      ? relativeTime(new Date(rec.lastActivityAt).getTime())
      : "never";
    const unread = rec.unreadCount > 0 ? ` [${rec.unreadCount} unread]` : "";
    return `  ${rec.title.padEnd(30)} ${time.padEnd(12)}${unread}`;
  });

  process.stdout.write(lines.join("\n") + "\n");
}
