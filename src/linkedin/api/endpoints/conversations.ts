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

import type { LinkedInApiClient } from "../client.js";
import { encodeUrn } from "../../../utils/urn.js";

const GRAPHQL_URL =
  "https://www.linkedin.com/voyager/api/voyagerMessagingGraphQL/graphql";

const QUERY_ID_LIST = "messengerConversations.45338e053010d1c19147f92de6de3ae6";
const QUERY_ID_BY_RECIPIENTS =
  "messengerConversations.44030325d8f59d8cebbb804f16d6b0a3";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ConversationParticipantData {
  entityUrn: string;
  name: string | null;
  profileUrl: string | null;
  imageUrl: string | null;
  headline: string | null;
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
  "*conversationParticipants"?: string[];
}

interface ParticipantRaw {
  $type?: string;
  entityUrn?: string;
  hostIdentityUrn?: string;
  participantType?: {
    member?: {
      firstName?: { text?: string };
      lastName?: { text?: string };
      headline?: { text?: string };
      profileUrl?: string;
      profilePicture?: {
        rootUrl?: string;
        artifacts?: Array<{ fileIdentifyingUrlPathSegment?: string; width?: number }>;
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
  const variables =
    `(query:(predicateUnions:List((conversationCategoryPredicate:(category:INBOX)))),count:20,mailboxUrn:${encodeUrn(`urn:li:fsd_profile:${profileId}`)},${paginationPart})`;

  const response = await client.request<NormalizedResponse>({
    method: "GET",
    url: `${GRAPHQL_URL}?queryId=${QUERY_ID_LIST}&variables=${variables}`,
  });

  const included = buildIncludedMap(response.included);
  const query = response?.data?.data?.messengerConversationsByCategoryQuery;
  const convUrns = query?.["*elements"] ?? [];

  return {
    conversations: convUrns.flatMap((urn) => {
      const c = parseConversation(urn, included);
      return c ? [c] : [];
    }),
    nextCursor: query?.metadata?.nextCursor ?? null,
  };
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

  const variables =
    `(recipients:List(${encodeUrn(`urn:li:fsd_profile:${contactId}`)}),mailboxUrn:${encodeUrn(`urn:li:fsd_profile:${myId}`)},count:20)`;

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

function buildIncludedMap(included: Array<Record<string, unknown>> | undefined): Map<string, Record<string, unknown>> {
  const map = new Map<string, Record<string, unknown>>();
  for (const item of included ?? []) {
    const urn = item["entityUrn"];
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
  };
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

  // Pick the smallest artifact for image URL
  const picture = member?.profilePicture;
  let imageUrl: string | null = null;
  if (picture?.rootUrl && picture.artifacts?.length) {
    const sorted = [...picture.artifacts].sort((a, b) => (a.width ?? 0) - (b.width ?? 0));
    const seg = sorted[0]?.fileIdentifyingUrlPathSegment;
    if (seg) imageUrl = `${picture.rootUrl}${seg}`;
  }

  // hostIdentityUrn is the actual profile URN
  const entityUrn = raw.hostIdentityUrn ?? urn;

  return { entityUrn, name, profileUrl, imageUrl, headline };
}
