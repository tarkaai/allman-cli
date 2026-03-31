/**
 * lilac sync — pull conversation history into the local file store.
 */

import { Store, resolveStorePath } from "../store/index.js";
import { buildApiClient } from "../linkedin/api/client.js";
import { loadCookieJar, serializeCookieJar } from "../linkedin/api/cookies.js";
import { listConversations } from "../linkedin/api/endpoints/conversations.js";
import { fetchMessages } from "../linkedin/api/endpoints/messages.js";
import { slugFromLinkedInUrl } from "../utils/slug.js";
import * as output from "../utils/output.js";
import type { ConversationRecord, StoredMessage } from "../store/types.js";
import { extractBareConvId } from "../utils/urn.js";

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

  const profileId = await store.accounts.getDefault(options.account);
  const accountRecord = await store.accounts.read(profileId);

  if (!accountRecord || accountRecord.status !== "authenticated") {
    output.error(`Account not authenticated. Run \`lilac login\``, 1);
    return;
  }

  if (!accountRecord.urn) {
    output.error(`Account has no profile URN. Re-run \`lilac login\`.`, 1);
    return;
  }

  const sinceMs = parseSince(options.since);
  const sinceDate = new Date(sinceMs);
  const { conversations, contacts } = store.forAccount(profileId);

  output.info(`Syncing ${accountRecord.name ?? profileId} (since ${sinceDate.toISOString().slice(0, 10)})...`);

  const accountConfig = await store.accounts.readConfig(profileId);
  const jar = loadCookieJar(accountRecord);

  const apiClient = buildApiClient(
    accountRecord,
    async (updatedJar) => {
      await store.accounts.update(profileId, {
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

  output.info("Fetching conversation list...");

  while (true) {
    const { conversations: convPage, nextCursor: cursor } = await listConversations(
      apiClient,
      myProfileUrn,
      lastUpdatedBefore,
      nextCursor ?? undefined
    );

    if (convPage.length === 0) break;

    for (const conv of convPage) {
      if (conv.lastActivityAt && conv.lastActivityAt < sinceMs) {
        nextCursor = null;
        break;
      }

      const bareId = extractBareConvId(conv.backendUrn || conv.urn);
      const otherParticipant = conv.participants.find((p) => p.entityUrn !== myProfileUrn);
      const title = conv.title ?? otherParticipant?.name ?? "Unknown";

      const participantsList = conv.participants.map((p) => ({
        profileId: p.entityUrn.replace("urn:li:fsd_profile:", ""),
        urn: p.entityUrn,
        name: p.name ?? "",
        slug: p.profileUrl ? slugFromLinkedInUrl(p.profileUrl) : null,
      }));

      const record: ConversationRecord = {
        urn: conv.urn,
        backendUrn: conv.backendUrn,
        bareId,
        title,
        isGroup: conv.isGroup,
        participants: participantsList,
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

      await conversations.upsert(bareId, record);

      // Create symlink from contact slug → bare conv ID
      if (!conv.isGroup && otherParticipant) {
        const contactSlug = otherParticipant.profileUrl
          ? slugFromLinkedInUrl(otherParticipant.profileUrl)
          : null;
        if (contactSlug) {
          await conversations.createAlias(contactSlug, bareId).catch(() => {});
        }

        // Upsert contact record
        const contactProfileId = otherParticipant.entityUrn.replace("urn:li:fsd_profile:", "");
        await contacts.upsert(contactProfileId, {
          urn: otherParticipant.entityUrn,
          slug: contactSlug,
          name: otherParticipant.name ?? "",
          headline: otherParticipant.headline ?? null,
          profileUrl: otherParticipant.profileUrl ?? null,
          imageUrl: otherParticipant.imageUrl ?? null,
          connectedAt: null,
          fetchedAt: new Date().toISOString(),
        });

        if (contactSlug) {
          await contacts.createAlias(contactSlug, contactProfileId).catch(() => {});
        }
      }

      totalConversations++;

      // Fetch messages
      const messagesWritten = await syncConversationMessages(
        apiClient,
        conversations,
        bareId,
        conv.backendUrn || conv.urn,
        myProfileUrn,
        sinceMs
      );
      totalMessages += messagesWritten;
    }

    if (!cursor || nextCursor === null) break;
    nextCursor = cursor;

    const oldest = convPage[convPage.length - 1];
    if (oldest?.lastActivityAt) {
      lastUpdatedBefore = oldest.lastActivityAt;
    } else {
      break;
    }
  }

  await store.accounts.update(profileId, { lastSyncAt: new Date().toISOString() });
  await store.git.flush();

  if (options.json) {
    output.printData({ profileId, conversationsSynced: totalConversations, messagesSynced: totalMessages });
  } else {
    output.success(`Sync complete: ${totalConversations} conversations, ${totalMessages} messages`);
  }
}

async function syncConversationMessages(
  apiClient: ReturnType<typeof buildApiClient>,
  conversations: import("../store/conversations.js").ConversationStore,
  bareConvId: string,
  conversationUrn: string,
  myProfileUrn: string,
  sinceMs: number
): Promise<number> {
  const existing = await conversations.read(bareConvId);
  const knownNewestAt = existing?.syncState.newestMessageAt;

  let anchorTimestamp = Date.now();
  let fetched = 0;
  let oldestFetchedAt: number | null = null;
  let newestFetchedAt: number | null = null;
  const allMessages: StoredMessage[] = [];

  while (fetched < MESSAGES_PER_CONVERSATION) {
    let result: { messages: StoredMessage[]; hasMore: boolean };
    try {
      const raw = await fetchMessages(apiClient, conversationUrn, myProfileUrn, anchorTimestamp, MESSAGES_PER_PAGE);
      result = {
        messages: raw.messages.map((m) => toStoredMessage(m, myProfileUrn)),
        hasMore: raw.hasMore,
      };
    } catch (err) {
      output.debug(`Failed to fetch messages for ${bareConvId}: ${String(err)}`);
      break;
    }

    if (result.messages.length === 0) break;

    for (const msg of result.messages) {
      if (msg.timestamp < sinceMs) break;
      if (knownNewestAt && msg.timestamp <= knownNewestAt) break;
      allMessages.push(msg);
      fetched++;
      if (oldestFetchedAt === null || msg.timestamp < oldestFetchedAt) oldestFetchedAt = msg.timestamp;
      if (newestFetchedAt === null || msg.timestamp > newestFetchedAt) newestFetchedAt = msg.timestamp;
    }

    if (!result.hasMore || fetched >= MESSAGES_PER_CONVERSATION) break;
    anchorTimestamp = oldestFetchedAt ?? anchorTimestamp - 1;
  }

  if (allMessages.length > 0) {
    await conversations.appendMessages(bareConvId, allMessages);
    await conversations.updateSyncState(bareConvId, {
      oldestMessageAt: Math.min(oldestFetchedAt ?? Infinity, existing?.syncState.oldestMessageAt ?? Infinity),
      newestMessageAt: Math.max(newestFetchedAt ?? 0, existing?.syncState.newestMessageAt ?? 0),
      lastSyncAt: new Date().toISOString(),
      totalSynced: (existing?.syncState.totalSynced ?? 0) + allMessages.length,
    });
  }

  return allMessages.length;
}

function parseSince(since: string | undefined): number {
  if (!since) return Date.now() - 90 * 24 * 60 * 60 * 1000;
  const match = since.match(/^(\d+)(mo|y|d)$/);
  if (match && match[1] && match[2]) {
    const n = parseInt(match[1], 10);
    const unit = match[2];
    const ms = unit === "mo" ? n * 30 * 24 * 60 * 60 * 1000
      : unit === "y" ? n * 365 * 24 * 60 * 60 * 1000
      : n * 24 * 60 * 60 * 1000;
    return Date.now() - ms;
  }
  const d = new Date(since);
  if (!isNaN(d.getTime())) return d.getTime();
  throw new Error(`Invalid --since value: "${since}". Use 3mo, 6mo, 1y, or YYYY-MM-DD.`);
}

function toStoredMessage(
  m: { urn: string; deliveredAt: number; fromUrn: string; fromName: string | null; body: string; originToken: string | null; reactions: Array<{ emoji: string; count: number; hasUserReacted: boolean }>; attachments: Array<{ type: string; url?: string; name?: string; mimeType?: string; raw?: unknown }> },
  myProfileUrn: string
): StoredMessage {
  return {
    urn: m.urn,
    timestamp: m.deliveredAt,
    fromUrn: m.fromUrn,
    fromName: m.fromName ?? "",
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
