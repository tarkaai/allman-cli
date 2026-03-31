/**
 * lilac send — send a message to a LinkedIn contact.
 */

import { Store, resolveStorePath } from "../store/index.js";
import { buildApiClient, LinkedInError } from "../linkedin/api/client.js";
import { loadCookieJar, serializeCookieJar } from "../linkedin/api/cookies.js";
import { findConversationByRecipient } from "../linkedin/api/endpoints/conversations.js";
import { fetchMessages, sendMessage, sendFirstMessage } from "../linkedin/api/endpoints/messages.js";
import { getProfileUrnBySlug } from "../linkedin/api/endpoints/profiles.js";
import { getRateLimiter } from "../utils/rate-limiter.js";
import { isUrn, extractBareConvId, profileUrnId } from "../utils/urn.js";
import { slugFromUrl } from "../utils/slug.js";
import * as output from "../utils/output.js";
import type { ConversationRecord, StoredMessage } from "../store/types.js";
import type { ConversationStore, ContactStore } from "../store/index.js";

export interface SendOptions {
  account?: string;
  store?: string;
  json?: boolean;
}

export async function sendCommand(target: string, text: string, options: SendOptions): Promise<void> {
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

  const resolved = await resolveTarget(target, myProfileUrn, apiClient, conversations, contacts);

  if (resolved.error) {
    output.error(resolved.error, 1);
    return;
  }

  const { bareConvId, contactProfileUrn, isNewConversation } = resolved;

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

  // Rate limit
  const minIntervalMs = accountConfig.rateLimit?.minMessageIntervalMs;
  const rateLimiter = getRateLimiter(profileId, minIntervalMs);
  await rateLimiter.acquire();

  // Send
  let result: { messageUrn: string; conversationUrn: string; backendConversationUrn: string; deliveredAt: number };

  try {
    if (isNewConversation && contactProfileUrn) {
      output.info("Starting new conversation...");
      result = await sendFirstMessage(apiClient, contactProfileUrn, myProfileUrn, text);
    } else if (bareConvId) {
      const convRecord = await conversations.read(bareConvId);
      const convUrn = convRecord?.backendUrn ?? convRecord?.urn ?? bareConvId;
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
  } else if (result.backendConversationUrn) {
    const newRecord: ConversationRecord = {
      urn: result.conversationUrn,
      backendUrn: result.backendConversationUrn,
      bareId: targetBareId,
      title: contactProfileUrn ? "New conversation" : "New conversation",
      isGroup: false,
      participants: [{ profileId, urn: myProfileUrn, name: accountRecord.name ?? "", slug: accountRecord.profileSlug ?? null }],
      unreadCount: 0,
      lastActivityAt: new Date(result.deliveredAt).toISOString(),
      createdAt: new Date(result.deliveredAt).toISOString(),
      syncState: { oldestMessageAt: result.deliveredAt, newestMessageAt: result.deliveredAt, lastSyncAt: new Date().toISOString(), totalSynced: 1, fullyBackfilled: false },
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
  isNewConversation?: boolean;
  error?: string;
}

async function resolveTarget(
  target: string,
  myProfileUrn: string,
  apiClient: ReturnType<typeof buildApiClient>,
  conversations: ConversationStore,
  contacts: ContactStore
): Promise<ResolvedTarget> {
  // Case 1: Direct URN
  if (isUrn(target)) {
    const bare = extractBareConvId(target);
    if (await conversations.exists(bare)) return { bareConvId: bare, isNewConversation: false };
    const found = await conversations.findByUrn(target);
    return { bareConvId: found?.bareId, isNewConversation: false };
  }

  // Case 2: Slug or URL — try symlink first
  let contactSlug: string;
  try {
    contactSlug = slugFromUrl(target);
  } catch {
    return { error: `Cannot resolve target: "${target}". Use a LinkedIn URL, profile slug, or URN.` };
  }

  // Try resolving as a conversation symlink directly
  const directBareId = await conversations.resolveId(contactSlug);
  if (directBareId) return { bareConvId: directBareId, isNewConversation: false };

  // Look up contact profile ID
  const contactId = await contacts.resolveId(contactSlug);
  let contactUrn = contactId ? `urn:li:fsd_profile:${contactId}` : null;

  // If not in local store, query LinkedIn API
  if (!contactUrn) {
    output.info(`Looking up profile "${contactSlug}" on LinkedIn...`);
    const fetched = await getProfileUrnBySlug(apiClient, contactSlug);
    if (!fetched) {
      return { error: `Profile "${contactSlug}" not found on LinkedIn.` };
    }
    contactUrn = fetched;
  }

  // Look for existing conversation with this contact
  const localConv = await conversations.findByParticipantUrn(contactUrn);
  if (localConv) return { bareConvId: localConv.bareId, contactProfileUrn: contactUrn, isNewConversation: false };

  // Query LinkedIn API for existing conversation
  output.info("Checking for existing conversation on LinkedIn...");
  const liConv = await findConversationByRecipient(apiClient, contactUrn, myProfileUrn);
  if (liConv) {
    const bare = extractBareConvId(liConv.backendUrn || liConv.urn);
    return { bareConvId: bare, contactProfileUrn: contactUrn, isNewConversation: false };
  }

  return { contactProfileUrn: contactUrn, isNewConversation: true };
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
  const convUrn = existing?.backendUrn ?? existing?.urn ?? bareConvId;

  try {
    const { messages } = await fetchMessages(apiClient, convUrn, myProfileUrn, Date.now(), 5);
    const newInbounds = messages.filter(
      (m) => m.deliveredAt > knownNewestAt && !m.fromUrn.includes(profileUrnId(myProfileUrn))
    );

    if (newInbounds.length > 0) {
      const stored: StoredMessage[] = newInbounds.map((m) => ({
        urn: m.urn,
        timestamp: m.deliveredAt,
        fromUrn: m.fromUrn,
        fromName: m.fromName ?? "",
        isFromMe: false,
        body: m.body,
        reactions: m.reactions,
        attachments: m.attachments.map((a) => ({ type: a.type as StoredMessage["attachments"][number]["type"], url: a.url, name: a.name, mimeType: a.mimeType, raw: a.raw })),
        originToken: null,
      }));
      await conversations.appendMessages(bareConvId, stored);
      await conversations.updateSyncState(bareConvId, { newestMessageAt: Math.max(...newInbounds.map((m) => m.deliveredAt)) });
      return stored;
    }
    return [];
  } catch {
    return [];
  }
}
