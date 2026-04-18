/**
 * allman react — add (or remove) an emoji reaction to a message in a conversation.
 *
 * Usage:
 *   allman react <target> <emoji>            react to the most recent message
 *   allman react <target> <emoji> --message <urn>
 *   allman react <target> <emoji> --unreact  remove your reaction
 */

import { LinkedInError } from "../linkedin/api/client.js";
import { addReaction, removeReaction } from "../linkedin/api/endpoints/messages.js";
import { loadSession } from "../linkedin/api/session.js";
import type { ConversationStore } from "../store/index.js";
import { resolveStorePath, Store } from "../store/index.js";
import type { StoredMessage } from "../store/types.js";
import * as output from "../utils/output.js";
import { slugFromUrl } from "../utils/slug.js";
import { extractBareConvId, isUrn } from "../utils/urn.js";

export interface ReactOptions {
  account?: string;
  store?: string;
  json?: boolean;
  /** Message URN to react to. Defaults to the most recent message in the conversation. */
  message?: string;
  /** Remove a reaction instead of adding. */
  unreact?: boolean;
}

export async function reactCommand(
  target: string,
  emoji: string,
  options: ReactOptions
): Promise<void> {
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

  // Pick the message to react to.
  const messages = await conversations.readMessages(bareConvId, { limit: 50 });
  if (messages.length === 0) {
    output.error("No messages in this conversation yet.", 1);
    return;
  }

  const wantedMessage = options.message;
  const picked = wantedMessage
    ? messages.find((m) => normalizeMsgId(m.urn) === normalizeMsgId(wantedMessage))
    : messages[messages.length - 1];

  if (!picked) {
    output.error(
      options.message
        ? `Message "${options.message}" not found locally. Try \`allman sync ${target}\`.`
        : "Could not select a message.",
      1
    );
    return;
  }

  try {
    if (options.unreact) {
      await removeReaction(apiClient, picked.urn, myProfileUrn, emoji);
    } else {
      await addReaction(apiClient, picked.urn, myProfileUrn, emoji);
    }
  } catch (err) {
    if (err instanceof LinkedInError) {
      output.error(err.message, 1);
    } else {
      output.error(`Reaction failed: ${String(err)}`, 1);
    }
    return;
  }

  // Update the local JSONL's reactions array so reads reflect the change
  // without needing a sync round-trip.
  const nextReactions = applyReactionChange(picked.reactions, emoji, !options.unreact);
  await conversations.updateMessage(bareConvId, picked.urn, { reactions: nextReactions });
  await store.git.flush();

  if (options.json) {
    output.printData({
      messageUrn: picked.urn,
      emoji,
      action: options.unreact ? "removed" : "added",
      reactions: nextReactions,
    });
  } else {
    const verb = options.unreact ? "Removed" : "Added";
    const preview = picked.body.slice(0, 60).replace(/\n/g, " ");
    output.success(`${verb} ${emoji} on "${preview}${picked.body.length > 60 ? "…" : ""}"`);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

/** Last segment of a URN (or everything after the last comma for composites). */
function normalizeMsgId(urn: string): string {
  const lastComma = urn.lastIndexOf(",");
  if (lastComma !== -1) return urn.slice(lastComma + 1).replace(/\)$/, "");
  const lastColon = urn.lastIndexOf(":");
  return lastColon !== -1 ? urn.slice(lastColon + 1) : urn;
}

/**
 * Locally apply a reaction change to the stored reactions array so reads
 * reflect the update without a sync.
 */
function applyReactionChange(
  current: StoredMessage["reactions"],
  emoji: string,
  add: boolean
): StoredMessage["reactions"] {
  const existing = current.find((r) => r.emoji === emoji);
  if (add) {
    if (existing?.hasUserReacted) return current;
    if (existing) {
      return current.map((r) =>
        r.emoji === emoji ? { ...r, count: r.count + 1, hasUserReacted: true } : r
      );
    }
    return [...current, { emoji, count: 1, hasUserReacted: true }];
  }
  // remove
  if (!existing?.hasUserReacted) return current;
  if (existing.count <= 1) return current.filter((r) => r.emoji !== emoji);
  return current.map((r) =>
    r.emoji === emoji ? { ...r, count: r.count - 1, hasUserReacted: false } : r
  );
}
