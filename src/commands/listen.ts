/**
 * allman listen — stream real-time LinkedIn events to stdout as NDJSON.
 *
 * stdout: NDJSON events
 * stderr: logs/debug
 */

import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import type { LinkedInApiClient } from "../linkedin/api/client.js";
import { listConversations } from "../linkedin/api/endpoints/conversations.js";
import { fetchMessages } from "../linkedin/api/endpoints/messages.js";
import { getProfileSlugById } from "../linkedin/api/endpoints/profiles.js";
import { loadSession } from "../linkedin/api/session.js";
import { SseClient, type SseEvent } from "../linkedin/realtime/sse-client.js";
import type { ConversationStore } from "../store/index.js";
import { resolveStorePath, Store } from "../store/index.js";
import type { ConversationRecord, StoredMessage } from "../store/types.js";
import { debug, emitEvent, error, info } from "../utils/output.js";
import { extractBareConvId } from "../utils/urn.js";

export interface ListenOptions {
  account?: string;
  store?: string;
}

export async function listenCommand(options: ListenOptions): Promise<void> {
  const storePath = resolveStorePath(options.store);
  const store = new Store({ path: storePath });
  await store.init();

  let session: Awaited<ReturnType<typeof loadSession>>;
  try {
    session = await loadSession(store, options.account);
  } catch (err) {
    error(String((err as Error).message), 1);
    return;
  }
  const { apiClient, profileId, myProfileUrn, accountRecord } = session;
  const conversations = store.forAccount(profileId);
  const accountDir = join(storePath, profileId);

  info(`Listening for messages (${accountRecord.name ?? profileId})...`);
  info("Streaming NDJSON events to stdout. Ctrl+C to stop.");

  const sseClient = new SseClient(apiClient, profileId);

  process.on("SIGINT", () => {
    sseClient.abort();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    sseClient.abort();
    process.exit(0);
  });

  for await (const event of sseClient.connect()) {
    await handleEvent(event, profileId, myProfileUrn, store, conversations, accountDir, apiClient);
  }
}

async function handleEvent(
  event: SseEvent,
  profileId: string,
  myProfileUrn: string,
  store: Store,
  conversations: ConversationStore,
  accountDir: string,
  apiClient: LinkedInApiClient
): Promise<void> {
  const timestamp = Date.now();

  switch (event.type) {
    case "connected": {
      emitEvent({
        event: "connected",
        account: profileId,
        connectionId: event.connectionId,
        timestamp,
      });
      return;
    }

    case "heartbeat": {
      emitEvent({ event: "heartbeat", account: profileId, timestamp });
      await store.accounts
        .update(profileId, { lastSyncAt: new Date(timestamp).toISOString() })
        .catch(() => {});
      return;
    }

    case "message.received":
    case "message.sent_echo": {
      const isFromMe =
        event.type === "message.sent_echo" ||
        (event.fromUrn !== undefined && event.fromUrn === myProfileUrn);

      // Resolve conversation — fetch from API if not in store
      let convInfo = event.conversationUrn
        ? await conversations.findByUrn(event.conversationUrn)
        : null;

      if (!convInfo && event.conversationUrn) {
        await fetchAndUpsertConversation(
          event.conversationUrn,
          myProfileUrn,
          apiClient,
          conversations
        );
        convInfo = event.conversationUrn
          ? await conversations.findByUrn(event.conversationUrn)
          : null;
      }

      const convId = convInfo?.convId ?? null;
      const convRecord = convInfo?.record ?? null;

      // Sender name: for 1:1 convs, convRecord.name is the other person
      const fromName = isFromMe ? null : (convRecord?.name ?? null);

      // Fetch body, attachments, and real URN if body is empty (SSE often
      // omits body text for non-plaintext messages like shared posts, and
      // never carries attachments directly).
      let body = event.body ?? "";
      let realUrn: string | null = null;
      let attachments: StoredMessage["attachments"] = [];
      let reactions: StoredMessage["reactions"] = [];
      if (event.conversationUrn) {
        try {
          const convUrn = convRecord?.backendUrn ?? event.conversationUrn;
          const { messages } = await fetchMessages(
            apiClient,
            convUrn,
            myProfileUrn,
            (event.timestamp ?? timestamp) + 1,
            5
          );
          const eventTs = event.timestamp ?? timestamp;
          const match = messages.find((m) => Math.abs(m.deliveredAt - eventTs) < 2000);
          if (match) {
            if (!body) body = match.body;
            realUrn = match.urn;
            attachments = match.attachments.map((a) => ({
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
            }));
            reactions = match.reactions;
          }
        } catch {
          /* non-fatal */
        }
      }

      emitEvent({
        event: isFromMe ? "message.sent" : "message.received",
        account: profileId,
        timestamp: event.timestamp ?? timestamp,
        conversation: convRecord
          ? { urn: convRecord.convUrn, convId, name: convRecord.name, slug: convRecord.slug }
          : { urn: event.conversationUrn, convId: null, name: null, slug: null },
        from: { urn: event.fromUrn, name: fromName },
        message: { urn: event.messageUrn, body, isFromMe },
      });

      // Persist to store — a message is worth keeping if it has a body OR
      // any attachment content. Purely-empty events are duplicate SSE echoes
      // we can safely drop.
      const messageUrn = realUrn ?? event.messageUrn;
      const hasContent = Boolean(body) || attachments.length > 0;
      if (convId && messageUrn && hasContent) {
        const storedMsg: StoredMessage = {
          urn: messageUrn,
          timestamp: event.timestamp ?? timestamp,
          fromUrn: event.fromUrn ?? "",
          fromName: fromName ?? "",
          isFromMe,
          body,
          reactions,
          attachments,
          originToken: event.originToken ?? null,
        };
        await conversations.appendMessages(convId, [storedMsg]).catch((err) => {
          debug(`Failed to persist message: ${String(err)}`);
        });
        await conversations
          .updateSyncState(convId, { newestMessageAt: event.timestamp ?? timestamp })
          .catch(() => {});
        store.git.scheduleCommit(`listen: new message in ${convId.slice(0, 20)}`);

        // Append to INBOX.jsonl for inbound messages. For attachment-only
        // messages (e.g. shared posts with no commentary), fall back to a
        // short placeholder so the inbox line is still meaningful.
        if (!isFromMe) {
          const inboxBody = body || summarizeAttachments(attachments);
          const inboxLine = JSON.stringify({
            from: fromName ?? event.fromUrn ?? "unknown",
            slug: convRecord?.slug ?? null,
            body: inboxBody,
            timestamp: event.timestamp ?? timestamp,
          });
          const inboxPath = join(accountDir, "INBOX.jsonl");
          await appendFile(inboxPath, `${inboxLine}\n`).catch((err) => {
            debug(`Failed to append to INBOX.jsonl: ${String(err)}`);
          });
        }
      }
      return;
    }

    case "typing": {
      const convInfo = event.conversationUrn
        ? await conversations.findByUrn(event.conversationUrn)
        : null;
      emitEvent({
        event: "typing",
        account: profileId,
        timestamp,
        conversation: { urn: event.conversationUrn, convId: convInfo?.convId ?? null },
        from: { urn: event.fromUrn },
      });
      return;
    }

    case "read_receipt": {
      emitEvent({
        event: "read_receipt",
        account: profileId,
        timestamp: event.timestamp ?? timestamp,
        conversation: { urn: event.conversationUrn },
      });
      return;
    }

    case "reaction": {
      emitEvent({
        event: "reaction",
        account: profileId,
        timestamp,
        messageUrn: event.messageUrn,
        reactions: event.reactions,
      });
      return;
    }

    case "raw": {
      debug(`Unhandled SSE event: ${JSON.stringify(event.raw)}`);
      return;
    }
  }
}

async function fetchAndUpsertConversation(
  conversationUrn: string,
  myProfileUrn: string,
  apiClient: LinkedInApiClient,
  conversations: ConversationStore
): Promise<void> {
  try {
    debug(`listen: fetching unknown conversation from API: ${conversationUrn}`);
    const { conversations: page } = await listConversations(apiClient, myProfileUrn, Date.now());

    const match = page.find((c) => c.urn === conversationUrn || c.backendUrn === conversationUrn);
    if (!match) return;

    // Skip group conversations
    if (match.isGroup) {
      debug(`listen: skipping group conversation ${conversationUrn}`);
      return;
    }

    const convId = extractBareConvId(match.backendUrn || match.urn);
    const otherParticipant = match.participants.find((p) => p.entityUrn !== myProfileUrn);
    if (!otherParticipant) return;

    const contactProfileUrn = otherParticipant.entityUrn;
    const contactProfileId = contactProfileUrn.replace("urn:li:fsd_profile:", "");

    // Try to resolve slug
    const existingRecord = await conversations.read(convId);
    let slug: string | null = existingRecord?.slug ?? null;
    if (!slug) {
      slug = await getProfileSlugById(apiClient, contactProfileId).catch(() => null);
    }

    const fullName = otherParticipant.name ?? "Unknown";
    const { firstName, lastName } = splitName(fullName);

    const record: ConversationRecord = {
      convId,
      profileId: contactProfileId,
      slug,
      convUrn: match.urn,
      backendUrn: match.backendUrn || null,
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
      unreadCount: match.unreadCount,
      lastActivityAt: match.lastActivityAt ? new Date(match.lastActivityAt).toISOString() : null,
      lastReadAt: null,
      createdAt: null,
      read: match.unreadCount === 0,
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
  } catch (err) {
    debug(`listen: failed to fetch conversation: ${String(err)}`);
  }
}

function splitName(name: string): { firstName: string; lastName: string } {
  const spaceIdx = name.indexOf(" ");
  if (spaceIdx === -1) return { firstName: name, lastName: "" };
  return { firstName: name.slice(0, spaceIdx), lastName: name.slice(spaceIdx + 1) };
}

/**
 * Produce a short, human-readable placeholder for messages whose body text is
 * empty (attachment-only payloads like shared posts, images, or videos).
 * Used for INBOX.jsonl lines so the inbox stays readable.
 */
function summarizeAttachments(attachments: StoredMessage["attachments"]): string {
  const a = attachments[0];
  if (!a) return "";
  switch (a.type) {
    case "post_share":
      return a.authorName ? `[shared a post by ${a.authorName}]` : "[shared a post]";
    case "link_preview":
      return a.title ? `[link: ${a.title}]` : "[shared a link]";
    case "image":
      return "[image]";
    case "gif":
      return "[gif]";
    case "video": {
      const dur = formatDuration(a.durationMs);
      return dur ? `[video ${dur}]` : "[video]";
    }
    case "audio":
    case "voice": {
      const dur = formatDuration(a.durationMs);
      return dur ? `[voice ${dur}]` : "[voice message]";
    }
    case "file":
      return a.name ? `[file: ${a.name}]` : "[file]";
    case "forwarded":
      return a.authorName ? `[forwarded from ${a.authorName}]` : "[forwarded message]";
    case "replied":
      return a.originalText ? `[replied: ${a.originalText.slice(0, 60)}]` : "[reply]";
    case "unavailable":
      return "[unavailable message]";
    case "away_message":
      return "[away message]";
    default:
      return "[attachment]";
  }
}

function formatDuration(ms: number | undefined): string {
  if (!ms || ms <= 0) return "";
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m === 0) return `${s}s`;
  return `${m}m ${s}s`;
}
