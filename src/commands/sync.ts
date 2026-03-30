/**
 * lilac sync — pull conversation history into the local file store.
 *
 * Algorithm:
 *   1. Fetch conversation list (paginated, stops at last sync time or --since date)
 *   2. For each conversation: fetch last 100 messages using anchor timestamp pagination
 *   3. Update syncState in RECORD.json after each conversation
 *   4. Git commit on completion
 *
 * --since accepts: 3mo, 6mo, 1y, or YYYY-MM-DD
 */

import { Store, resolveStorePath } from "../store/index.js";
import { buildApiClient } from "../linkedin/api/client.js";
import { loadCookieJar, serializeCookieJar } from "../linkedin/api/cookies.js";
import { listConversations } from "../linkedin/api/endpoints/conversations.js";
import { fetchMessages } from "../linkedin/api/endpoints/messages.js";
import { slugFromUrl, conversationSlug } from "../utils/slug.js";
import * as output from "../utils/output.js";
import type { ConversationRecord, StoredMessage } from "../store/types.js";

const MESSAGES_PER_CONVERSATION = 100;
const MESSAGES_PER_PAGE = 20;

export interface SyncOptions {
  account?: string;
  store?: string;
  since?: string;
  json?: boolean;
}

export async function syncCommand(options: SyncOptions): Promise<void> {
  const storePath = resolveStorePath(options.store);
  const store = new Store({ path: storePath });
  await store.init();

  const accountSlug = await store.accounts.getDefault(options.account);
  const accountRecord = await store.accounts.read(accountSlug);

  if (!accountRecord || accountRecord.status !== "authenticated") {
    output.error(
      `Account "${accountSlug}" is not authenticated. Run \`lilac login --account ${accountSlug}\``,
      1
    );
    return;
  }

  if (!accountRecord.urn) {
    output.error(`Account "${accountSlug}" has no profile URN. Re-run \`lilac login\`.`, 1);
    return;
  }

  const sinceMs = parseSince(options.since);
  const sinceDate = new Date(sinceMs);

  output.info(
    `Syncing account "${accountSlug}" (since ${sinceDate.toISOString().slice(0, 10)})...`
  );

  const accountConfig = await store.accounts.readConfig(accountSlug);
  const jar = loadCookieJar(accountRecord);

  const apiClient = buildApiClient(
    accountRecord,
    async (updatedJar) => {
      await store.accounts.update(accountSlug, {
        cookieJar: serializeCookieJar(updatedJar),
        cookiesUpdatedAt: new Date().toISOString(),
      });
    },
    accountConfig.proxy
  );
  apiClient.updateJar(jar);

  const myProfileUrn = accountRecord.urn;
  let totalConversations = 0;
  let totalMessages = 0;
  let nextCursor: string | null | undefined = undefined;
  let lastUpdatedBefore = Date.now();

  // Phase 1: Fetch all conversations
  output.info("Fetching conversation list...");

  while (true) {
    const { conversations, nextCursor: cursor } = await listConversations(
      apiClient,
      myProfileUrn,
      lastUpdatedBefore,
      nextCursor ?? undefined
    );

    if (conversations.length === 0) break;

    for (const conv of conversations) {
      if (conv.lastActivityAt && conv.lastActivityAt < sinceMs) {
        // All subsequent conversations are older than --since, stop
        nextCursor = null;
        break;
      }

      // Build the slug for this conversation
      const slug = buildConversationSlug(conv, accountRecord.urn!);
      const participants = conv.participants.map((p) => ({
        slug: p.profileUrl ? slugFromUrl(p.profileUrl) : sanitizeUrnToSlug(p.entityUrn),
        urn: p.entityUrn,
        name: p.name ?? "",
      }));

      const record: ConversationRecord = {
        urn: conv.urn,
        backendUrn: conv.backendUrn,
        title: conv.title ?? (participants.find((p) => p.urn !== myProfileUrn)?.name ?? "Unknown"),
        isGroup: conv.isGroup,
        account: accountSlug,
        participants,
        unreadCount: conv.unreadCount,
        lastActivityAt: conv.lastActivityAt ? new Date(conv.lastActivityAt).toISOString() : null,
        createdAt: null,
        syncState: {
          oldestMessageAt: null,
          newestMessageAt: null,
          lastSyncAt: null,
          totalSynced: 0,
          fullyBackfilled: false,
        },
      };

      await store.conversations.upsert(slug, record);
      totalConversations++;

      // Phase 2: Fetch messages for this conversation
      const messagesWritten = await syncConversationMessages(
        apiClient,
        store,
        slug,
        conv.backendUrn || conv.urn,
        myProfileUrn,
        sinceMs
      );
      totalMessages += messagesWritten;

      output.debug(`  ${slug}: ${messagesWritten} messages`);
    }

    if (!cursor || nextCursor === null) break;
    nextCursor = cursor;

    // Update pagination anchor to oldest conversation's last activity
    const oldest = conversations[conversations.length - 1];
    if (oldest?.lastActivityAt) {
      lastUpdatedBefore = oldest.lastActivityAt;
    } else {
      break;
    }
  }

  // Update account lastSyncAt
  await store.accounts.update(accountSlug, { lastSyncAt: new Date().toISOString() });
  await store.git.flush();

  if (options.json) {
    output.printData({
      account: accountSlug,
      conversationsSynced: totalConversations,
      messagesSynced: totalMessages,
      since: sinceDate.toISOString(),
    });
  } else {
    output.success(
      `Sync complete: ${totalConversations} conversations, ${totalMessages} messages`
    );
  }
}

async function syncConversationMessages(
  apiClient: ReturnType<typeof buildApiClient>,
  store: Store,
  slug: string,
  conversationUrn: string,
  myProfileUrn: string,
  sinceMs: number
): Promise<number> {
  const existing = await store.conversations.read(slug);
  const knownNewestAt = existing?.syncState.newestMessageAt;

  let anchorTimestamp = Date.now();
  let fetched = 0;
  let oldestFetchedAt: number | null = null;
  let newestFetchedAt: number | null = null;
  const allMessages: StoredMessage[] = [];

  while (fetched < MESSAGES_PER_CONVERSATION) {
    let result: { messages: ReturnType<typeof parseToStoredMessage>[]; hasMore: boolean };
    try {
      const raw = await fetchMessages(
        apiClient,
        conversationUrn,
        myProfileUrn,
        anchorTimestamp,
        MESSAGES_PER_PAGE
      );
      result = {
        messages: raw.messages.map((m) => parseToStoredMessage(m, myProfileUrn)),
        hasMore: raw.hasMore,
      };
    } catch (err: unknown) {
      output.debug(`Failed to fetch messages for ${slug}: ${String(err)}`);
      break;
    }

    if (result.messages.length === 0) break;

    for (const msg of result.messages) {
      if (msg.timestamp < sinceMs) {
        // Gone past our --since cutoff
        break;
      }
      if (knownNewestAt && msg.timestamp <= knownNewestAt) {
        // Already have this message
        break;
      }
      allMessages.push(msg);
      fetched++;

      if (oldestFetchedAt === null || msg.timestamp < oldestFetchedAt) {
        oldestFetchedAt = msg.timestamp;
      }
      if (newestFetchedAt === null || msg.timestamp > newestFetchedAt) {
        newestFetchedAt = msg.timestamp;
      }
    }

    if (!result.hasMore || fetched >= MESSAGES_PER_CONVERSATION) break;

    // Move anchor to oldest message fetched so far
    anchorTimestamp = oldestFetchedAt ?? anchorTimestamp - 1;
  }

  if (allMessages.length > 0) {
    await store.conversations.appendMessages(slug, allMessages);
    await store.conversations.updateSyncState(slug, {
      oldestMessageAt: Math.min(
        oldestFetchedAt ?? Infinity,
        existing?.syncState.oldestMessageAt ?? Infinity
      ),
      newestMessageAt: Math.max(
        newestFetchedAt ?? 0,
        existing?.syncState.newestMessageAt ?? 0
      ),
      lastSyncAt: new Date().toISOString(),
      totalSynced: (existing?.syncState.totalSynced ?? 0) + allMessages.length,
    });
  }

  return allMessages.length;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseSince(since: string | undefined): number {
  if (!since) {
    // Default: 3 months ago
    return Date.now() - 90 * 24 * 60 * 60 * 1000;
  }
  const match = since.match(/^(\d+)(mo|y|d)$/);
  if (match && match[1] && match[2]) {
    const n = parseInt(match[1], 10);
    const unit = match[2];
    const ms =
      unit === "mo"
        ? n * 30 * 24 * 60 * 60 * 1000
        : unit === "y"
          ? n * 365 * 24 * 60 * 60 * 1000
          : n * 24 * 60 * 60 * 1000;
    return Date.now() - ms;
  }
  // Try parsing as a date string
  const d = new Date(since);
  if (!isNaN(d.getTime())) return d.getTime();
  throw new Error(`Invalid --since value: "${since}". Use 3mo, 6mo, 1y, or YYYY-MM-DD.`);
}

function buildConversationSlug(
  conv: { title: string | null; isGroup: boolean; participants: Array<{ name: string | null; entityUrn: string; profileUrl: string | null }> },
  myProfileUrn: string
): string {
  if (conv.title) return conversationSlug(conv.title, conv.isGroup);

  // For 1:1 chats without a title, use the other participant's name
  const other = conv.participants.find((p) => p.entityUrn !== myProfileUrn);
  const name = other?.name ?? other?.profileUrl ?? "unknown";
  return conversationSlug(name, conv.isGroup);
}

function sanitizeUrnToSlug(urn: string): string {
  const match = urn.match(/fsd_profile:([^,)]+)/);
  return match ? `profile-${(match[1] ?? "").slice(-8)}` : "unknown";
}

function parseToStoredMessage(
  m: { urn: string; deliveredAt: number; fromUrn: string; fromName: string | null; body: string; originToken: string | null; reactions: Array<{ emoji: string; count: number; hasUserReacted: boolean }>; attachments: Array<{ type: string; url?: string; name?: string; mimeType?: string; raw?: unknown }> },
  myProfileUrn: string
): StoredMessage {
  return {
    urn: m.urn,
    timestamp: m.deliveredAt,
    fromUrn: m.fromUrn,
    fromName: m.fromName ?? "",
    fromSlug: sanitizeUrnToSlug(m.fromUrn),
    isFromMe: m.fromUrn === myProfileUrn || m.fromUrn.includes(myProfileUrn.replace("urn:li:fsd_profile:", "")),
    body: m.body,
    reactions: m.reactions,
    attachments: m.attachments.map((a) => ({
      type: a.type as StoredMessage["attachments"][number]["type"],
      url: a.url,
      name: a.name,
      mimeType: a.mimeType,
      raw: a.raw,
    })),
    originToken: m.originToken,
  };
}
