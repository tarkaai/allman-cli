/**
 * File store type definitions.
 * These match the shapes written to JSON/JSONL files in the .lilac store.
 */

// ---------------------------------------------------------------------------
// Account (AUTH.json + COOKIES.json)
// ---------------------------------------------------------------------------

export type AccountStatus = "unauthenticated" | "authenticated" | "expired";

/** AUTH.json — profile info and auth status. Committed to git. */
export interface AccountAuth {
  /** urn:li:fsd_profile:{id} */
  urn: string | null;
  /** LinkedIn profile slug (publicIdentifier) */
  profileSlug: string | null;
  name: string | null;
  headline: string | null;
  profileUrl: string | null;
  imageUrl: string | null;
  userType: "basic" | "sales_nav" | null;
  networkSize: number | null;
  status: AccountStatus;
  lastSyncAt: string | null;
}

/** COOKIES.json — cookie jar. Gitignored (sensitive). */
export interface AccountCookies {
  /** CookieJar serialized via cookieJar.toJSON() */
  cookieJar: object | null;
  cookiesUpdatedAt: string | null;
}

/** Merged view of AUTH.json + COOKIES.json (what commands see). */
export interface AccountRecord extends AccountAuth, AccountCookies {}

/** rate-state.json — ephemeral send timing state. Not git-committed. */
export interface AccountRateState {
  /** Unix ms timestamp of the last outbound message send. */
  lastMessageSentAt: number;
}

export interface AccountConfig {
  proxy?: ProxyConfig;
  /** Minimum ms between outbound messages. Default: 3000 */
  rateLimit?: {
    minMessageIntervalMs: number;
  };
  /** Optional git remote for message history backup */
  git?: {
    remote?: string;
    autoPush?: boolean;
  };
}

export interface ProxyConfig {
  host: string;
  port: number;
  username?: string;
  password?: string;
}

// ---------------------------------------------------------------------------
// Conversation (RECORD.json — one per convId directory)
// ---------------------------------------------------------------------------

export interface ProfilePicture {
  width: number;
  height: number;
  url: string;
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
  // === Three canonical IDs (must match filesystem) ===
  /** Directory name — LinkedIn conversation ID */
  convId: string;
  /** Contact's LinkedIn profile ID (e.g. "ACoAAA-2BsYB...") */
  profileId: string;
  /** Real LinkedIn publicIdentifier slug, or null if unresolved */
  slug: string | null;

  // === LinkedIn URNs (for API calls) ===
  /** urn:li:msg_conversation:... */
  convUrn: string;
  /** urn:li:messagingThread:... */
  backendUrn: string | null;
  /** urn:li:fsd_profile:{profileId} */
  profileUrn: string;
  /** urn:li:member:{numericId} (backend member ID) */
  memberUrn: string | null;

  // === Contact info (cached from API) ===
  firstName: string;
  lastName: string;
  /** Computed: "{firstName} {lastName}" */
  name: string;
  headline: string | null;
  profileUrl: string | null;
  profilePictures: ProfilePicture[] | null;
  /** DISTANCE_1, DISTANCE_2, DISTANCE_3, OUT_OF_NETWORK */
  distance: string | null;
  pronoun: string | null;
  /** VERIFIED_PROFILE, etc. */
  memberBadgeType: string | null;
  isPremium: boolean;
  isVerified: boolean;

  // === Conversation state (cached from API) ===
  unreadCount: number;
  lastActivityAt: string | null;
  lastReadAt: string | null;
  createdAt: string | null;
  read: boolean;
  /** ACTIVE, MUTED */
  notificationStatus: string | null;
  /** PRIMARY_INBOX, INBOX, etc. */
  categories: string[];
  /** Direct link to LinkedIn thread */
  conversationUrl: string | null;
  /** ADD_PARTICIPANT, REMOVE_PARTICIPANT, etc. */
  disabledFeatures: string[];

  // === Sync metadata ===
  syncState: SyncState;
  /** ISO timestamp of last API fetch */
  fetchedAt: string;
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
