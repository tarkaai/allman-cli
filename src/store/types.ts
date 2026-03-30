/**
 * File store type definitions.
 * These match the shapes written to RECORD.json files and JSONL message lines.
 */

// ---------------------------------------------------------------------------
// Cookie (matches tough-cookie serialization format stored in accounts)
// ---------------------------------------------------------------------------

export interface StoredCookie {
  key: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: string | "Infinity"; // ISO string or "Infinity" for session cookies
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
}

// ---------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------

export type AccountStatus = "unauthenticated" | "authenticated" | "expired";

export interface AccountRecord {
  /** urn:li:fsd_profile:{id} */
  urn: string | null;
  name: string | null;
  headline: string | null;
  profileUrl: string | null;
  imageUrl: string | null;
  userType: "basic" | "sales_nav" | null;
  networkSize: number | null;
  status: AccountStatus;
  /** CookieJar serialized via cookieJar.toJSON() */
  cookieJar: object | null;
  cookiesUpdatedAt: string | null;
  lastSyncAt: string | null;
}

export interface AccountConfig {
  displayName?: string;
  proxy?: ProxyConfig;
  /** Minimum ms between outbound messages. Default: 3000 */
  rateLimit?: {
    minMessageIntervalMs: number;
  };
}

export interface ProxyConfig {
  host: string;
  port: number;
  username?: string;
  password?: string;
}

// ---------------------------------------------------------------------------
// Contact
// ---------------------------------------------------------------------------

export interface ContactRecord {
  /** urn:li:fsd_profile:{id} */
  urn: string;
  name: string;
  headline: string | null;
  profileUrl: string;
  imageUrl: string | null;
  connectedAt: string | null;
  fetchedAt: string;
}

// ---------------------------------------------------------------------------
// Conversation
// ---------------------------------------------------------------------------

export interface ConversationParticipant {
  slug: string;
  urn: string;
  name: string;
}

export interface SyncState {
  /** Unix ms of oldest locally stored message */
  oldestMessageAt: number | null;
  /** Unix ms of newest locally stored message */
  newestMessageAt: number | null;
  /** ISO timestamp of last sync run */
  lastSyncAt: string | null;
  totalSynced: number;
  /** True when we have fetched all history back to conversation creation */
  fullyBackfilled: boolean;
}

export interface ConversationRecord {
  /** Frontend conversation URN: urn:li:msg_conversation:... */
  urn: string;
  /** Backend URN: urn:li:messagingThread:... (used in message payloads) */
  backendUrn: string | null;
  title: string;
  isGroup: boolean;
  /** Account slug this conversation belongs to */
  account: string;
  participants: ConversationParticipant[];
  unreadCount: number;
  lastActivityAt: string | null;
  createdAt: string | null;
  syncState: SyncState;
}

// ---------------------------------------------------------------------------
// Message (one line in YYYY-MM.jsonl)
// ---------------------------------------------------------------------------

export interface MessageAttachment {
  type: "image" | "video" | "file" | "gif" | "link_preview" | "voice" | "other";
  url?: string;
  name?: string;
  size?: number;
  mimeType?: string;
  previewUrl?: string;
  /** Raw LinkedIn renderContent object for types we don't fully parse */
  raw?: unknown;
}

export interface MessageReaction {
  emoji: string;
  count: number;
  hasUserReacted: boolean;
}

export interface StoredMessage {
  urn: string;
  timestamp: number;
  fromUrn: string;
  fromName: string;
  fromSlug: string;
  isFromMe: boolean;
  body: string;
  reactions: MessageReaction[];
  attachments: MessageAttachment[];
  /** Present on sent messages — used to detect echo events from SSE stream */
  originToken: string | null;
}
