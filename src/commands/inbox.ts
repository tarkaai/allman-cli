/**
 * lilac inbox — show new messages since last check (watermark-based).
 *
 * Watermark stored in inbox-state.json (gitignored).
 * Covers both SSE-received and synced messages.
 */

import { Store, resolveStorePath } from "../store/index.js";
import { printData, relativeTime, info } from "../utils/output.js";
import { parseSince } from "../utils/time.js";
import { syncCommand } from "./sync.js";
import type { StoredMessage } from "../store/types.js";

export interface InboxOptions {
  account?: string;
  store?: string;
  since?: string;
  noMark?: boolean;
  limit?: number;
  json?: boolean;
}

export async function inboxCommand(options: InboxOptions): Promise<void> {
  const storePath = resolveStorePath(options.store);
  const store = new Store({ path: storePath });
  await store.init();

  const profileId = await store.accounts.getDefault(options.account);
  const conversations = store.forAccount(profileId);
  const now = Date.now();

  // Sync first to pull in latest messages
  info("Syncing...");
  await syncCommand({ account: options.account, store: options.store });

  // Determine watermark
  let sinceMs: number;
  if (options.since) {
    sinceMs = parseSince(options.since);
  } else {
    const inboxState = await store.accounts.readInboxState(profileId);
    // Default to 24 hours ago on first run
    sinceMs = inboxState?.lastSeenAt ?? now - 24 * 60 * 60 * 1000;
  }

  // Scan all conversations for new messages
  const convIds = await conversations.list();
  const results: Array<{ name: string; slug: string | null; messages: StoredMessage[] }> = [];

  for (const convId of convIds) {
    const record = await conversations.read(convId);
    if (!record) continue;
    const newest = record.syncState?.newestMessageAt ?? 0;
    // Per-conversation threshold: use the later of the global watermark or when
    // we last sent/read in this conversation. This means sending to a conversation
    // marks it as read up to that point without affecting other conversations.
    const convSince = Math.max(
      sinceMs,
      record.lastReadAt ? new Date(record.lastReadAt).getTime() : 0
    );
    if (!newest || newest <= convSince) continue;

    const messages = await conversations.readMessages(convId, { since: convSince + 1 });
    const hasInbound = messages.some((m) => !m.isFromMe);
    if (!hasInbound) continue;
    results.push({ name: record.name, slug: record.slug, messages });
  }

  // Sort by newest message timestamp, most recent first
  results.sort((a, b) => {
    const aLast = a.messages.at(-1)!.timestamp;
    const bLast = b.messages.at(-1)!.timestamp;
    return bLast - aLast;
  });

  const limit = options.limit ?? results.length;
  const sliced = results.slice(0, limit);

  if (options.json) {
    printData(sliced);
  } else if (sliced.length === 0) {
    process.stdout.write(`No new messages since ${new Date(sinceMs).toLocaleString()}\n`);
  } else {
    for (const { name, messages } of sliced) {
      process.stdout.write(`\n${name}\n`);
      for (const m of messages) {
        const dir = m.isFromMe ? "→" : "←";
        const sender = m.isFromMe ? "You" : (m.fromName || name);
        const time = relativeTime(m.timestamp);
        const body = m.body.length > 120 ? m.body.slice(0, 120) + "…" : m.body;
        process.stdout.write(`  ${dir} ${sender.padEnd(20)} ${time.padEnd(12)} ${body}\n`);
      }
    }
    process.stdout.write("\n");
  }

  // Advance watermark unless --no-mark
  if (!options.noMark) {
    await store.accounts.writeInboxState(profileId, { lastSeenAt: now });
  }
}

