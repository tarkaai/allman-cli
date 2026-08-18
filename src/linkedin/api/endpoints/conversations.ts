/**
 * LinkedIn conversation API endpoints.
 *
 * All conversation fetching uses GraphQL (not REST).
 * LinkedIn returns normalized JSON: top-level `data` (with URN refs in `*elements`)
 * and `included` (flat array of all referenced objects).
 *
 * Query IDs (from monorepo):
 *   messengerConversations.45338e053010d1c19147f92de6de3ae6  — list by inbox
 *   messengerConversations.44030325d8f59d8cebbb804f16d6b0a3  — by recipients (find/create)
 *
 * Source: monorepo/lib/services/.../linkedin-api-services.ts
 */

import { encodeUrn } from "../../../utils/urn.js";
import type { LinkedInApiClient } from "../client.js";

const GRAPHQL_URL = "https://www.linkedin.com/voyager/api/voyagerMessagingGraphQL/graphql";

const QUERY_ID_LIST = "messengerConversations.45338e053010d1c19147f92de6de3ae6";
const QUERY_ID_BY_RECIPIENTS = "messengerConversations.44030325d8f59d8cebbb804f16d6b0a3";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ConversationParticipantData {
  entityUrn: string;
  name: string | null;
  profileUrl: string | null;
  /** Smallest available avatar — the one list UIs want. */
  imageUrl: string | null;
  headline: string | null;
  /** Every avatar size LinkedIn offers, largest last. */
  profilePictures: ConversationProfilePicture[];
  /** DISTANCE_1 / DISTANCE_2 / DISTANCE_3 / OUT_OF_NETWORK / SELF. */
  distance: string | null;
  /** Standardized pronoun, e.g. "HE_HIM". Null when unset or custom. */
  pronoun: string | null;
  /** e.g. "PREMIUM_PROFILE", "VERIFIED_PROFILE", "INFLUENCER". */
  memberBadgeType: string | null;
  isPremium: boolean;
  isVerified: boolean;
  /** `urn:li:msg_messagingParticipant:…` — the participant, not the person. */
  backendUrn: string | null;
}

export interface ConversationProfilePicture {
  width: number;
  height: number;
  url: string;
}

export interface ConversationData {
  /** Frontend URN: urn:li:msg_conversation:... */
  urn: string;
  /** Backend URN: urn:li:messagingThread:... */
  backendUrn: string;
  title: string | null;
  isGroup: boolean;
  lastActivityAt: number | null;
  unreadCount: number;
  participants: ConversationParticipantData[];
  /** Unix ms the thread was created — the true "first contact" date. */
  createdAt: number | null;
  /** Unix ms you last read the thread. */
  lastReadAt: number | null;
  /** LinkedIn's own read flag, which is not always `unreadCount === 0`. */
  read: boolean;
  /** ACTIVE / MUTED. */
  notificationStatus: string | null;
  /** e.g. ["INBOX", "PRIMARY_INBOX"], or ["INBOX", "OTHER"] for the Other tab. */
  categories: string[];
  /** Direct link to the thread on linkedin.com. */
  conversationUrl: string | null;
  /** e.g. ["ADD_PARTICIPANT", "REMOVE_PARTICIPANT"]. */
  disabledFeatures: string[];
}

// ---------------------------------------------------------------------------
// Raw response shapes (normalized JSON)
// ---------------------------------------------------------------------------

interface NormalizedResponse {
  data?: {
    data?: {
      messengerConversationsByCategoryQuery?: {
        metadata?: { nextCursor?: string };
        "*elements"?: string[];
      };
      messengerConversationsByRecipients?: {
        "*elements"?: string[];
      };
    };
  };
  included?: Array<Record<string, unknown>>;
}

interface ConversationRaw {
  $type?: string;
  entityUrn?: string;
  backendUrn?: string;
  title?: string | null;
  groupChat?: boolean;
  lastActivityAt?: number;
  unreadCount?: number;
  createdAt?: number;
  lastReadAt?: number;
  read?: boolean;
  notificationStatus?: string | null;
  categories?: string[];
  conversationUrl?: string | null;
  disabledFeatures?: Array<{ disabledFeature?: string }>;
  "*conversationParticipants"?: string[];
}

interface ParticipantRaw {
  $type?: string;
  entityUrn?: string;
  backendUrn?: string;
  hostIdentityUrn?: string;
  memberBadgeType?: string | null;
  showPremiumInBug?: boolean;
  showVerificationBadge?: boolean;
  participantType?: {
    member?: {
      firstName?: { text?: string };
      lastName?: { text?: string };
      headline?: { text?: string };
      profileUrl?: string;
      distance?: string | null;
      pronoun?: { standardizedPronoun?: string | null; customPronoun?: string | null } | null;
      profilePicture?: {
        rootUrl?: string;
        artifacts?: Array<{
          fileIdentifyingUrlPathSegment?: string;
          width?: number;
          height?: number;
        }>;
      };
    };
  };
}

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

/**
 * Fetch a page of conversations from the LinkedIn inbox.
 */
export async function listConversations(
  client: LinkedInApiClient,
  myProfileUrn: string,
  lastUpdatedBefore: number = Date.now(),
  nextCursor?: string
): Promise<{ conversations: ConversationData[]; nextCursor: string | null }> {
  const profileId = myProfileUrn.replace("urn:li:fsd_profile:", "");
  const paginationPart = nextCursor
    ? `nextCursor:${nextCursor}`
    : `lastUpdatedBefore:${lastUpdatedBefore}`;

  // Variables passed raw — only inner URN values are percent-encoded.
  // Use INBOX (not PRIMARY_INBOX) to capture all conversations including
  // message requests and non-connection messages. PRIMARY_INBOX is LinkedIn's
  // "Focused" tab — a subset of INBOX — and misses connection-request threads.
  const variables = `(query:(predicateUnions:List((conversationCategoryPredicate:(category:INBOX)))),count:20,mailboxUrn:${encodeUrn(`urn:li:fsd_profile:${profileId}`)},${paginationPart})`;

  const response = await client.request<NormalizedResponse>({
    method: "GET",
    url: `${GRAPHQL_URL}?queryId=${QUERY_ID_LIST}&variables=${variables}`,
  });

  const query = response?.data?.data?.messengerConversationsByCategoryQuery;
  return {
    conversations: parseConversationsResponse(response),
    nextCursor: query?.metadata?.nextCursor ?? null,
  };
}

/**
 * Turn a normalized conversations response into records.
 * Pure function — exposed for unit testing.
 */
export function parseConversationsResponse(response: NormalizedResponse): ConversationData[] {
  const included = buildIncludedMap(response.included);
  const roots = response?.data?.data;
  const convUrns =
    roots?.messengerConversationsByCategoryQuery?.["*elements"] ??
    roots?.messengerConversationsByRecipients?.["*elements"] ??
    [];
  return convUrns.flatMap((urn) => {
    const c = parseConversation(urn, included);
    return c ? [c] : [];
  });
}

/**
 * Find an existing conversation with a specific contact, or return null.
 */
export async function findConversationByRecipient(
  client: LinkedInApiClient,
  contactProfileUrn: string,
  myProfileUrn: string
): Promise<ConversationData | null> {
  const contactId = contactProfileUrn.replace("urn:li:fsd_profile:", "");
  const myId = myProfileUrn.replace("urn:li:fsd_profile:", "");

  const variables = `(recipients:List(${encodeUrn(`urn:li:fsd_profile:${contactId}`)}),mailboxUrn:${encodeUrn(`urn:li:fsd_profile:${myId}`)},count:20)`;

  const response = await client.request<NormalizedResponse>({
    method: "GET",
    url: `${GRAPHQL_URL}?queryId=${QUERY_ID_BY_RECIPIENTS}&variables=${variables}`,
  });

  const included = buildIncludedMap(response.included);
  const convUrns = response?.data?.data?.messengerConversationsByRecipients?.["*elements"] ?? [];

  for (const urn of convUrns) {
    const c = parseConversation(urn, included);
    if (!c) continue;
    if (c.participants.length === 2) {
      const urns = c.participants.map((p) => p.entityUrn);
      if (urns.includes(contactProfileUrn) && urns.includes(myProfileUrn)) {
        return c;
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

function buildIncludedMap(
  included: Array<Record<string, unknown>> | undefined
): Map<string, Record<string, unknown>> {
  const map = new Map<string, Record<string, unknown>>();
  for (const item of included ?? []) {
    const urn = item.entityUrn;
    if (typeof urn === "string") map.set(urn, item);
  }
  return map;
}

function parseConversation(
  urn: string,
  included: Map<string, Record<string, unknown>>
): ConversationData | null {
  const raw = included.get(urn) as ConversationRaw | undefined;
  if (!raw) return null;

  const participantUrns = (raw["*conversationParticipants"] as string[] | undefined) ?? [];
  const participants = participantUrns.flatMap((pUrn) => {
    const p = parseParticipant(pUrn, included);
    return p ? [p] : [];
  });

  return {
    urn: raw.entityUrn ?? urn,
    backendUrn: raw.backendUrn ?? "",
    title: raw.title ?? null,
    isGroup: raw.groupChat ?? false,
    lastActivityAt: raw.lastActivityAt ?? null,
    unreadCount: raw.unreadCount ?? 0,
    participants,
    createdAt: typeof raw.createdAt === "number" ? raw.createdAt : null,
    lastReadAt: typeof raw.lastReadAt === "number" ? raw.lastReadAt : null,
    // Prefer LinkedIn's own flag; fall back to the count only when it is absent.
    read: typeof raw.read === "boolean" ? raw.read : (raw.unreadCount ?? 0) === 0,
    notificationStatus: raw.notificationStatus ?? null,
    categories: Array.isArray(raw.categories) ? raw.categories.filter(isNonEmpty) : [],
    conversationUrl: raw.conversationUrl ?? null,
    disabledFeatures: (raw.disabledFeatures ?? []).map((d) => d.disabledFeature).filter(isNonEmpty),
  };
}

function isNonEmpty(v: string | undefined | null): v is string {
  return typeof v === "string" && v.length > 0;
}

function parseParticipant(
  urn: string,
  included: Map<string, Record<string, unknown>>
): ConversationParticipantData | null {
  const raw = included.get(urn) as ParticipantRaw | undefined;
  if (!raw) return null;

  const member = raw.participantType?.member;
  const firstName = member?.firstName?.text ?? "";
  const lastName = member?.lastName?.text ?? "";
  const name = `${firstName} ${lastName}`.trim() || null;
  const headline = member?.headline?.text ?? null;
  const profileUrl = member?.profileUrl ?? null;

  // Every artifact, smallest first. `imageUrl` keeps the historical behaviour
  // of exposing the smallest; the full ladder is now preserved alongside it.
  const picture = member?.profilePicture;
  const profilePictures: ConversationProfilePicture[] = [];
  if (picture?.rootUrl && picture.artifacts?.length) {
    for (const a of [...picture.artifacts].sort((x, y) => (x.width ?? 0) - (y.width ?? 0))) {
      const seg = a.fileIdentifyingUrlPathSegment;
      if (!seg) continue;
      profilePictures.push({
        width: a.width ?? 0,
        height: a.height ?? a.width ?? 0,
        url: `${picture.rootUrl}${seg}`,
      });
    }
  }

  // hostIdentityUrn is the actual profile URN
  const entityUrn = raw.hostIdentityUrn ?? urn;
  const badge = raw.memberBadgeType ?? null;

  return {
    entityUrn,
    name,
    profileUrl,
    imageUrl: profilePictures[0]?.url ?? null,
    headline,
    profilePictures,
    distance: member?.distance ?? null,
    pronoun: member?.pronoun?.standardizedPronoun ?? null,
    memberBadgeType: badge,
    isPremium: raw.showPremiumInBug === true || badge === "PREMIUM_PROFILE",
    isVerified: raw.showVerificationBadge === true || badge === "VERIFIED_PROFILE",
    backendUrn: raw.backendUrn ?? null,
  };
}
