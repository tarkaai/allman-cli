/**
 * allman read — mark a conversation as read on LinkedIn (and locally).
 *
 * Usage:
 *   allman read <target>          target: slug, LinkedIn URL, or conversation URN
 *   allman read <target> --json
 *
 * Front-ends (TUI, Mac app) call this when a thread is opened so the unread
 * state on linkedin.com matches what the user has actually seen.
 */

import { LinkedInError } from "../linkedin/api/client.js";
import { markConversationsRead } from "../linkedin/api/endpoints/conversations.js";
import { loadSession } from "../linkedin/api/session.js";
import type { ConversationStore } from "../store/index.js";
import { resolveStorePath, Store } from "../store/index.js";
import * as output from "../utils/output.js";
import { slugFromUrl } from "../utils/slug.js";
import { extractBareConvId, isUrn } from "../utils/urn.js";

export interface ReadOptions {
  account?: string;
  store?: string;
  json?: boolean;
}

export async function readCommand(target: string, options: ReadOptions): Promise<void> {
  const storePath = resolveStorePath(options.store);
  const store = new Store({ path: storePath });
  await store.init();

  let session: Awaited<ReturnType<typeof loadSession>>;
  try {
    session = await loadSession(store, options.account);
  } catch (err) {
    output.error(String((err as Error).message), 1);
    return;
  }
  const { apiClient, profileId, myProfileUrn } = session;
  const conversations = store.forAccount(profileId);

  const bareConvId = await resolveConversation(target, conversations);
  if (!bareConvId) {
    output.error(`Conversation "${target}" not found locally. Run \`allman sync\` first.`, 1);
    return;
  }
  const record = await conversations.read(bareConvId);
  if (!record) {
    output.error(`Conversation record not found for "${bareConvId}".`, 1);
    return;
  }

  // The seen action wants the msg_conversation URN; older records may only
  // carry the backend thread URN, so rebuild it from our own profile URN.
  const conversationUrn = record.convUrn?.startsWith("urn:li:msg_conversation:")
    ? record.convUrn
    : `urn:li:msg_conversation:(${myProfileUrn},${bareConvId})`;

  try {
    await markConversationsRead(apiClient, [conversationUrn]);
  } catch (err) {
    if (err instanceof LinkedInError) {
      output.error(err.message, 1);
    } else {
      output.error(`Mark read failed: ${String(err)}`, 1);
    }
    return;
  }

  const readAt = new Date().toISOString();
  await conversations.upsert(bareConvId, {
    ...record,
    read: true,
    unreadCount: 0,
    lastReadAt: readAt,
  });
  await store.git.flush();

  if (options.json) {
    output.printData({ convId: bareConvId, slug: record.slug, conversationUrn, readAt });
  } else {
    output.success(`Marked ${record.name ?? bareConvId} as read`);
  }
}

async function resolveConversation(
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
