/**
 * Build a `ConversationRecord` from a LinkedIn conversation payload.
 *
 * Shared by `sync` and `listen` so both write the exact same shape for 1:1
 * and group threads. The 1:1 shape is unchanged from before group support;
 * group records add `isGroup`, `title` and `participants` on top of it and
 * fill the single-contact fields from the first other participant so readers
 * written for 1:1 records keep working.
 */

import type {
  ConversationData,
  ConversationParticipantData,
} from "../linkedin/api/endpoints/conversations.js";
import { extractBareConvId } from "../utils/urn.js";
import type { ConversationStore } from "./conversations.js";
import type { ConversationParticipant, ConversationRecord } from "./types.js";

/**
 * Upper bound on per-profile slug lookups for a single group per sync. A big
 * group would otherwise burst one request per member; anything past the cap
 * stays `slug: null` and is retried only once the record is next rebuilt.
 */
export const MAX_GROUP_SLUG_LOOKUPS = 10;

/** Resolve a profile's public slug (publicIdentifier) from its profile ID. */
export type SlugResolver = (profileId: string) => Promise<string | null>;

export interface BuildRecordOptions {
  conv: ConversationData;
  myProfileUrn: string;
  /** The record already in the store, if any — slugs and sync state are reused. */
  existing: ConversationRecord | null;
  /** Used to look up slugs already known from local 1:1 records. */
  conversations: ConversationStore;
  resolveSlug: SlugResolver;
  /** Cap on group participant slug lookups via `resolveSlug`. */
  maxGroupSlugLookups?: number;
}

export function splitName(name: string): { firstName: string; lastName: string } {
  const spaceIdx = name.indexOf(" ");
  if (spaceIdx === -1) return { firstName: name, lastName: "" };
  return { firstName: name.slice(0, spaceIdx), lastName: name.slice(spaceIdx + 1) };
}

export function profileIdFromUrn(profileUrn: string): string {
  return profileUrn.replace("urn:li:fsd_profile:", "");
}

/** Display name for a group: LinkedIn's title, else the members' names. */
export function groupName(
  title: string | null | undefined,
  participants: Array<{ name: string }>
): string {
  const t = title?.trim();
  if (t) return t;
  const names = participants.map((p) => p.name).filter((n) => n.length > 0);
  return names.length > 0 ? names.join(", ") : "Group conversation";
}

export function toParticipant(
  p: ConversationParticipantData,
  slug: string | null
): ConversationParticipant {
  const fullName = p.name ?? "Unknown";
  const { firstName, lastName } = splitName(fullName);
  return {
    profileId: profileIdFromUrn(p.entityUrn),
    profileUrn: p.entityUrn,
    backendUrn: p.backendUrn,
    slug,
    firstName,
    lastName,
    name: fullName,
    headline: p.headline ?? null,
    profileUrl: p.profileUrl ?? null,
    profilePictures: p.profilePictures.length > 0 ? p.profilePictures : null,
    distance: p.distance,
    pronoun: p.pronoun,
    memberBadgeType: p.memberBadgeType,
    isPremium: p.isPremium,
    isVerified: p.isVerified,
  };
}

/**
 * Slug for a person already known locally through their 1:1 thread: the
 * `{profileId}` alias points at that conversation, whose record carries the
 * resolved slug. Group records never create aliases, so a hit here is always
 * a real 1:1 record.
 */
async function localSlugForProfile(
  conversations: ConversationStore,
  profileId: string
): Promise<string | null> {
  const convId = await conversations.resolve(profileId);
  if (!convId) return null;
  const record = await conversations.read(convId);
  if (!record || record.isGroup) return null;
  return record.slug ?? null;
}

/**
 * Resolve slugs for a group's participants with a bounded number of API
 * lookups. Preference order per participant:
 *   1. the entry already stored on the existing record (resolved once, cached
 *      even when null so a re-sync never re-bursts the same lookups);
 *   2. the local 1:1 record for that person, if any;
 *   3. `resolveSlug`, at most `maxLookups` times per call.
 */
export async function resolveParticipantSlugs(
  conversations: ConversationStore,
  participants: ConversationParticipantData[],
  existing: ConversationRecord | null,
  resolveSlug: SlugResolver,
  maxLookups: number = MAX_GROUP_SLUG_LOOKUPS
): Promise<Map<string, string | null>> {
  const cached = new Map<string, string | null>();
  for (const p of existing?.participants ?? []) cached.set(p.profileUrn, p.slug);

  const slugs = new Map<string, string | null>();
  let lookups = 0;
  for (const p of participants) {
    if (cached.has(p.entityUrn)) {
      slugs.set(p.entityUrn, cached.get(p.entityUrn) ?? null);
      continue;
    }
    const profileId = profileIdFromUrn(p.entityUrn);
    const local = await localSlugForProfile(conversations, profileId);
    if (local) {
      slugs.set(p.entityUrn, local);
      continue;
    }
    if (lookups >= maxLookups) {
      slugs.set(p.entityUrn, null);
      continue;
    }
    lookups++;
    slugs.set(p.entityUrn, await resolveSlug(profileId));
  }
  return slugs;
}

/**
 * Build the record for one conversation. Returns null when the thread has no
 * other participant to describe (nothing useful to store).
 */
export async function buildConversationRecord(
  opts: BuildRecordOptions
): Promise<ConversationRecord | null> {
  const { conv, myProfileUrn, existing, conversations, resolveSlug } = opts;
  const convId = extractBareConvId(conv.backendUrn || conv.urn);
  const others = conv.participants.filter((p) => p.entityUrn !== myProfileUrn);
  const first = others[0];
  if (!first) return null;

  // Contact fields come from the first other participant for both shapes.
  let slug: string | null;
  let participants: ConversationParticipant[] | undefined;
  if (conv.isGroup) {
    const slugs = await resolveParticipantSlugs(
      conversations,
      others,
      existing,
      resolveSlug,
      opts.maxGroupSlugLookups
    );
    participants = others.map((p) => toParticipant(p, slugs.get(p.entityUrn) ?? null));
    slug = null;
  } else if (existing?.slug) {
    // Check the existing record first to avoid redundant API calls.
    slug = existing.slug;
  } else {
    slug = await resolveSlug(profileIdFromUrn(first.entityUrn));
  }

  const fullName = first.name ?? "Unknown";
  const { firstName, lastName } = splitName(fullName);
  const name = conv.isGroup && participants ? groupName(conv.title, participants) : fullName;

  return {
    convId,
    profileId: profileIdFromUrn(first.entityUrn),
    slug,
    ...(conv.isGroup
      ? { isGroup: true, title: conv.title ?? null, participants: participants ?? [] }
      : {}),
    convUrn: conv.urn,
    backendUrn: conv.backendUrn || null,
    profileUrn: first.entityUrn,
    memberUrn: null,
    firstName,
    lastName,
    name,
    headline: first.headline ?? null,
    profileUrl: first.profileUrl ?? null,
    profilePictures: first.profilePictures.length > 0 ? first.profilePictures : null,
    distance: first.distance,
    pronoun: first.pronoun,
    memberBadgeType: first.memberBadgeType,
    isPremium: first.isPremium,
    isVerified: first.isVerified,
    unreadCount: conv.unreadCount,
    lastActivityAt: conv.lastActivityAt ? new Date(conv.lastActivityAt).toISOString() : null,
    lastReadAt: conv.lastReadAt ? new Date(conv.lastReadAt).toISOString() : null,
    createdAt: conv.createdAt ? new Date(conv.createdAt).toISOString() : null,
    read: conv.read,
    notificationStatus: conv.notificationStatus,
    categories: conv.categories,
    conversationUrl: conv.conversationUrl,
    disabledFeatures: conv.disabledFeatures,
    syncState: existing?.syncState ?? {
      oldestMessageAt: null,
      newestMessageAt: null,
      lastSyncAt: null,
      totalSynced: 0,
      fullyBackfilled: false,
    },
    fetchedAt: new Date().toISOString(),
  };
}

/** Display name for a sender in a thread, from the record's participant list. */
export function participantName(
  record: Pick<ConversationRecord, "isGroup" | "name" | "participants" | "profileUrn"> | null,
  fromUrn: string | null | undefined
): string | null {
  if (!record) return null;
  if (!record.isGroup) return record.name;
  if (!fromUrn) return null;
  const hit = record.participants?.find(
    (p) => p.profileUrn === fromUrn || (p.backendUrn !== null && p.backendUrn === fromUrn)
  );
  return hit?.name ?? null;
}
