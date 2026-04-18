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
 *   allman/api/src/services/messaging/message-sender.ts
 */

import { randomUUID } from "node:crypto";
import { byteArrayToString, extractBareConvId, uuidToByteArray } from "../../../utils/urn.js";
import type { LinkedInApiClient } from "../client.js";

const GRAPHQL_URL = "https://www.linkedin.com/voyager/api/voyagerMessagingGraphQL/graphql";
const MESSAGES_REST_URL =
  "https://www.linkedin.com/voyager/api/voyagerMessagingDashMessengerMessages";

const QUERY_ID_MESSAGES = "messengerMessages.90abe2bc64df3bc3e1323a1479989b49";

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
  /**
   * Broad category so consumers can pick a renderer without needing to know
   * every LinkedIn render-content URN. "other" means we preserved the raw
   * payload but didn't recognize the shape — consult `raw` to render it.
   */
  type:
    | "image"
    | "video"
    | "audio"
    | "voice"
    | "file"
    | "gif"
    | "link_preview"
    | "post_share"
    | "forwarded"
    | "replied"
    | "unavailable"
    | "away_message"
    | "other";
  /** Direct URL (download for files, first frame for images, etc.). */
  url?: string;
  /** Filename for files; title for link previews; original-sender name for forwarded. */
  name?: string;
  /** MIME type when available. */
  mimeType?: string;
  /** Byte size for files. */
  size?: number;
  /** Intrinsic pixel dimensions for images/videos. */
  width?: number;
  height?: number;
  /** Media duration in milliseconds (video / voice). */
  durationMs?: number;
  /** Title for link previews / shared content. */
  title?: string;
  /** Short description for link previews. */
  description?: string;
  /** Poster/thumbnail URL for video / gif / link previews. */
  previewUrl?: string;
  /** Human text embedded in a shared post, forwarded message, or reply. */
  originalText?: string;
  /** Original author name (for forwarded / shared posts). */
  authorName?: string;
  /** Raw LinkedIn renderContent object. Always preserved for fidelity. */
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
  // LinkedIn returns `viewerReacted` (bool); older clients called it `hasUserReacted`.
  reactionSummaries?: Array<{
    emoji?: string;
    count?: number;
    viewerReacted?: boolean;
    hasUserReacted?: boolean;
  }>;
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

  const variables = `(deliveredAt:${anchorTimestamp},conversationUrn:${encodedConvUrn},countBefore:${countBefore},countAfter:0)`;

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
    conversationUrn?: string;
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
// Reactions
// ---------------------------------------------------------------------------

/**
 * Build the composite "entity URN" form that LinkedIn requires for reaction
 * payloads. Messages are normally stored as their `backendUrn`
 * (`urn:li:messagingMessage:2-...`), but the `reactWithEmoji` action only
 * accepts the frontend entity URN:
 *
 *   urn:li:msg_message:(urn:li:fsd_profile:{senderProfileId},{bareMessageId})
 *
 * This helper accepts any of those forms and returns the composite shape.
 *
 * Decompiled source: web-messenger POST /voyagerMessagingDashMessengerMessages?action=reactWithEmoji
 */
function buildReactionMessageUrn(messageUrn: string, senderProfileId: string): string {
  // Already composite? Pass through.
  if (messageUrn.startsWith("urn:li:msg_message:(")) return messageUrn;
  // urn:li:messagingMessage:2-... → bare 2-...
  const backendMatch = messageUrn.match(/^urn:li:messagingMessage:(.+)$/);
  const bare = backendMatch?.[1] ?? messageUrn;
  return `urn:li:msg_message:(urn:li:fsd_profile:${senderProfileId},${bare})`;
}

/**
 * Add a reaction to a message.
 *
 * @param messageUrn  Any known URN form for the message (backend, composite, or bare id).
 * @param senderProfileUrn  Authenticated user's profile URN (the reacting viewer).
 * @param emoji  Unicode emoji (e.g. "👍", "❤️"). LinkedIn accepts most single emoji.
 */
export async function addReaction(
  client: LinkedInApiClient,
  messageUrn: string,
  senderProfileUrn: string,
  emoji: string
): Promise<void> {
  const senderProfileId = senderProfileUrn.replace("urn:li:fsd_profile:", "");
  const compositeUrn = buildReactionMessageUrn(messageUrn, senderProfileId);

  await client.request<unknown>({
    method: "POST",
    url: MESSAGES_REST_URL,
    params: { action: "reactWithEmoji" },
    data: { messageUrn: compositeUrn, emoji },
  });
}

/**
 * Remove the authenticated user's reaction from a message.
 * Silently no-ops server-side if no matching reaction exists.
 */
export async function removeReaction(
  client: LinkedInApiClient,
  messageUrn: string,
  senderProfileUrn: string,
  emoji: string
): Promise<void> {
  const senderProfileId = senderProfileUrn.replace("urn:li:fsd_profile:", "");
  const compositeUrn = buildReactionMessageUrn(messageUrn, senderProfileId);

  await client.request<unknown>({
    method: "POST",
    url: MESSAGES_REST_URL,
    params: { action: "unreactWithEmoji" },
    data: { messageUrn: compositeUrn, emoji },
  });
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
    const msg = included.get(valueUrn) as
      | {
          entityUrn?: string;
          backendUrn?: string;
          conversationUrn?: string;
          backendConversationUrn?: string;
          deliveredAt?: number;
        }
      | undefined;
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

// Exported for unit tests. Parses a raw message document (with its included-
// lookup map) into the normalized MessageData shape. Not part of the public
// API — callers should use fetchMessages.
export function parseMessageRaw(
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

  // LinkedIn usually sets `deliveredAt` on every message, but some special
  // content types (shared posts, system notices) omit it. Fall back to other
  // timestamp-ish fields before surrendering to 0, so downstream sync logic
  // can still file and order the message.
  const rawObj = raw as unknown as Record<string, unknown>;
  const fallbackTs =
    pickNumber(rawObj, "deliveredAt") ??
    pickNumber(rawObj, "createdAt") ??
    pickNumber(rawObj, "lastEditedAt") ??
    pickNumber(rawObj, "insertedAt") ??
    0;

  return {
    urn: raw.backendUrn ?? raw.entityUrn ?? urn,
    deliveredAt: fallbackTs,
    fromUrn,
    fromName,
    body: raw.body?.text ?? "",
    originToken: raw.originToken ?? null,
    reactions: (raw.reactionSummaries ?? []).map((r) => ({
      emoji: r.emoji ?? "",
      count: r.count ?? 0,
      hasUserReacted: r.viewerReacted ?? r.hasUserReacted ?? false,
    })),
    attachments: parseAttachments(raw.renderContent, included),
  };
}

function pickNumber(obj: Record<string, unknown>, key: string): number | null {
  const v = obj[key];
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * Decode a LinkedIn renderContent list into structured attachments.
 *
 * Each entry is an object keyed by a `com.linkedin.*` type URI — we match
 * on the short leaf name ("file", "video", "forwardedMessageContent", etc.)
 * rather than the full URI, because the prefix varies between contexts
 * (messenger vs voyager vs feed) but the leaf is stable.
 *
 * Shapes are derived from the decompiled LinkedIn web bundle
 * (`playground/linkedin/messenger.js`, schema validators ~line 13617).
 */
// Exported for unit tests.
export function parseAttachments(
  renderContent: unknown[] | undefined,
  included: Map<string, Record<string, unknown>>
): MessageAttachmentData[] {
  if (!renderContent || renderContent.length === 0) return [];
  return renderContent.map((rc) => parseOneAttachment(rc, included));
}

function parseOneAttachment(
  rc: unknown,
  included: Map<string, Record<string, unknown>>
): MessageAttachmentData {
  if (!rc || typeof rc !== "object") return { type: "other", raw: rc };
  const wrapper = rc as Record<string, unknown>;

  // LinkedIn's renderContent is a tagged union: the payload sets one key to
  // an object, and the remaining alternatives to `null`. So we can't use
  // `!== undefined` — that would match the null sentinels too. We need
  // non-null, non-undefined. The order still matters for the URI-style
  // fallback, but the null check makes the short-name loop robust.
  const tryKeys = [
    "file",
    "video",
    "audio",
    "voice",
    "vectorImage",
    "externalMedia",
    "forwardedMessageContent",
    "repliedMessageContent",
    "unavailableContent",
    "awayMessage",
    "hostUrnData",
    "feedUpdate",
    "sharedFeedUpdate",
    "articleMedia",
    "messageAdRenderContent",
  ];
  for (const k of tryKeys) {
    const v = wrapper[k];
    if (v != null) return parseAttachmentByKind(k, v, rc, included);
  }

  // Fall back to the fully-qualified URI form, e.g.
  // `com.linkedin.messenger.FileAttachmentContent`. Strip the prefix and
  // lowercase the first letter so detection still works.
  const longKey = Object.keys(wrapper).find(
    (k) => k.startsWith("com.linkedin") && wrapper[k] != null
  );
  if (longKey) {
    const leaf = longKey.split(".").pop() ?? "";
    const normalized = leaf.charAt(0).toLowerCase() + leaf.slice(1);
    return parseAttachmentByKind(normalized, wrapper[longKey], rc, included);
  }

  return { type: "other", raw: rc };
}

function parseAttachmentByKind(
  kind: string,
  innerUnknown: unknown,
  raw: unknown,
  included: Map<string, Record<string, unknown>>
): MessageAttachmentData {
  const inner = (innerUnknown ?? {}) as Record<string, unknown>;
  const lk = kind.toLowerCase();

  if (lk.includes("file") || lk.includes("document") || lk.includes("attachment")) {
    return {
      type: "file",
      url: str(inner.url) ?? str(inner.downloadUrl),
      name: str(inner.name),
      mimeType: str(inner.mediaType),
      size: num(inner.byteSize),
      raw,
    };
  }

  if (lk.includes("vectorimage") || lk.includes("photo") || lk === "image") {
    const path = str(inner.fileIdentifyingUrlPathSegment);
    return {
      type: "image",
      url: path ? buildVectorImageUrl(inner, path) : str(inner.url),
      width: num(inner.width),
      height: num(inner.height),
      raw,
    };
  }

  if (lk.includes("externalmedia") || lk.includes("linkpreview")) {
    // External media covers GIFs, Giphy embeds, and link-preview cards.
    // Distinguish on mediaType when available: image/gif → gif.
    const media = (inner.media as Record<string, unknown>) ?? {};
    const preview = (inner.previewMedia as Record<string, unknown>) ?? {};
    const mime = str(media.mediaType) ?? str(inner.mediaType);
    const isGif = mime === "image/gif" || /gif/i.test(kind);
    return {
      type: isGif ? "gif" : "link_preview",
      url: str(media.url) ?? str(inner.url),
      previewUrl: str(preview.url) ?? str(media.url),
      title: str(inner.title),
      description: str(inner.description),
      width: num(media.originalWidth) ?? num(inner.width),
      height: num(media.originalHeight) ?? num(inner.height),
      mimeType: mime,
      raw,
    };
  }

  if (lk === "video" || lk.includes("videomessage") || lk.includes("videomeeting")) {
    // Video renderContent often references media via URN; the actual URL
    // is embedded in the included[] map under that URN. Grab whatever
    // "url"/"thumbnail" field surfaces.
    const mediaRef = str(inner.media);
    let url: string | undefined;
    let previewUrl: string | undefined;
    let width = num(inner.width);
    let height = num(inner.height);
    if (mediaRef) {
      const mediaDoc = included.get(mediaRef);
      if (mediaDoc) {
        url = str(mediaDoc.progressiveStreams) ?? str(mediaDoc.url);
        previewUrl = str(mediaDoc.thumbnail);
        width = width ?? num(mediaDoc.width);
        height = height ?? num(mediaDoc.height);
      }
    }
    return {
      type: "video",
      url: url ?? str(inner.url),
      previewUrl,
      durationMs: num(inner.duration),
      width,
      height,
      raw,
    };
  }

  if (lk === "audio" || lk === "voice" || lk.includes("voicemessage")) {
    return {
      type: lk.includes("voice") ? "voice" : "audio",
      url: str(inner.url),
      durationMs: num(inner.duration),
      raw,
    };
  }

  if (lk.includes("forwardedmessage")) {
    const sender = (inner.originalSender as Record<string, unknown>) ?? {};
    return {
      type: "forwarded",
      originalText: str(inner.forwardedBody) ?? str(inner.messageBody),
      authorName: buildSenderName(sender),
      raw,
    };
  }

  if (lk.includes("repliedmessage")) {
    const sender = (inner.originalSender as Record<string, unknown>) ?? {};
    return {
      type: "replied",
      originalText: str(inner.messageBody) ?? str(inner.forwardedBody),
      authorName: buildSenderName(sender),
      raw,
    };
  }

  if (lk.includes("unavailable")) {
    return {
      type: "unavailable",
      description: str(inner.unavailableReason) ?? str(inner.contentType),
      raw,
    };
  }

  if (lk.includes("awaymessage")) {
    return {
      type: "away_message",
      originalText: str(inner.text),
      description: str(inner.footerText),
      raw,
    };
  }

  // Post shares delivered as a "host URN" reference — the message just
  // points at a feed update (`urn:li:fsd_update:(urn:li:activity:...)`) and
  // the client renders the linked post inline. No inline commentary, author
  // or title is delivered; all we can usefully recover is a permalink.
  if (lk === "hosturndata" || (lk.includes("host") && lk.includes("urn"))) {
    const hostUrn = str(inner.hostUrn);
    const hostType = str(inner.type);
    const activityId = hostUrn ? extractActivityId(hostUrn) : null;
    return {
      type: "post_share",
      url: activityId
        ? `https://www.linkedin.com/feed/update/urn:li:activity:${activityId}/`
        : undefined,
      description: hostType ?? undefined,
      raw,
    };
  }

  // Feed / post shares (and anything else with an embedded post-like shape).
  // LinkedIn uses several keys here depending on the share source; we
  // normalize them all to "post_share" so consumers render a unified card.
  if (
    lk.includes("feed") ||
    lk.includes("share") ||
    lk.includes("post") ||
    lk.includes("article")
  ) {
    const actorName = buildActor(inner.actor) ?? buildActor(inner.author) ?? str(inner.authorName);
    return {
      type: "post_share",
      title: str(inner.title) ?? str(inner.headline),
      description: str(inner.description) ?? str(inner.subtitle),
      originalText: str(inner.commentary) ?? str(inner.summary) ?? str(inner.body),
      authorName: actorName,
      url: str(inner.permalink) ?? str(inner.navigationUrl) ?? str(inner.url),
      raw,
    };
  }

  return { type: "other", raw };
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function buildSenderName(sender: Record<string, unknown>): string | undefined {
  const pt = (sender.participantType as Record<string, unknown>) ?? {};
  const member = (pt.member as Record<string, unknown>) ?? {};
  const first = (member.firstName as { text?: string } | undefined)?.text ?? "";
  const last = (member.lastName as { text?: string } | undefined)?.text ?? "";
  const full = `${first} ${last}`.trim();
  return full || str(sender.name);
}

/**
 * Extract the numeric activity ID from a feed-update host URN.
 * Example: `urn:li:fsd_update:(urn:li:activity:7450188970220638208,MESSAGING_RESHARE,...)`
 * → `7450188970220638208`
 */
function extractActivityId(hostUrn: string): string | null {
  const m = hostUrn.match(/urn:li:activity:(\d+)/);
  return m ? (m[1] ?? null) : null;
}

function buildActor(actor: unknown): string | undefined {
  if (!actor || typeof actor !== "object") return undefined;
  const a = actor as Record<string, unknown>;
  return (
    str(a.name) ??
    (a.firstName && a.lastName ? `${String(a.firstName)} ${String(a.lastName)}`.trim() : undefined)
  );
}

/**
 * Build a CDN URL for a LinkedIn vectorImage. LinkedIn stores the artifact
 * path as `fileIdentifyingUrlPathSegment` which is meant to be appended to
 * a `rootUrl` (provided on the image). Fall back to returning the raw
 * path segment so callers can still fetch it.
 */
function buildVectorImageUrl(inner: Record<string, unknown>, path: string): string {
  const rootUrl = str(inner.rootUrl);
  if (rootUrl) return `${rootUrl.replace(/\/$/, "")}/${path}`;
  // Artifacts array fallback — some vectorImage payloads nest the path under
  // `artifacts[].fileIdentifyingUrlPathSegment` without a top-level rootUrl.
  const artifacts = inner.artifacts;
  if (Array.isArray(artifacts)) {
    for (const a of artifacts) {
      const aa = a as Record<string, unknown>;
      const r = str(aa.rootUrl);
      const p = str(aa.fileIdentifyingUrlPathSegment);
      if (r && p) return `${r.replace(/\/$/, "")}/${p}`;
    }
  }
  return path;
}
