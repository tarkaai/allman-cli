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
import { uuidToByteArray, byteArrayToString, extractBareConvId } from "../../../utils/urn.js";

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

// Normalized JSON response format
interface MessagesQueryResponse {
  data?: {
    data?: {
      messengerMessagesByAnchorTimestamp?: {
        "*elements"?: string[];
        metadata?: { previousCursor?: string };
      };
    };
  };
  included?: Array<Record<string, unknown>>;
}

interface MessageRaw {
  $type?: string;
  entityUrn?: string;
  backendUrn?: string;
  deliveredAt?: number;
  body?: { text?: string };
  originToken?: string | null;
  reactionSummaries?: Array<{ emoji?: string; count?: number; hasUserReacted?: boolean }>;
  renderContent?: unknown[];
  "*sender"?: string;
  "*actor"?: string;
}

interface ParticipantRaw {
  $type?: string;
  entityUrn?: string;
  hostIdentityUrn?: string;
  participantType?: {
    member?: {
      firstName?: { text?: string };
      lastName?: { text?: string };
    };
  };
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

  // Normalize conversationUrn — callers may pass the full urn:li:msg_conversation:(...) or
  // the bare inner ID (2-...) or urn:li:messagingThread:...
  const bareConvId = extractBareConvId(conversationUrn);
  // LinkedIn requires parens encoded as %28/%29 — encodeURIComponent leaves them unencoded
  const encodedConvUrn = `urn%3Ali%3Amsg_conversation%3A%28urn%3Ali%3Afsd_profile%3A${senderProfileId}%2C${encodeURIComponent(bareConvId)}%29`;

  const variables =
    `(deliveredAt:${anchorTimestamp},conversationUrn:${encodedConvUrn},countBefore:${countBefore},countAfter:0)`;

  const response = await client.request<MessagesQueryResponse>({
    method: "GET",
    url: `${GRAPHQL_URL}?queryId=${QUERY_ID_MESSAGES}&variables=${variables}`,
  });

  const included = buildIncludedMap(response.included);
  const result = response?.data?.data?.messengerMessagesByAnchorTimestamp;
  const msgUrns = result?.["*elements"] ?? [];

  const messages = msgUrns.flatMap((urn) => {
    const m = parseMessageRaw(urn, included);
    return m ? [m] : [];
  });

  // LinkedIn doesn't always include previousCursor even when more messages exist.
  // If we got back the full page size, assume there are more.
  const hasCursor = result?.metadata?.previousCursor !== undefined;
  const hasMore = hasCursor || messages.length >= countBefore;

  return { messages, hasMore };
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
  // Normalized JSON format: data["*value"] is a URN ref into included[]
  data?: {
    "*value"?: string;
    value?: {
      backendUrn?: string;
      entityUrn?: string;
      conversationUrn?: string;
      backendConversationUrn?: string;
      deliveredAt?: number;
    };
  };
  included?: Array<Record<string, unknown>>;
  // Legacy flat format (kept for fallback)
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

  // Normalize conversationUrn to full nested format required by the payload
  const bareConvId = extractBareConvId(conversationUrn);
  // Payload uses unencoded full conv URN (JSON body, not URL param)
  const fullConvUrn = `urn:li:msg_conversation:(urn:li:fsd_profile:${senderProfileId},${bareConvId})`;

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

  const parsed = parseSendResponse(response);
  if (!parsed) {
    throw new Error("LinkedIn returned an empty response for sendMessage");
  }
  return parsed;
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

  const parsed = parseSendResponse(response);
  if (!parsed) {
    throw new Error("LinkedIn returned an empty response for sendFirstMessage");
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

/**
 * Parse LinkedIn's normalized send response.
 * The API returns: { data: { "*value": "<msgUrn>" }, included: [...] }
 * where included contains the message object.
 */
function parseSendResponse(response: SendMessageResponse): SendMessageResult | null {
  // Normalized format: data["*value"] is a URN ref into included[]
  const valueUrn = response?.data?.["*value"];
  if (valueUrn && response.included) {
    const included = buildIncludedMap(response.included);
    const msg = included.get(valueUrn) as {
      entityUrn?: string;
      backendUrn?: string;
      conversationUrn?: string;
      backendConversationUrn?: string;
      deliveredAt?: number;
    } | undefined;
    if (msg) {
      return {
        messageUrn: msg.backendUrn ?? msg.entityUrn ?? valueUrn,
        conversationUrn: msg.conversationUrn ?? "",
        backendConversationUrn: msg.backendConversationUrn ?? "",
        deliveredAt: msg.deliveredAt ?? Date.now(),
      };
    }
    // URN ref found but not in included — still return what we have
    return {
      messageUrn: valueUrn,
      conversationUrn: "",
      backendConversationUrn: "",
      deliveredAt: Date.now(),
    };
  }

  // Legacy flat format fallback
  const value = response?.value ?? response?.data?.value;
  if (!value) return null;
  return {
    messageUrn: value.backendUrn ?? value.entityUrn ?? "",
    conversationUrn: value.conversationUrn ?? "",
    backendConversationUrn: value.backendConversationUrn ?? "",
    deliveredAt: value.deliveredAt ?? Date.now(),
  };
}

function buildIncludedMap(included: Array<Record<string, unknown>> | undefined): Map<string, Record<string, unknown>> {
  const map = new Map<string, Record<string, unknown>>();
  for (const item of included ?? []) {
    const urn = item["entityUrn"];
    if (typeof urn === "string") map.set(urn, item);
  }
  return map;
}

function parseMessageRaw(
  urn: string,
  included: Map<string, Record<string, unknown>>
): MessageData | null {
  const raw = included.get(urn) as MessageRaw | undefined;
  if (!raw) return null;

  // Sender info via *sender or *actor URN reference
  const senderUrn = raw["*sender"] ?? raw["*actor"] ?? null;
  let fromUrn = "";
  let fromName: string | null = null;

  if (typeof senderUrn === "string") {
    const participant = included.get(senderUrn) as ParticipantRaw | undefined;
    if (participant) {
      fromUrn = participant.hostIdentityUrn ?? senderUrn;
      const m = participant.participantType?.member;
      const first = m?.firstName?.text ?? "";
      const last = m?.lastName?.text ?? "";
      fromName = `${first} ${last}`.trim() || null;
    }
  }

  return {
    urn: raw.backendUrn ?? raw.entityUrn ?? urn,
    deliveredAt: raw.deliveredAt ?? 0,
    fromUrn,
    fromName,
    body: raw.body?.text ?? "",
    originToken: raw.originToken ?? null,
    reactions: (raw.reactionSummaries ?? []).map((r) => ({
      emoji: (r as { emoji?: string }).emoji ?? "",
      count: (r as { count?: number }).count ?? 0,
      hasUserReacted: (r as { hasUserReacted?: boolean }).hasUserReacted ?? false,
    })),
    attachments: parseAttachments(raw.renderContent),
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
