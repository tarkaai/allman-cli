/**
 * LinkedIn conversation API endpoints.
 *
 * All conversation fetching uses GraphQL (not REST).
 *
 * Query IDs (from monorepo):
 *   messengerConversations.45338e053010d1c19147f92de6de3ae6  — list by inbox
 *   messengerConversations.44030325d8f59d8cebbb804f16d6b0a3  — by recipients (find/create)
 *
 * Fallback query IDs (from mautrix, if the above stop working):
 *   messengerConversations.8656fb361a8ad0c178e8d3ff1a84ce26
 *   messengerConversations.74c17e85611b60b7ba2700481151a316
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

interface ConversationElement {
  entityUrn?: string;
  backendUrn?: string;
  title?: string | null;
  descriptionText?: string | null;
  groupChat?: boolean;
  lastActivityAt?: number;
  unreadCount?: number;
  conversationParticipants?: Array<{
    entityUrn?: string;
    "com.linkedin.voyager.messaging.MessagingMember"?: {
      miniProfile?: {
        entityUrn?: string;
        firstName?: string;
        lastName?: string;
        occupation?: string;
        publicIdentifier?: string;
        picture?: {
          rootUrl?: string;
          artifacts?: Array<{ fileIdentifyingUrlPathSegment?: string }>;
        };
      };
    };
    participant?: {
      "com.linkedin.voyager.messaging.member.MemberMessagingParticipant"?: {
        miniProfile?: {
          entityUrn?: string;
          firstName?: string;
          lastName?: string;
          occupation?: string;
          publicIdentifier?: string;
        };
      };
    };
  }>;
}

interface ConversationsQueryResponse {
  data?: {
    messengerConversationsByCategoryQuery?: {
      elements?: ConversationElement[];
      metadata?: { nextCursor?: string };
    };
    messengerConversationsByRecipients?: {
      elements?: ConversationElement[];
    };
  };
}

/**
 * Fetch a page of conversations from the LinkedIn inbox.
 *
 * @param myProfileUrn - The authenticated user's profile URN (urn:li:fsd_profile:...)
 * @param lastUpdatedBefore - Fetch conversations with activity before this timestamp (ms)
 * @param nextCursor - For pagination; use the cursor from a previous response
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

  const variables = encodeURIComponent(
    `(query:(predicateUnions:List((conversationCategoryPredicate:(category:PRIMARY_INBOX)))),count:20,mailboxUrn:${encodeUrn(`urn:li:fsd_profile:${profileId}`)},${paginationPart})`
  );

  const response = await client.request<ConversationsQueryResponse>({
    method: "GET",
    url: `${GRAPHQL_URL}?queryId=${QUERY_ID_LIST}&variables=${variables}`,
  });

  const query = response?.data?.messengerConversationsByCategoryQuery;
  const elements = query?.elements ?? [];

  return {
    conversations: elements.map(parseConversationElement),
    nextCursor: query?.metadata?.nextCursor ?? null,
  };
}

/**
 * Find an existing conversation with a specific contact, or return null.
 *
 * @param contactProfileUrn - The contact's profile URN
 * @param myProfileUrn - The authenticated user's profile URN
 */
export async function findConversationByRecipient(
  client: LinkedInApiClient,
  contactProfileUrn: string,
  myProfileUrn: string
): Promise<ConversationData | null> {
  const contactId = contactProfileUrn.replace("urn:li:fsd_profile:", "");
  const myId = myProfileUrn.replace("urn:li:fsd_profile:", "");

  const variables = encodeURIComponent(
    `(recipients:List(${encodeUrn(`urn:li:fsd_profile:${contactId}`)}),mailboxUrn:${encodeUrn(`urn:li:fsd_profile:${myId}`)},count:20)`
  );

  const response = await client.request<ConversationsQueryResponse>({
    method: "GET",
    url: `${GRAPHQL_URL}?queryId=${QUERY_ID_BY_RECIPIENTS}&variables=${variables}`,
  });

  const elements = response?.data?.messengerConversationsByRecipients?.elements ?? [];

  // Find the 1:1 conversation between exactly these two participants
  for (const element of elements) {
    const participants = element.conversationParticipants ?? [];
    if (participants.length === 2) {
      const urns = participants.map((p) => extractParticipantUrn(p)).filter(Boolean);
      if (urns.includes(contactProfileUrn) && urns.includes(myProfileUrn)) {
        return parseConversationElement(element);
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

function parseConversationElement(el: ConversationElement): ConversationData {
  return {
    urn: el.entityUrn ?? "",
    backendUrn: el.backendUrn ?? "",
    title: el.title ?? el.descriptionText ?? null,
    isGroup: el.groupChat ?? false,
    lastActivityAt: el.lastActivityAt ?? null,
    unreadCount: el.unreadCount ?? 0,
    participants: (el.conversationParticipants ?? []).map(parseParticipant),
  };
}

function parseParticipant(p: NonNullable<ConversationElement["conversationParticipants"]>[number]): ConversationParticipantData {
  // LinkedIn uses different nesting depending on API version
  const member =
    p?.["com.linkedin.voyager.messaging.MessagingMember"]?.miniProfile ??
    p?.participant?.[
      "com.linkedin.voyager.messaging.member.MemberMessagingParticipant"
    ]?.miniProfile;

  const entityUrn =
    extractParticipantUrn(p) ??
    member?.entityUrn ??
    "";

  const name = member
    ? `${member.firstName ?? ""} ${member.lastName ?? ""}`.trim() || null
    : null;

  const slug = member?.publicIdentifier ?? null;
  const profileUrl = slug ? `https://www.linkedin.com/in/${slug}/` : null;

  return { entityUrn, name, profileUrl, imageUrl: null, headline: member?.occupation ?? null };
}

function extractParticipantUrn(
  p: Record<string, unknown> | undefined | null
): string | null {
  if (!p) return null;
  if (typeof p["entityUrn"] === "string") return p["entityUrn"];
  const member = p[
    "com.linkedin.voyager.messaging.MessagingMember"
  ] as { miniProfile?: { entityUrn?: string } } | undefined;
  return member?.miniProfile?.entityUrn ?? null;
}
