/**
 * lilac send — send a message to a LinkedIn contact.
 */

import { Store, resolveStorePath } from "../store/index.js";
import { LinkedInError } from "../linkedin/api/client.js";
import { loadSession } from "../linkedin/api/session.js";
import { findConversationByRecipient } from "../linkedin/api/endpoints/conversations.js";
import { fetchMessages, sendMessage, sendFirstMessage } from "../linkedin/api/endpoints/messages.js";
import { getProfileDataBySlug } from "../linkedin/api/endpoints/profiles.js";
import { isUrn, extractBareConvId, profileUrnId } from "../utils/urn.js";
import { slugFromUrl } from "../utils/slug.js";
import * as output from "../utils/output.js";
import type { ConversationRecord, StoredMessage } from "../store/types.js";
import type { ConversationStore } from "../store/index.js";

export interface SendOptions {
  account?: string;
  store?: string;
  json?: boolean;
}

export async function sendCommand(target: string, text: string, options: SendOptions): Promise<void> {
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
  const conversations = store.forAccount(profileId);

  const resolved = await resolveTarget(target, myProfileUrn, apiClient, conversations);

  if (resolved.error) {
    output.error(resolved.error, 1);
    return;
  }

  const { bareConvId, contactProfileUrn, contactSlug, contactFirstName, contactLastName, isNewConversation } = resolved;

  // Pre-send sync — abort if new inbound messages arrived since last sync
  if (bareConvId && !isNewConversation) {
    const newInbounds = await preSendSync(apiClient, conversations, bareConvId, myProfileUrn);
    if (newInbounds.length > 0) {
      output.warn(`${newInbounds.length} new message(s) received before send — aborting.`);
      output.warn("Read them before deciding whether to send:\n");
      for (const m of newInbounds) {
        const time = new Date(m.timestamp).toLocaleTimeString();
        process.stderr.write(`  [${time}] ${m.fromName || m.fromUrn}: ${m.body}\n`);
      }
      process.stderr.write("\nRe-run the send command when you're ready.\n");
      process.exit(1);
    }
  }

  // Send (rate limiting enforced by the API client)
  let result: { messageUrn: string; conversationUrn: string; backendConversationUrn: string; deliveredAt: number };

  try {
    if (isNewConversation && contactProfileUrn) {
      output.info("Starting new conversation...");
      result = await sendFirstMessage(apiClient, contactProfileUrn, myProfileUrn, text);
    } else if (bareConvId) {
      const convRecord = await conversations.read(bareConvId);
      const convUrn = convRecord?.backendUrn ?? convRecord?.convUrn ?? bareConvId;
      result = await sendMessage(apiClient, convUrn, myProfileUrn, text);
    } else {
      output.error("Could not determine conversation to send to.", 1);
      return;
    }
  } catch (err: unknown) {
    if (err instanceof LinkedInError) {
      output.error(err.message, 1);
    } else {
      output.error(`Send failed: ${String(err)}`, 1);
    }
    return;
  }

  // Store the sent message
  const targetBareId = bareConvId ?? extractBareConvId(result.backendConversationUrn || result.conversationUrn);
  const storedMsg: StoredMessage = {
    urn: result.messageUrn,
    timestamp: result.deliveredAt,
    fromUrn: myProfileUrn,
    fromName: accountRecord.name ?? "",
    isFromMe: true,
    body: text,
    reactions: [],
    attachments: [],
    originToken: null,
  };

  if (await conversations.exists(targetBareId)) {
    await conversations.appendMessages(targetBareId, [storedMsg]);
    // Update lastActivityAt, newestMessageAt, and backfill slug if missing
    const existing = await conversations.read(targetBareId);
    if (existing) {
      await conversations.upsert(targetBareId, {
        ...existing,
        slug: contactSlug && !existing.slug ? contactSlug : existing.slug,
        lastActivityAt: new Date(result.deliveredAt).toISOString(),
        syncState: {
          ...existing.syncState,
          newestMessageAt: Math.max(existing.syncState?.newestMessageAt ?? 0, result.deliveredAt),
        },
      });
    }
  } else if (result.backendConversationUrn) {
    const contactPid = contactProfileUrn ? contactProfileUrn.replace("urn:li:fsd_profile:", "") : "";
    const newRecord: ConversationRecord = {
      convId: targetBareId,
      profileId: contactPid,
      slug: contactSlug ?? null,
      convUrn: result.conversationUrn,
      backendUrn: result.backendConversationUrn,
      profileUrn: contactProfileUrn ?? "",
      memberUrn: null,
      firstName: contactFirstName ?? "",
      lastName: contactLastName ?? "",
      name: [contactFirstName, contactLastName].filter(Boolean).join(" ") || "New conversation",
      headline: null,
      profileUrl: null,
      profilePictures: null,
      distance: null,
      pronoun: null,
      memberBadgeType: null,
      isPremium: false,
      isVerified: false,
      unreadCount: 0,
      lastActivityAt: new Date(result.deliveredAt).toISOString(),
      lastReadAt: null,
      createdAt: new Date(result.deliveredAt).toISOString(),
      read: true,
      notificationStatus: null,
      categories: [],
      conversationUrl: null,
      disabledFeatures: [],
      syncState: { oldestMessageAt: result.deliveredAt, newestMessageAt: result.deliveredAt, lastSyncAt: new Date().toISOString(), totalSynced: 1, fullyBackfilled: false },
      fetchedAt: new Date().toISOString(),
    };
    await conversations.upsert(targetBareId, newRecord);
    await conversations.appendMessages(targetBareId, [storedMsg]);
  }

  await store.git.flush();

  if (options.json) {
    output.printData({ messageUrn: result.messageUrn, conversationUrn: result.backendConversationUrn || result.conversationUrn, deliveredAt: result.deliveredAt, isNewConversation });
  } else {
    output.success(`Message sent (${new Date(result.deliveredAt).toLocaleTimeString()})`);
    if (isNewConversation) output.info("  New conversation created.");
  }
}

// ---------------------------------------------------------------------------
// Target resolution
// ---------------------------------------------------------------------------

interface ResolvedTarget {
  bareConvId?: string;
  contactProfileUrn?: string;
  contactSlug?: string;
  contactFirstName?: string | null;
  contactLastName?: string | null;
  isNewConversation?: boolean;
  error?: string;
}

async function resolveTarget(
  target: string,
  myProfileUrn: string,
  apiClient: ReturnType<typeof buildApiClient>,
  conversations: ConversationStore,
): Promise<ResolvedTarget> {
  // Case 1: Direct URN
  if (isUrn(target)) {
    const bare = extractBareConvId(target);
    if (await conversations.exists(bare)) return { bareConvId: bare, isNewConversation: false };
    const found = await conversations.findByUrn(target);
    return { bareConvId: found?.convId, isNewConversation: false };
  }

  // Case 2: Slug or URL — try symlink first
  let contactSlug: string;
  try {
    contactSlug = slugFromUrl(target);
  } catch {
    return { error: `Cannot resolve target: "${target}". Use a LinkedIn URL, profile slug, or URN.` };
  }

  // Try resolving as a conversation symlink directly
  const directBareId = await conversations.resolve(contactSlug);
  if (directBareId) return { bareConvId: directBareId, contactSlug, isNewConversation: false };

  // Try to find a conversation by profile URN via local store
  let contactUrn: string | null = null;

  // If not in local store, query LinkedIn API
  let contactFirstName: string | null = null;
  let contactLastName: string | null = null;
  if (!contactUrn) {
    output.info(`Looking up profile "${contactSlug}" on LinkedIn...`);
    const fetched = await getProfileDataBySlug(apiClient, contactSlug);
    if (!fetched) {
      return { error: `Profile "${contactSlug}" not found on LinkedIn.` };
    }
    contactUrn = fetched.urn;
    contactFirstName = fetched.firstName;
    contactLastName = fetched.lastName;
  }

  // Look for existing conversation with this contact
  const localConv = await conversations.findByProfileUrn(contactUrn);
  if (localConv) return { bareConvId: localConv.convId, contactProfileUrn: contactUrn, contactSlug, isNewConversation: false };

  // Query LinkedIn API for existing conversation
  output.info("Checking for existing conversation on LinkedIn...");
  const liConv = await findConversationByRecipient(apiClient, contactUrn, myProfileUrn);
  if (liConv) {
    const bare = extractBareConvId(liConv.backendUrn || liConv.urn);
    return { bareConvId: bare, contactProfileUrn: contactUrn, contactSlug, isNewConversation: false };
  }

  return { contactProfileUrn: contactUrn, contactSlug, contactFirstName, contactLastName, isNewConversation: true };
}

// ---------------------------------------------------------------------------
// Pre-send sync
// ---------------------------------------------------------------------------

async function preSendSync(
  apiClient: ReturnType<typeof buildApiClient>,
  conversations: ConversationStore,
  bareConvId: string,
  myProfileUrn: string
): Promise<StoredMessage[]> {
  const existing = await conversations.read(bareConvId);
  const knownNewestAt = existing?.syncState.newestMessageAt ?? 0;
  const convUrn = existing?.backendUrn ?? existing?.convUrn ?? bareConvId;

  try {
    const { messages } = await fetchMessages(apiClient, convUrn, myProfileUrn, Date.now(), 10);

    // Store all new messages (inbound + outbound) since last sync
    const newMessages = messages.filter((m) => m.deliveredAt > knownNewestAt);

    if (newMessages.length > 0) {
      const myId = profileUrnId(myProfileUrn);
      const stored: StoredMessage[] = newMessages.map((m) => ({
        urn: m.urn,
        timestamp: m.deliveredAt,
        fromUrn: m.fromUrn,
        fromName: m.fromName ?? "",
        isFromMe: m.fromUrn.includes(myId),
        body: m.body,
        reactions: m.reactions,
        attachments: m.attachments.map((a) => ({ type: a.type as StoredMessage["attachments"][number]["type"], url: a.url, name: a.name, mimeType: a.mimeType, raw: a.raw })),
        originToken: null,
      }));
      await conversations.appendMessages(bareConvId, stored);
      await conversations.updateSyncState(bareConvId, { newestMessageAt: Math.max(...newMessages.map((m) => m.deliveredAt)) });

      // Only flag inbound messages that are newer than the most recent outbound.
      // If the user already replied after the inbounds, they've seen the context.
      const newestOutboundAt = Math.max(
        knownNewestAt,
        ...newMessages.filter((m) => m.fromUrn.includes(myId)).map((m) => m.deliveredAt),
        0
      );
      const unseenInbounds = stored.filter((m) => !m.isFromMe && m.timestamp > newestOutboundAt);
      return unseenInbounds;
    }
    return [];
  } catch {
    return [];
  }
}
