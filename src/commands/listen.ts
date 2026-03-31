/**
 * lilac listen — stream real-time LinkedIn events to stdout as NDJSON.
 *
 * stdout: NDJSON events
 * stderr: logs/debug
 */

import { join } from "path";
import { Store, resolveStorePath } from "../store/index.js";
import { buildApiClient, type LinkedInApiClient } from "../linkedin/api/client.js";
import { loadCookieJar, serializeCookieJar } from "../linkedin/api/cookies.js";
import { SseClient, type SseEvent } from "../linkedin/realtime/sse-client.js";
import { listConversations, type ConversationData } from "../linkedin/api/endpoints/conversations.js";
import { fetchMessages } from "../linkedin/api/endpoints/messages.js";
import { emitEvent, info, error, debug } from "../utils/output.js";
import { extractBareConvId } from "../utils/urn.js";
import { slugFromLinkedInUrl } from "../utils/slug.js";
import type { ConversationRecord, StoredMessage } from "../store/types.js";
import type { ConversationStore, ContactStore } from "../store/index.js";

export interface ListenOptions {
  account?: string;
  store?: string;
}

export async function listenCommand(options: ListenOptions): Promise<void> {
  const storePath = resolveStorePath(options.store);
  const store = new Store({ path: storePath });
  await store.init();

  const profileId = await store.accounts.getDefault(options.account);
  const accountRecord = await store.accounts.read(profileId);

  if (!accountRecord || accountRecord.status !== "authenticated") {
    error(`Account not authenticated. Run \`lilac login\``, 1);
    return;
  }

  if (!accountRecord.urn) {
    error(`Account has no profile URN. Re-run \`lilac login\`.`, 1);
    return;
  }

  const myProfileUrn = accountRecord.urn;
  const accountConfig = await store.accounts.readConfig(profileId);
  const jar = loadCookieJar(accountRecord);
  const { conversations, contacts } = store.forAccount(profileId);

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

  info(`Listening for messages (${accountRecord.name ?? profileId})...`);
  info("Streaming NDJSON events to stdout. Ctrl+C to stop.");

  const sseClient = new SseClient(apiClient, profileId);

  process.on("SIGINT", () => { sseClient.abort(); process.exit(0); });
  process.on("SIGTERM", () => { sseClient.abort(); process.exit(0); });

  for await (const event of sseClient.connect()) {
    await handleEvent(event, profileId, myProfileUrn, store, conversations, contacts, apiClient);
  }
}

async function handleEvent(
  event: SseEvent,
  profileId: string,
  myProfileUrn: string,
  store: Store,
  conversations: ConversationStore,
  contacts: ContactStore,
  apiClient: LinkedInApiClient
): Promise<void> {
  const timestamp = Date.now();

  switch (event.type) {
    case "connected": {
      emitEvent({ event: "connected", account: profileId, connectionId: event.connectionId, timestamp });
      return;
    }

    case "heartbeat": {
      emitEvent({ event: "heartbeat", account: profileId, timestamp });
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
        await fetchAndUpsertConversation(event.conversationUrn, myProfileUrn, apiClient, conversations, contacts);
        convInfo = event.conversationUrn
          ? await conversations.findByUrn(event.conversationUrn)
          : null;
      }

      const bareConvId = convInfo?.bareId ?? null;
      const convRecord = convInfo?.record ?? null;

      // Resolve sender name from participants
      const senderParticipant = convRecord?.participants.find(
        (p) => p.urn === event.fromUrn || event.fromUrn?.includes(p.profileId)
      );
      const fromName = senderParticipant?.name ?? (isFromMe ? convRecord?.participants.find(p => p.urn === myProfileUrn)?.name ?? null : null);

      // Fetch body if empty
      let body = event.body ?? "";
      if (!body && event.conversationUrn && bareConvId) {
        try {
          const convUrn = convRecord?.backendUrn ?? event.conversationUrn;
          const { messages } = await fetchMessages(apiClient, convUrn, myProfileUrn, (event.timestamp ?? timestamp) + 1, 5);
          const match = messages.find((m) => m.urn === event.messageUrn);
          if (match) body = match.body;
        } catch { /* non-fatal */ }
      }

      emitEvent({
        event: isFromMe ? "message.sent" : "message.received",
        account: profileId,
        timestamp: event.timestamp ?? timestamp,
        conversation: convRecord
          ? { urn: convRecord.urn, bareId: bareConvId, title: convRecord.title, isGroup: convRecord.isGroup }
          : { urn: event.conversationUrn, bareId: null, title: null, isGroup: false },
        from: { urn: event.fromUrn, name: fromName },
        message: { urn: event.messageUrn, body, isFromMe },
      });

      // Persist to store
      if (bareConvId && event.messageUrn) {
        const storedMsg: StoredMessage = {
          urn: event.messageUrn,
          timestamp: event.timestamp ?? timestamp,
          fromUrn: event.fromUrn ?? "",
          fromName: fromName ?? "",
          isFromMe,
          body,
          reactions: [],
          attachments: [],
          originToken: event.originToken ?? null,
        };
        await conversations.appendMessages(bareConvId, [storedMsg]).catch((err) => {
          debug(`Failed to persist message: ${String(err)}`);
        });
        await conversations.updateSyncState(bareConvId, { newestMessageAt: event.timestamp ?? timestamp }).catch(() => {});
        store.git.scheduleCommit(`listen: new message in ${bareConvId.slice(0, 20)}`);
      }
      return;
    }

    case "typing": {
      const convInfo = event.conversationUrn ? await conversations.findByUrn(event.conversationUrn) : null;
      emitEvent({ event: "typing", account: profileId, timestamp, conversation: { urn: event.conversationUrn, bareId: convInfo?.bareId ?? null }, from: { urn: event.fromUrn } });
      return;
    }

    case "read_receipt": {
      emitEvent({ event: "read_receipt", account: profileId, timestamp: event.timestamp ?? timestamp, conversation: { urn: event.conversationUrn } });
      return;
    }

    case "reaction": {
      emitEvent({ event: "reaction", account: profileId, timestamp, messageUrn: event.messageUrn, reactions: event.reactions });
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
  conversations: ConversationStore,
  contacts: ContactStore
): Promise<void> {
  try {
    debug(`listen: fetching unknown conversation from API: ${conversationUrn}`);
    const { conversations: page } = await listConversations(apiClient, myProfileUrn, Date.now());

    const match = page.find((c) => c.urn === conversationUrn || c.backendUrn === conversationUrn);
    if (!match) return;

    await upsertConversationRecord(match, myProfileUrn, conversations, contacts);
  } catch (err) {
    debug(`listen: failed to fetch conversation: ${String(err)}`);
  }
}

async function upsertConversationRecord(
  conv: ConversationData,
  myProfileUrn: string,
  conversations: ConversationStore,
  contacts: ContactStore
): Promise<void> {
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
    syncState: { oldestMessageAt: null, newestMessageAt: null, lastSyncAt: new Date().toISOString(), totalSynced: 0, fullyBackfilled: false },
  };

  await conversations.upsert(bareId, record);

  if (!conv.isGroup && otherParticipant) {
    const slug = otherParticipant.profileUrl ? slugFromLinkedInUrl(otherParticipant.profileUrl) : null;
    if (slug) await conversations.createAlias(slug, bareId).catch(() => {});

    const contactId = otherParticipant.entityUrn.replace("urn:li:fsd_profile:", "");
    await contacts.upsert(contactId, {
      urn: otherParticipant.entityUrn,
      slug,
      name: otherParticipant.name ?? "",
      headline: otherParticipant.headline ?? null,
      profileUrl: otherParticipant.profileUrl ?? null,
      imageUrl: otherParticipant.imageUrl ?? null,
      connectedAt: null,
      fetchedAt: new Date().toISOString(),
    });
    if (slug) await contacts.createAlias(slug, contactId).catch(() => {});
  }
}
