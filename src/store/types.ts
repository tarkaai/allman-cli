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
  /** LinkedIn profile slug (e.g. "dan-moore") — used for symlink creation */
  profileSlug: string | null;
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
  /** LinkedIn profile slug (e.g. "alice-smith") */
  slug: string | null;
  name: string;
  headline: string | null;
  profileUrl: string | null;
  imageUrl: string | null;
  connectedAt: string | null;
  fetchedAt: string;
}

// ---------------------------------------------------------------------------
// Conversation
// ---------------------------------------------------------------------------

export interface ConversationParticipant {
  /** LinkedIn profile ID (not full URN) */
  profileId: string;
  /** urn:li:fsd_profile:{id} */
  urn: string;
  name: string;
  /** LinkedIn profile slug if known */
  slug: string | null;
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
  /** Bare conversation ID (folder name): e.g. 2-OTg0N2Nk... */
  bareId: string;
  title: string;
  isGroup: boolean;
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
  isFromMe: boolean;
  body: string;
  reactions: MessageReaction[];
  attachments: MessageAttachment[];
  /** Present on sent messages — used to detect echo events from SSE stream */
  originToken: string | null;
}
