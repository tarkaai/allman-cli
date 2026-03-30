/**
 * LinkedIn message API endpoints.
 *
 * Fetching uses GraphQL; sending uses REST.
 *
 * GraphQL query ID (from monorepo):
 *   messengerMessages.90abe2bc64df3bc3e1323a1479989b49
 *
 * Fallback (from mautrix):
 *   messengerMessages.4088d03bc70c91c3fa68965cb42336de
 *
 * REST endpoint for send/create:
 *   POST /voyager/api/voyagerMessagingDashMessengerMessages?action=createMessage
 *
 * Source:
 *   monorepo/lib/services/.../linkedin-api-services.ts
 *   lilac/api/src/services/messaging/message-sender.ts
 */

import { randomUUID } from "crypto";
import type { LinkedInApiClient } from "../client.js";
import { encodeUrn, uuidToByteArray, byteArrayToString } from "../../../utils/urn.js";

const GRAPHQL_URL =
  "https://www.linkedin.com/voyager/api/voyagerMessagingGraphQL/graphql";
const MESSAGES_REST_URL =
  "https://www.linkedin.com/voyager/api/voyagerMessagingDashMessengerMessages";

const QUERY_ID_MESSAGES =
  "messengerMessages.90abe2bc64df3bc3e1323a1479989b49";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MessageData {
  urn: string;
  /** Unix ms */
  deliveredAt: number;
  fromUrn: string;
  fromName: string | null;
  body: string;
  originToken: string | null;
  reactions: MessageReactionData[];
  attachments: MessageAttachmentData[];
}

export interface MessageReactionData {
  emoji: string;
  count: number;
  hasUserReacted: boolean;
}

export interface MessageAttachmentData {
  type: string;
  url?: string;
  name?: string;
  mimeType?: string;
  raw?: unknown;
}

export interface SendMessageResult {
  messageUrn: string;
  conversationUrn: string;
  backendConversationUrn: string;
  deliveredAt: number;
}

// ---------------------------------------------------------------------------
// Fetch messages
// ---------------------------------------------------------------------------

interface MessagesQueryResponse {
  data?: {
    messengerMessagesByAnchorTimestamp?: {
      elements?: MessageElement[];
      metadata?: { previousCursor?: string };
    };
  };
}

interface MessageElement {
  backendUrn?: string;
  entityUrn?: string;
  deliveredAt?: number;
  body?: { text?: string; attributes?: unknown[] };
  originToken?: string | null;
  sender?: {
    entityUrn?: string;
    "com.linkedin.voyager.messaging.MessagingMember"?: {
      miniProfile?: { firstName?: string; lastName?: string; entityUrn?: string };
    };
    participant?: {
      "com.linkedin.voyager.messaging.member.MemberMessagingParticipant"?: {
        miniProfile?: { firstName?: string; lastName?: string };
      };
    };
  };
  reactionSummaries?: Array<{
    emoji?: string;
    count?: number;
    hasUserReacted?: boolean;
  }>;
  renderContent?: unknown[];
}

/**
 * Fetch messages for a conversation, paginating backwards from `anchorTimestamp`.
 *
 * @param conversationUrn     Frontend conv URN: urn:li:msg_conversation:...
 * @param senderProfileUrn    Authenticated user's profile URN
 * @param anchorTimestamp     Start fetching from this timestamp backwards (ms). Default: now.
 * @param countBefore         Number of messages to fetch before anchor. Default: 20.
 */
export async function fetchMessages(
  client: LinkedInApiClient,
  conversationUrn: string,
  senderProfileUrn: string,
  anchorTimestamp: number = Date.now(),
  countBefore = 20
): Promise<{ messages: MessageData[]; hasMore: boolean }> {
  const senderProfileId = senderProfileUrn.replace("urn:li:fsd_profile:", "");

  // Build the full conversation URN used in the query
  const fullConvUrn = `urn:li:msg_conversation:(urn:li:fsd_profile:${senderProfileId},${conversationUrn})`;

  const variables = encodeURIComponent(
    `(deliveredAt:${anchorTimestamp},conversationUrn:${encodeUrn(fullConvUrn)},countBefore:${countBefore},countAfter:0)`
  );

  const response = await client.request<MessagesQueryResponse>({
    method: "GET",
    url: `${GRAPHQL_URL}?queryId=${QUERY_ID_MESSAGES}&variables=${variables}`,
  });

  const result = response?.data?.messengerMessagesByAnchorTimestamp;
  const elements = result?.elements ?? [];

  return {
    messages: elements.map(parseMessageElement),
    hasMore: result?.metadata?.previousCursor !== undefined,
  };
}

// ---------------------------------------------------------------------------
// Send message
// ---------------------------------------------------------------------------

interface SendMessagePayload {
  message: {
    body: { attributes: unknown[]; text: string };
    renderContentUnions: unknown[];
    conversationUrn: string;
    originToken: string;
  };
  mailboxUrn: string;
  trackingId: string;
  dedupeByClientGeneratedToken: boolean;
  /** Only for new conversations (no existing thread). */
  hostRecipientUrns?: string[];
}

interface SendMessageResponse {
  value?: {
    backendUrn?: string;
    entityUrn?: string;
    conversationUrn?: string;
    backendConversationUrn?: string;
    deliveredAt?: number;
  };
}

/**
 * Send a text message to an existing conversation.
 *
 * @param conversationUrn  The conversation's backend URN (urn:li:messagingThread:...)
 * @param senderProfileUrn Authenticated user's profile URN
 * @param text             Message body text
 */
export async function sendMessage(
  client: LinkedInApiClient,
  conversationUrn: string,
  senderProfileUrn: string,
  text: string
): Promise<SendMessageResult> {
  const senderProfileId = senderProfileUrn.replace("urn:li:fsd_profile:", "");
  const originToken = randomUUID();
  const trackingId = byteArrayToString(uuidToByteArray(originToken));

  // The conversationUrn in the message payload uses the full nested format
  const fullConvUrn = `urn:li:msg_conversation:(urn:li:fsd_profile:${senderProfileId},${conversationUrn})`;

  const payload: SendMessagePayload = {
    message: {
      body: { attributes: [], text },
      renderContentUnions: [],
      conversationUrn: fullConvUrn,
      originToken,
    },
    mailboxUrn: `urn:li:fsd_profile:${senderProfileId}`,
    trackingId,
    dedupeByClientGeneratedToken: false,
  };

  const response = await client.request<SendMessageResponse>({
    method: "POST",
    url: MESSAGES_REST_URL,
    params: { action: "createMessage" },
    data: payload,
  });

  const value = response?.value;
  if (!value) {
    throw new Error("LinkedIn returned an empty response for sendMessage");
  }

  return {
    messageUrn: value.backendUrn ?? value.entityUrn ?? "",
    conversationUrn: value.conversationUrn ?? "",
    backendConversationUrn: value.backendConversationUrn ?? "",
    deliveredAt: value.deliveredAt ?? Date.now(),
  };
}

/**
 * Send a message to start a new conversation (no existing thread).
 *
 * @param contactProfileUrn  Recipient's profile URN
 * @param senderProfileUrn   Authenticated user's profile URN
 * @param text               Message body text
 */
export async function sendFirstMessage(
  client: LinkedInApiClient,
  contactProfileUrn: string,
  senderProfileUrn: string,
  text: string
): Promise<SendMessageResult> {
  const senderProfileId = senderProfileUrn.replace("urn:li:fsd_profile:", "");
  const originToken = randomUUID();
  const trackingId = byteArrayToString(uuidToByteArray(originToken));

  const payload: SendMessagePayload & { hostRecipientUrns: string[] } = {
    message: {
      body: { attributes: [], text },
      renderContentUnions: [],
      // No conversationUrn for new threads
      conversationUrn: `urn:li:msg_conversation:(urn:li:fsd_profile:${senderProfileId},)`,
      originToken,
    },
    mailboxUrn: `urn:li:fsd_profile:${senderProfileId}`,
    trackingId,
    dedupeByClientGeneratedToken: false,
    hostRecipientUrns: [contactProfileUrn],
  };

  const response = await client.request<SendMessageResponse>({
    method: "POST",
    url: MESSAGES_REST_URL,
    params: { action: "createMessage" },
    data: payload,
  });

  const value = response?.value;
  if (!value) {
    throw new Error("LinkedIn returned an empty response for sendFirstMessage");
  }

  return {
    messageUrn: value.backendUrn ?? value.entityUrn ?? "",
    conversationUrn: value.conversationUrn ?? "",
    backendConversationUrn: value.backendConversationUrn ?? "",
    deliveredAt: value.deliveredAt ?? Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

function parseMessageElement(el: MessageElement): MessageData {
  const member =
    el.sender?.["com.linkedin.voyager.messaging.MessagingMember"]?.miniProfile ??
    el.sender?.participant?.[
      "com.linkedin.voyager.messaging.member.MemberMessagingParticipant"
    ]?.miniProfile;

  const fromName = member
    ? `${member.firstName ?? ""} ${member.lastName ?? ""}`.trim() || null
    : null;

  const fromUrn =
    el.sender?.["com.linkedin.voyager.messaging.MessagingMember"]?.miniProfile
      ?.entityUrn ?? el.sender?.entityUrn ?? "";

  return {
    urn: el.backendUrn ?? el.entityUrn ?? "",
    deliveredAt: el.deliveredAt ?? 0,
    fromUrn,
    fromName,
    body: el.body?.text ?? "",
    originToken: el.originToken ?? null,
    reactions: (el.reactionSummaries ?? []).map((r) => ({
      emoji: r.emoji ?? "",
      count: r.count ?? 0,
      hasUserReacted: r.hasUserReacted ?? false,
    })),
    attachments: parseAttachments(el.renderContent),
  };
}

function parseAttachments(renderContent: unknown[] | undefined): MessageAttachmentData[] {
  if (!renderContent || renderContent.length === 0) return [];
  return renderContent.map((rc) => {
    const content = rc as Record<string, unknown>;
    // LinkedIn wraps each attachment in a typed key
    const typeKey = Object.keys(content).find((k) => k.startsWith("com.linkedin"));
    if (!typeKey) return { type: "other", raw: rc };

    const inner = content[typeKey] as Record<string, unknown>;
    const type = detectAttachmentType(typeKey);

    return {
      type,
      url: (inner["url"] as string) ?? (inner["downloadUrl"] as string) ?? undefined,
      name: (inner["name"] as string) ?? undefined,
      mimeType: (inner["mediaType"] as string) ?? undefined,
      raw: rc,
    };
  });
}

function detectAttachmentType(typeKey: string): string {
  if (typeKey.includes("Image") || typeKey.includes("Photo")) return "image";
  if (typeKey.includes("Video")) return "video";
  if (typeKey.includes("Audio") || typeKey.includes("Voice")) return "voice";
  if (typeKey.includes("File") || typeKey.includes("Document")) return "file";
  if (typeKey.includes("ExternalMedia") || typeKey.includes("Link")) return "link_preview";
  if (typeKey.includes("Gif") || typeKey.includes("gif")) return "gif";
  return "other";
}
