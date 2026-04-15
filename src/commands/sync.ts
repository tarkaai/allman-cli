/**
 * lilac sync — pull conversation history into the local file store.
 *
 * Usage:
 *   lilac sync                                  # incremental: since lastSyncAt
 *   lilac sync --since 1mo                      # absolute floor
 *   lilac sync --from 2024-01-01 --to 2024-02-01  # date window
 *   lilac sync --limit 10                       # max conversations to walk
 *   lilac sync <conv> --limit 1000              # max messages on a single conv
 *
 * Direction semantics:
 *   - Inbox sync walks newest → oldest, stops at the older boundary (--from).
 *   - Single-conv sync paginates backwards from the newer boundary (--to or now)
 *     and bypasses the "newest known" dedup so it can backfill arbitrarily far.
 *
 * Streaming progress (--json mode only): NDJSON events emitted to stdout as
 * the sync runs — sync.start, sync.conversation, sync.conversation.progress,
 * sync.complete. Final summary is the last event.
 */

import { Store, resolveStorePath } from "../store/index.js";
import { loadSession } from "../linkedin/api/session.js";
import { listConversations } from "../linkedin/api/endpoints/conversations.js";
import { fetchMessages, type MessageData } from "../linkedin/api/endpoints/messages.js";
import { getProfileSlugById } from "../linkedin/api/endpoints/profiles.js";
import * as output from "../utils/output.js";
import { parseSince } from "../utils/time.js";
import { getDownloadRateLimiter, type DownloadRateLimiter } from "../utils/rate-limiter.js";
import type { ConversationRecord, StoredMessage } from "../store/types.js";
import type { ConversationStore } from "../store/conversations.js";
import { extractBareConvId } from "../utils/urn.js";
import type { LinkedInApiClient } from "../linkedin/api/client.js";

const DEFAULT_MESSAGES_PER_CONVERSATION = 1000;
const MESSAGES_PER_PAGE = 20;

export interface SyncOptions {
  conversation?: string;
  account?: string;
  store?: string;
  /** Legacy alias for --from. Older callers still pass this. */
  since?: string;
  /** Older boundary (oldest message to fetch). Duration or ISO date. */
  from?: string;
  /** Newer boundary (newest message to fetch). Duration or ISO date. Defaults to now. */
  to?: string;
  /**
   * Max items. For inbox sync this caps conversations walked. For single-conv
   * sync this caps messages fetched. Default: unlimited (inbox), 1000 (conv).
   */
  limit?: number;
  json?: boolean;
}

/** Backoff state for rate-limited profile slug lookups. */
interface BackoffState {
  delayMs: number;
}

const BACKOFF_INITIAL_MS = 1000;
const BACKOFF_MAX_MS = 60_000;

export async function syncCommand(options: SyncOptions): Promise<void> {
  const storePath = resolveStorePath(options.store);
  const store = new Store({ path: storePath });
  await store.init();

  let session;
  try {
    session = await loadSession(store, options.account);
  } catch (err) {
    output.error(String((err as Error).message), 1);
    return;
  }
  const { apiClient, profileId, myProfileUrn, accountRecord } = session;

  // Resolve the older boundary. Precedence: --from > --since > lastSyncAt > 90d ago.
  // For single-conv sync the default is "all of time" so backfill works.
  const olderBoundarySource = options.from ?? options.since;
  const fromMs = options.conversation
    ? olderBoundarySource
      ? parseSince(olderBoundarySource, undefined, 0)
      : 0
    : parseSince(
        olderBoundarySource,
        accountRecord.lastSyncAt ?? undefined,
        90 * 24 * 60 * 60 * 1000
      );

  // Resolve the newer boundary. Defaults to "now". `parseSince` returns a past
  // timestamp for durations, which is what we want — `--to 1d` means "as new as
  // 1 day ago", clamping the top of the window.
  const toMs = options.to ? parseSince(options.to, undefined, 0) : Date.now();

  if (toMs <= fromMs) {
    output.error(
      `Empty sync window: --to (${new Date(toMs).toISOString()}) must be after --from (${new Date(fromMs).toISOString()}).`,
      1
    );
    return;
  }

  const fromDate = new Date(fromMs);
  // Capture start time before any API calls — used as the new lastSyncAt so
  // the next incremental sync picks up from exactly where this one started.
  const syncStartedAt = new Date().toISOString();
  const conversations = store.forAccount(profileId);
  const downloadLimiter = getDownloadRateLimiter(profileId);

  // -------------------------------------------------------------------------
  // Single-conversation sync (backfill)
  // -------------------------------------------------------------------------
  if (options.conversation) {
    const convId = await conversations.resolve(options.conversation);
    if (!convId) {
      output.error(
        `Conversation "${options.conversation}" not found in store. Run \`lilac sync\` first.`,
        1
      );
      return;
    }
    const record = await conversations.read(convId);
    if (!record) {
      output.error(`Conversation record not found for ${convId}`, 1);
      return;
    }
    const convUrn = record.backendUrn || record.convUrn;
    if (!options.json) {
      output.info(`Syncing conversation: ${record.name ?? convId}...`);
    }

    if (options.json) {
      output.emitEvent({
        event: "sync.start",
        scope: "conversation",
        account: profileId,
        convId,
        slug: record.slug,
        from: fromMs,
        to: toMs,
      });
    }

    const messageLimit = options.limit ?? DEFAULT_MESSAGES_PER_CONVERSATION;
    const messagesWritten = await syncConversationMessages(
      apiClient,
      conversations,
      convId,
      convUrn,
      myProfileUrn,
      fromMs,
      toMs,
      messageLimit,
      true,
      downloadLimiter,
      options.json === true,
      record.slug
    );

    await store.git.flush();

    if (options.json) {
      output.emitEvent({
        event: "sync.complete",
        scope: "conversation",
        account: profileId,
        convId,
        slug: record.slug,
        messagesSynced: messagesWritten,
      });
    } else {
      output.success(
        `Sync complete: ${messagesWritten} messages for ${record.name ?? convId}`
      );
    }
    return;
  }

  // -------------------------------------------------------------------------
  // Inbox sync — walk conversations, fetch messages for each
  // -------------------------------------------------------------------------
  if (!options.json) {
    output.info(
      `Syncing ${accountRecord.name ?? profileId} (since ${fromDate.toISOString().slice(0, 10)})...`
    );
  }
  if (options.json) {
    output.emitEvent({
      event: "sync.start",
      scope: "inbox",
      account: profileId,
      from: fromMs,
      to: toMs,
      limit: options.limit ?? null,
    });
  }

  let totalConversations = 0;
  let totalMessages = 0;
  let nextCursor: string | null | undefined = undefined;
  // Start pagination from the newer boundary so `--to` actually clamps the
  // top of the window.
  let lastUpdatedBefore = toMs;
  const backoff: BackoffState = { delayMs: BACKOFF_INITIAL_MS };
  const convLimit = options.limit ?? Number.POSITIVE_INFINITY;

  if (!options.json) output.info("Fetching conversation list...");

  outer: while (true) {
    const { conversations: convPage, nextCursor: cursor } = await listConversations(
      apiClient,
      myProfileUrn,
      lastUpdatedBefore,
      nextCursor ?? undefined
    );

    // LinkedIn occasionally returns an empty first page transiently.
    if (convPage.length === 0) {
      if (nextCursor == null) {
        output.debug("LinkedIn returned 0 conversations on first page — may be transient");
      }
      break;
    }

    for (const conv of convPage) {
      // Stop when we've gone past the older boundary.
      if (conv.lastActivityAt && conv.lastActivityAt < fromMs) {
        nextCursor = null;
        break;
      }

      // Skip activity above the newer boundary (e.g. when --to is in the past).
      if (conv.lastActivityAt && conv.lastActivityAt > toMs) continue;

      // Skip group conversations — we only support 1:1
      if (conv.isGroup) continue;

      const convId = extractBareConvId(conv.backendUrn || conv.urn);
      const otherParticipant = conv.participants.find((p) => p.entityUrn !== myProfileUrn);
      if (!otherParticipant) continue;

      const contactProfileUrn = otherParticipant.entityUrn;
      const contactProfileId = contactProfileUrn.replace("urn:li:fsd_profile:", "");

      // Resolve the contact's slug — check existing record first to avoid redundant API calls
      let slug: string | null = null;
      const existingRecord = await conversations.read(convId);
      if (existingRecord?.slug) {
        slug = existingRecord.slug;
      } else {
        slug = await resolveSlugWithBackoff(apiClient, contactProfileId, backoff);
      }

      const fullName = otherParticipant.name ?? "Unknown";
      const { firstName, lastName } = splitName(fullName);

      const record: ConversationRecord = {
        convId,
        profileId: contactProfileId,
        slug,
        convUrn: conv.urn,
        backendUrn: conv.backendUrn || null,
        profileUrn: contactProfileUrn,
        memberUrn: null,
        firstName,
        lastName,
        name: fullName,
        headline: otherParticipant.headline ?? null,
        profileUrl: otherParticipant.profileUrl ?? null,
        profilePictures: null,
        distance: null,
        pronoun: null,
        memberBadgeType: null,
        isPremium: false,
        isVerified: false,
        unreadCount: conv.unreadCount,
        lastActivityAt: conv.lastActivityAt ? new Date(conv.lastActivityAt).toISOString() : null,
        lastReadAt: null,
        createdAt: null,
        read: conv.unreadCount === 0,
        notificationStatus: null,
        categories: [],
        conversationUrl: null,
        disabledFeatures: [],
        syncState: existingRecord?.syncState ?? {
          oldestMessageAt: null,
          newestMessageAt: null,
          lastSyncAt: null,
          totalSynced: 0,
          fullyBackfilled: false,
        },
        fetchedAt: new Date().toISOString(),
      };

      await conversations.upsert(convId, record);
      totalConversations++;

      if (options.json) {
        output.emitEvent({
          event: "sync.conversation",
          account: profileId,
          convId,
          slug,
          name: fullName,
          conversationsSeen: totalConversations,
        });
      }

      // Fetch messages for this conversation. Inbox sync uses incremental
      // dedup (knownNewestAt skip), single-conv sync below uses forceResync.
      const messagesWritten = await syncConversationMessages(
        apiClient,
        conversations,
        convId,
        conv.backendUrn || conv.urn,
        myProfileUrn,
        fromMs,
        toMs,
        DEFAULT_MESSAGES_PER_CONVERSATION,
        false,
        downloadLimiter,
        options.json === true,
        slug
      );
      totalMessages += messagesWritten;

      if (totalConversations >= convLimit) {
        nextCursor = null;
        break outer;
      }
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

  await store.accounts.update(profileId, { lastSyncAt: syncStartedAt });
  await store.git.flush();

  if (options.json) {
    output.emitEvent({
      event: "sync.complete",
      scope: "inbox",
      account: profileId,
      conversationsSynced: totalConversations,
      messagesSynced: totalMessages,
    });
  } else {
    output.success(
      `Sync complete: ${totalConversations} conversations, ${totalMessages} messages`
    );
  }
}

/**
 * Resolve a profile slug by profileId with exponential backoff on rate limits.
 * Returns null if the slug cannot be resolved (404, network error, etc).
 * Throws on 401 (auth expired — abort the whole sync).
 */
async function resolveSlugWithBackoff(
  apiClient: LinkedInApiClient,
  profileId: string,
  backoff: BackoffState
): Promise<string | null> {
  await sleep(backoff.delayMs);

  try {
    const slug = await getProfileSlugById(apiClient, profileId);
    backoff.delayMs = BACKOFF_INITIAL_MS;
    return slug;
  } catch (err: unknown) {
    const status = extractHttpStatus(err);
    if (status === 401) {
      throw new Error("Authentication expired during slug lookup. Re-run `lilac login`.");
    }
    if (status === 429 || (status !== null && status >= 500)) {
      backoff.delayMs = Math.min(backoff.delayMs * 2, BACKOFF_MAX_MS);
      output.debug(`Slug lookup rate-limited (${status}), backing off to ${backoff.delayMs}ms`);
    }
    return null;
  }
}

function extractHttpStatus(err: unknown): number | null {
  if (err && typeof err === "object" && "response" in err) {
    const resp = (err as Record<string, unknown>).response;
    if (resp && typeof resp === "object" && "status" in resp) {
      const status = (resp as Record<string, unknown>).status;
      if (typeof status === "number") return status;
    }
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function splitName(name: string): { firstName: string; lastName: string } {
  const spaceIdx = name.indexOf(" ");
  if (spaceIdx === -1) return { firstName: name, lastName: "" };
  return { firstName: name.slice(0, spaceIdx), lastName: name.slice(spaceIdx + 1) };
}

/**
 * Fetch messages for a single conversation in the [fromMs, toMs] window.
 *
 * `forceResync = false` (inbox sync): use the existing `newestMessageAt` as a
 * cheap "stop here" hint — we know everything older than that. We still walk
 * one extra page past it so dedup-by-URN catches gap fillers.
 *
 * `forceResync = true` (single-conv backfill): never apply the newest filter.
 * Walk straight from `toMs` (or `Date.now()`) backwards toward `fromMs`,
 * stopping when LinkedIn says hasMore=false or we hit the message limit.
 *
 * Sets `fullyBackfilled = true` when LinkedIn reports no more pages and we
 * weren't stopped by the time window or limit.
 */
async function syncConversationMessages(
  apiClient: LinkedInApiClient,
  conversations: ConversationStore,
  convId: string,
  conversationUrn: string,
  myProfileUrn: string,
  fromMs: number,
  toMs: number,
  messageLimit: number,
  forceResync: boolean,
  downloadLimiter: DownloadRateLimiter,
  jsonMode: boolean,
  slug: string | null
): Promise<number> {
  const existing = await conversations.read(convId);
  const knownNewestAt = forceResync ? null : existing?.syncState.newestMessageAt ?? null;
  output.debug(
    `syncConvMessages: knownNewestAt=${knownNewestAt}, fromMs=${fromMs}, toMs=${toMs}, force=${forceResync}`
  );

  // Anchor at toMs (or just past it so the first page includes toMs itself).
  // The LinkedIn API uses `deliveredAt` as a strict upper bound on the page.
  let anchorTimestamp = Math.min(toMs + 1, Date.now() + 1);
  let fetched = 0;
  let oldestFetchedAt: number | null = null;
  let newestFetchedAt: number | null = null;
  let reachedEnd = false;
  const allMessages: StoredMessage[] = [];

  while (fetched < messageLimit) {
    // Reserve a page worth of slots up front. Worst case we ask for slightly
    // more than we use; the limiter ages them out either way.
    await downloadLimiter.acquire(MESSAGES_PER_PAGE);

    let result: { messages: StoredMessage[]; hasMore: boolean };
    try {
      const raw = await fetchMessages(
        apiClient,
        conversationUrn,
        myProfileUrn,
        anchorTimestamp,
        MESSAGES_PER_PAGE
      );
      output.debug(`fetchMessages returned ${raw.messages.length} messages, hasMore=${raw.hasMore}`);
      result = {
        messages: raw.messages.map((m) => toStoredMessage(m, myProfileUrn)),
        hasMore: raw.hasMore,
      };
    } catch (err) {
      output.debug(`Failed to fetch messages for ${convId}: ${String(err)}`);
      break;
    }

    if (result.messages.length === 0) {
      reachedEnd = true;
      break;
    }

    const prevFetched = fetched;
    let skipped = 0;
    let crossedFromBoundary = false;
    for (const msg of result.messages) {
      // LinkedIn sometimes omits `deliveredAt` on special content types
      // (shared posts, system messages). We don't trust timestamp=0 to
      // drive boundary logic — it would falsely look "older than fromMs"
      // and stop the whole sync. Keep the message but skip boundary checks.
      if (msg.timestamp === 0) {
        output.debug(`message ${msg.urn} has no deliveredAt — including anyway`);
        allMessages.push(msg);
        fetched++;
        continue;
      }
      // Older boundary: stop the whole sync once we cross it. We still record
      // the page so allMessages contains everything ≥ fromMs.
      if (msg.timestamp < fromMs) {
        skipped++;
        crossedFromBoundary = true;
        continue;
      }
      // Newer boundary: skip anything outside the requested window.
      if (msg.timestamp > toMs) {
        skipped++;
        continue;
      }
      // Inbox-sync dedup: skip messages we already know about. Backfill
      // (forceResync) bypasses this so it can fill in older history.
      if (knownNewestAt !== null && msg.timestamp <= knownNewestAt) {
        skipped++;
        continue;
      }
      allMessages.push(msg);
      fetched++;
      if (oldestFetchedAt === null || msg.timestamp < oldestFetchedAt) oldestFetchedAt = msg.timestamp;
      if (newestFetchedAt === null || msg.timestamp > newestFetchedAt) newestFetchedAt = msg.timestamp;
    }

    output.debug(
      `page: ${fetched - prevFetched} new, ${skipped} skipped, oldest=${oldestFetchedAt}`
    );

    if (jsonMode && fetched > prevFetched) {
      output.emitEvent({
        event: "sync.conversation.progress",
        convId,
        slug,
        messagesFetched: fetched,
        oldestMessageAt: oldestFetchedAt,
        newestMessageAt: newestFetchedAt,
      });
    }

    // Crossed the older boundary on this page — done.
    if (crossedFromBoundary) {
      reachedEnd = false;
      break;
    }

    // No new messages on this page. For backfill that's fatal (we've hit a
    // wall). For inbox sync it usually means we caught up to the dedup floor.
    if (fetched === prevFetched) break;

    if (!result.hasMore || fetched >= messageLimit) {
      reachedEnd = !result.hasMore;
      break;
    }

    // Walk back: subtract 1 ms so the next page doesn't re-include the page
    // boundary message.
    anchorTimestamp = (oldestFetchedAt ?? anchorTimestamp) - 1;
  }

  if (allMessages.length > 0) {
    await conversations.appendMessages(convId, allMessages);
    const mergedOldest = Math.min(
      oldestFetchedAt ?? Number.POSITIVE_INFINITY,
      existing?.syncState.oldestMessageAt ?? Number.POSITIVE_INFINITY
    );
    const mergedNewest = Math.max(
      newestFetchedAt ?? 0,
      existing?.syncState.newestMessageAt ?? 0
    );
    await conversations.updateSyncState(convId, {
      oldestMessageAt: Number.isFinite(mergedOldest) ? mergedOldest : null,
      newestMessageAt: mergedNewest > 0 ? mergedNewest : null,
      lastSyncAt: new Date().toISOString(),
      totalSynced: (existing?.syncState.totalSynced ?? 0) + allMessages.length,
      fullyBackfilled:
        (existing?.syncState.fullyBackfilled ?? false) || (forceResync && reachedEnd),
    });
  } else if (forceResync && reachedEnd && existing) {
    // Backfill walked the whole conversation but found nothing new — still
    // mark it as fully backfilled so the TUI knows not to ask again.
    await conversations.updateSyncState(convId, {
      lastSyncAt: new Date().toISOString(),
      fullyBackfilled: true,
    });
  }

  return allMessages.length;
}


function toStoredMessage(
  m: MessageData,
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
      type: a.type,
      url: a.url,
      name: a.name,
      size: a.size,
      mimeType: a.mimeType,
      previewUrl: a.previewUrl,
      width: a.width,
      height: a.height,
      durationMs: a.durationMs,
      title: a.title,
      description: a.description,
      originalText: a.originalText,
      authorName: a.authorName,
      raw: a.raw,
    })),
    originToken: m.originToken,
  };
}
