import type { ConversationStore } from "../store/conversations.js";
import { resolveStorePath, Store } from "../store/index.js";
import type { StoredMessage } from "../store/types.js";
import { debug, error, info, printData, relativeTime } from "../utils/output.js";
import { slugFromUrl } from "../utils/slug.js";
import { extractBareConvId, isUrn } from "../utils/urn.js";
import { syncCommand } from "./sync.js";

const SYNC_STALE_MS = 60_000; // 1 minute

export interface MessagesOptions {
  account?: string;
  store?: string;
  json?: boolean;
  limit?: number;
  since?: string;
  noSync?: boolean;
}

export async function messagesCommand(target: string, options: MessagesOptions): Promise<void> {
  const storePath = resolveStorePath(options.store);
  const store = new Store({ path: storePath });
  await store.init();

  const profileId = await store.accounts.getDefault(options.account);
  const conversations = store.forAccount(profileId);

  let bareConvId = await resolveTarget(target, conversations);

  // Auto-sync if conversation not found locally
  if (!bareConvId && !options.noSync) {
    info(`Conversation "${target}" not found locally. Syncing...`);
    await syncCommand({ account: options.account, store: options.store, since: options.since });
    bareConvId = await resolveTarget(target, conversations);
  }

  if (!bareConvId) {
    error(
      `Conversation "${target}" not found. ${options.noSync ? "Run `allman sync` to pull history." : "Could not find after sync."}`,
      1
    );
    return;
  }

  const record = await conversations.read(bareConvId);
  if (!record) {
    error(`Conversation record not found for "${bareConvId}".`, 1);
    return;
  }

  // Auto-sync if stale (last sync > 1 minute ago)
  if (!options.noSync) {
    const lastSyncAt = record.syncState.lastSyncAt
      ? new Date(record.syncState.lastSyncAt).getTime()
      : 0;
    const stale = Date.now() - lastSyncAt > SYNC_STALE_MS;
    if (stale) {
      debug(
        `Last sync ${lastSyncAt ? new Date(lastSyncAt).toISOString() : "never"}, refreshing...`
      );
      info(`Syncing ${record.name ?? target}...`);
      await syncCommand({
        conversation: bareConvId,
        account: options.account,
        store: options.store,
        since: options.since,
      });
    }
  }

  const sinceMs = options.since ? new Date(options.since).getTime() : undefined;
  const messages = await conversations.readMessages(bareConvId, {
    since: sinceMs,
    limit: options.limit ?? 50,
  });

  if (messages.length === 0) {
    info("No messages found.");
    return;
  }

  if (options.json) {
    printData(messages);
    return;
  }

  printMessages(record.name, messages);
}

async function resolveTarget(
  target: string,
  conversations: ConversationStore
): Promise<string | null> {
  if (isUrn(target)) {
    const bare = extractBareConvId(target);
    if (await conversations.exists(bare)) return bare;
    const found = await conversations.findByUrn(target);
    return found?.convId ?? null;
  }
  let slug: string;
  try {
    slug = slugFromUrl(target);
  } catch {
    slug = target;
  }
  return conversations.resolve(slug);
}

function printMessages(name: string, messages: StoredMessage[]): void {
  const lines = messages.map((m) => {
    const time = relativeTime(m.timestamp);
    const sender = m.isFromMe ? "You" : m.fromName || "Unknown";
    const prefix = m.isFromMe ? "→" : "←";
    const attachments =
      m.attachments.length > 0 ? ` [${m.attachments.map((a) => a.type).join(", ")}]` : "";
    const reactions =
      m.reactions.length > 0 ? ` ${m.reactions.map((r) => `${r.emoji}×${r.count}`).join(" ")}` : "";
    return `${prefix} ${sender.padEnd(20)} ${time.padEnd(12)} ${m.body}${attachments}${reactions}`;
  });

  process.stdout.write(`Conversation: ${name}\n\n`);
  process.stdout.write(`${lines.join("\n")}\n`);
}
