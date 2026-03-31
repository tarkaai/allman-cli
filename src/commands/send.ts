/**
 * lilac send — send a message to a LinkedIn contact.
 *
 * Contact resolution order:
 *   1. Direct conversation URN (urn:li:msg_conversation:... or urn:li:messagingThread:...)
 *   2. LinkedIn profile URL (https://linkedin.com/in/slug)
 *   3. Profile slug (e.g. "sarah-chen") → look up in contacts store
 *
 * Before sending:
 *   - Pre-send sync: fetch last 5 messages to detect new inbounds
 *   - Warn on stderr if new inbound messages were received
 *   - Enforce rate limit (min 3s between sends, configurable)
 *
 * Thread creation:
 *   - If no existing conversation found, create a new thread
 *   - Graceful error messages for NOT_CONNECTED / MESSAGING_BLOCKED / PREMIUM_REQUIRED
 */

import { Store, resolveStorePath } from "../store/index.js";
import { buildApiClient, LinkedInError } from "../linkedin/api/client.js";
import { loadCookieJar, serializeCookieJar } from "../linkedin/api/cookies.js";
import { findConversationByRecipient } from "../linkedin/api/endpoints/conversations.js";
import { fetchMessages, sendMessage, sendFirstMessage } from "../linkedin/api/endpoints/messages.js";
import { getProfileUrnBySlug } from "../linkedin/api/endpoints/profiles.js";
import { getRateLimiter } from "../utils/rate-limiter.js";
import { isUrn, profileUrnId } from "../utils/urn.js";
import { slugFromUrl, conversationSlug } from "../utils/slug.js";
import * as output from "../utils/output.js";
import type { ConversationRecord, StoredMessage } from "../store/types.js";

export interface SendOptions {
  account?: string;
  store?: string;
  json?: boolean;
}

export async function sendCommand(
  target: string,
  text: string,
  options: SendOptions
): Promise<void> {
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

  const myProfileUrn = accountRecord.urn;
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

  // Resolve target to a conversation URN
  const resolved = await resolveTarget(target, myProfileUrn, apiClient, store, accountSlug);

  if (resolved.error) {
    output.error(resolved.error, 1);
    return;
  }

  const { conversationUrn, contactProfileUrn, conversationSlugLocal, isNewConversation } =
    resolved;

  // Pre-send sync: check for new inbound messages
  if (conversationUrn && !isNewConversation) {
    const newInbounds = await preSendSync(
      apiClient,
      store,
      conversationSlugLocal!,
      conversationUrn,
      myProfileUrn,
      accountSlug
    );
    if (newInbounds > 0) {
      output.warn(
        `${newInbounds} new inbound message(s) received before send. ` +
          `Run \`lilac messages ${conversationSlugLocal}\` to review.`
      );
    }
  }

  // Enforce rate limit
  const minIntervalMs = accountConfig.rateLimit?.minMessageIntervalMs;
  const rateLimiter = getRateLimiter(accountSlug, minIntervalMs);
  const remaining = rateLimiter.remainingMs();
  if (remaining > 0) {
    output.debug(`Rate limit: waiting ${remaining}ms...`);
  }
  await rateLimiter.acquire();

  // Send the message
  let result: { messageUrn: string; conversationUrn: string; backendConversationUrn: string; deliveredAt: number };

  try {
    if (isNewConversation && contactProfileUrn) {
      output.info("Starting new conversation...");
      result = await sendFirstMessage(apiClient, contactProfileUrn, myProfileUrn, text);
    } else if (conversationUrn) {
      result = await sendMessage(apiClient, conversationUrn, myProfileUrn, text);
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
  const targetSlug = conversationSlugLocal ?? "unknown";
  const storedMsg: StoredMessage = {
    urn: result.messageUrn,
    timestamp: result.deliveredAt,
    fromUrn: myProfileUrn,
    fromName: accountRecord.name ?? "",
    fromSlug: accountSlug,
    isFromMe: true,
    body: text,
    reactions: [],
    attachments: [],
    originToken: null,
  };

  if (await store.conversations.exists(targetSlug)) {
    await store.conversations.appendMessages(targetSlug, [storedMsg]);
  } else if (result.backendConversationUrn) {
    // New conversation created — build a minimal RECORD
    const newRecord: ConversationRecord = {
      urn: result.conversationUrn,
      backendUrn: result.backendConversationUrn,
      title: contactProfileUrn ? `urn:${contactProfileUrn.split(":").pop()}` : "New conversation",
      isGroup: false,
      account: accountSlug,
      participants: [
        { slug: accountSlug, urn: myProfileUrn, name: accountRecord.name ?? "" },
      ],
      unreadCount: 0,
      lastActivityAt: new Date(result.deliveredAt).toISOString(),
      createdAt: new Date(result.deliveredAt).toISOString(),
      syncState: {
        oldestMessageAt: result.deliveredAt,
        newestMessageAt: result.deliveredAt,
        lastSyncAt: new Date().toISOString(),
        totalSynced: 1,
        fullyBackfilled: false,
      },
    };
    await store.conversations.upsert(targetSlug, newRecord);
    await store.conversations.appendMessages(targetSlug, [storedMsg]);
  }

  await store.git.flush();

  if (options.json) {
    output.printData({
      messageUrn: result.messageUrn,
      conversationUrn: result.backendConversationUrn || result.conversationUrn,
      deliveredAt: result.deliveredAt,
      isNewConversation,
    });
  } else {
    output.success(`Message sent (${new Date(result.deliveredAt).toLocaleTimeString()})`);
    if (isNewConversation) output.info("  New conversation created.");
  }
}

// ---------------------------------------------------------------------------
// Target resolution
// ---------------------------------------------------------------------------

interface ResolvedTarget {
  conversationUrn?: string;
  contactProfileUrn?: string;
  conversationSlugLocal?: string;
  isNewConversation?: boolean;
  error?: string;
}

async function resolveTarget(
  target: string,
  myProfileUrn: string,
  apiClient: ReturnType<typeof buildApiClient>,
  store: Store,
  accountSlug: string
): Promise<ResolvedTarget> {
  // Case 1: Direct URN
  if (isUrn(target)) {
    const existing = await store.conversations.findByUrn(target);
    return {
      conversationUrn: target,
      conversationSlugLocal: existing?.slug,
      isNewConversation: false,
    };
  }

  // Case 2: LinkedIn URL or slug → resolve to contact URN
  let contactSlug: string;
  try {
    contactSlug = slugFromUrl(target);
  } catch {
    return { error: `Cannot resolve target: "${target}". Use a LinkedIn URL, profile slug, or URN.` };
  }

  // Check if there's already a local conversation stored under this slug
  const directConv = await store.conversations.read(contactSlug);
  if (directConv) {
    return {
      conversationUrn: directConv.backendUrn ?? directConv.urn,
      contactProfileUrn: directConv.participants.find((p) => p.slug !== accountSlug)?.urn,
      conversationSlugLocal: contactSlug,
      isNewConversation: false,
    };
  }

  // Look up contact in local store first
  const localContact = await store.contacts.read(contactSlug);
  let contactUrn = localContact?.urn;

  // If not in local store, query LinkedIn API
  if (!contactUrn) {
    output.info(`Looking up profile "${contactSlug}" on LinkedIn...`);
    const fetched = await getProfileUrnBySlug(apiClient, contactSlug);
    if (!fetched) {
      return {
        error:
          `Profile "${contactSlug}" not found on LinkedIn. ` +
          `Check the spelling or run \`lilac sync\` first to populate the contact list.`,
      };
    }
    contactUrn = fetched;
  }

  // Look for existing conversation with this contact in local store
  const localConv = await store.conversations.findByParticipantUrn(contactUrn, accountSlug);
  if (localConv) {
    return {
      conversationUrn: localConv.record.backendUrn ?? localConv.record.urn,
      contactProfileUrn: contactUrn,
      conversationSlugLocal: localConv.slug,
      isNewConversation: false,
    };
  }

  // Query LinkedIn API for existing conversation
  output.info("Checking for existing conversation on LinkedIn...");
  const liConv = await findConversationByRecipient(apiClient, contactUrn, myProfileUrn);

  if (liConv) {
    const slug = conversationSlug(
      liConv.title ?? contactSlug,
      liConv.isGroup
    );
    return {
      conversationUrn: liConv.backendUrn || liConv.urn,
      contactProfileUrn: contactUrn,
      conversationSlugLocal: slug,
      isNewConversation: false,
    };
  }

  // No existing conversation — will create a new one
  const newSlug = conversationSlug(contactSlug, false);
  return {
    contactProfileUrn: contactUrn,
    conversationSlugLocal: newSlug,
    isNewConversation: true,
  };
}

// ---------------------------------------------------------------------------
// Pre-send sync
// ---------------------------------------------------------------------------

async function preSendSync(
  apiClient: ReturnType<typeof buildApiClient>,
  store: Store,
  slug: string,
  conversationUrn: string,
  myProfileUrn: string,
  accountSlug: string
): Promise<number> {
  const existingRecord = await store.conversations.read(slug);
  const knownNewestAt = existingRecord?.syncState.newestMessageAt ?? 0;

  try {
    const { messages } = await fetchMessages(
      apiClient,
      conversationUrn,
      myProfileUrn,
      Date.now(),
      5 // only check the last 5 messages
    );

    const newInbounds = messages.filter(
      (m) =>
        m.deliveredAt > knownNewestAt &&
        m.fromUrn !== myProfileUrn &&
        !m.fromUrn.includes(profileUrnId(myProfileUrn))
    );

    if (newInbounds.length > 0) {
      const stored: StoredMessage[] = newInbounds.map((m) => ({
        urn: m.urn,
        timestamp: m.deliveredAt,
        fromUrn: m.fromUrn,
        fromName: m.fromName ?? "",
        fromSlug: accountSlug,
        isFromMe: false,
        body: m.body,
        reactions: m.reactions,
        attachments: m.attachments.map((a) => ({
          type: a.type as StoredMessage["attachments"][number]["type"],
          url: a.url,
          name: a.name,
          mimeType: a.mimeType,
          raw: a.raw,
        })),
        originToken: null,
      }));

      await store.conversations.appendMessages(slug, stored);
      await store.conversations.updateSyncState(slug, {
        newestMessageAt: Math.max(...newInbounds.map((m) => m.deliveredAt)),
      });
    }

    return newInbounds.length;
  } catch {
    // Pre-send sync failure is non-fatal
    return 0;
  }
}
