/**
 * File store type definitions.
 * These match the shapes written to JSON/JSONL files in the .allman store.
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
  /** Unix ms timestamp of the last outbound connection invitation. */
  lastInviteSentAt?: number;
  /**
   * Rolling-window quota ledgers (unix ms timestamps, pruned to their window).
   * Persisted so per-day/per-hour caps survive process restarts.
   */
  enrichmentTimestamps?: number[];
  companyTimestamps?: number[];
  inviteTimestamps?: number[];
}

/** inbox-state.json — tracks what messages have been shown in `inbox`. Not git-committed. */
export interface AccountInboxState {
  /** Unix ms — show messages newer than this */
  lastSeenAt: number;
}

/**
 * query-cache.json — cached LinkedIn web-app GraphQL query IDs that rotate with
 * bundle releases. Captured from the live app via a headless browser
 * (flagship-queryid.ts). Not sensitive, but gitignored (churns with deploys).
 */
export interface AccountQueryCache {
  /** Live `voyagerSearchDashClusters.<hash>` for flagship people search. */
  searchClustersQueryId?: string;
  /** ISO timestamp when the queryId was last captured. */
  capturedAt?: string;
}

export interface AccountConfig {
  proxy?: ProxyConfig;
  /** Minimum ms between outbound messages. Default: 3000 */
  rateLimit?: {
    minMessageIntervalMs: number;
    /** Minimum ms between outbound connection invitations. Default: 60000 (1/min). */
    minInviteIntervalMs?: number;
    /**
     * Volume caps for the two sensitive endpoints. Defaults are seat-aware —
     * with a Sales Navigator seat: 100 enrichments/hour, 40 invites/day;
     * without: 25 enrichments/day, 10 invites/day. Set either pair to override.
     */
    maxEnrichments?: number;
    /** Window for `maxEnrichments`, in ms (default: 1h with a seat, 24h without). */
    enrichmentWindowMs?: number;
    /**
     * Max `allman companies` lookups per window. Metered separately from
     * enrichment: it reads org pages on a different resource, so it should not
     * compete with the budget for enriching people.
     */
    maxCompanyLookups?: number;
    /** Window for `maxCompanyLookups`, in ms (default: 1h with a seat, 24h without). */
    companyWindowMs?: number;
    maxInvitesPerDay?: number;
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

/**
 * One member of a conversation other than the signed-in user.
 *
 * Stored on group records (`ConversationRecord.participants`) in LinkedIn's
 * order. The per-person fields mirror the top-level contact fields of a 1:1
 * record so a reader can render either shape with the same code.
 */
export interface ConversationParticipant {
  /** LinkedIn profile ID (e.g. "ACoAAA-2BsYB...") */
  profileId: string;
  /** urn:li:fsd_profile:{profileId} — matches `StoredMessage.fromUrn` */
  profileUrn: string;
  /** urn:li:msg_messagingParticipant:… — the participant, not the person */
  backendUrn: string | null;
  /** Real LinkedIn publicIdentifier slug, or null if unresolved */
  slug: string | null;
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
}

/**
 * RECORD.json — one per conversation directory.
 *
 * 1:1 threads: the contact fields describe the other person and the store
 * also creates `{profileId}` and `{slug}` alias symlinks to the directory.
 *
 * Group threads (`isGroup: true`): the contact fields are filled from the
 * FIRST other participant so readers written for 1:1 records still see a
 * person; `slug` is null; `name` is the group `title` when LinkedIn has one,
 * otherwise the participants' full names joined with ", ". Every other member
 * is listed in `participants`. No alias symlinks are created for a group —
 * they would hijack the 1:1 thread with that person — so a group is only
 * addressable by its bare `convId`.
 */
export interface ConversationRecord {
  // === Three canonical IDs (must match filesystem) ===
  /** Directory name — LinkedIn conversation ID */
  convId: string;
  /** Contact's LinkedIn profile ID (e.g. "ACoAAA-2BsYB..."); first other participant for a group */
  profileId: string;
  /** Real LinkedIn publicIdentifier slug, or null if unresolved. Always null for a group. */
  slug: string | null;

  // === Group threads (absent / false on 1:1 records) ===
  /** True for a group thread. Omitted (or false) on 1:1 records. */
  isGroup?: boolean;
  /** LinkedIn's group title when set. Only present on group records. */
  title?: string | null;
  /**
   * Every participant EXCEPT the signed-in user, in LinkedIn's order.
   * Only present on group records. Match a message's sender with
   * `participants[i].profileUrn === message.fromUrn`.
   */
  participants?: ConversationParticipant[];

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
  /**
   * Broad category. "other" means the raw payload is preserved but the
   * shape wasn't recognized by the parser; renderers should fall back
   * to a generic placeholder (or inspect `raw`).
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
  url?: string;
  name?: string;
  size?: number;
  mimeType?: string;
  previewUrl?: string;
  /** Pixel dimensions when the attachment is visual. */
  width?: number;
  height?: number;
  /** Duration in milliseconds (video / voice / audio). */
  durationMs?: number;
  /** Title for link previews / post shares. */
  title?: string;
  /** Short description for link previews / post shares. */
  description?: string;
  /** Commentary / original body for shared posts, forwarded messages, replies. */
  originalText?: string;
  /** Original author name (shared post author, forwarded sender). */
  authorName?: string;
  /** Raw LinkedIn renderContent object for types we don't fully parse. */
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
  /**
   * Sender as a profile URN — `urn:li:fsd_profile:{profileId}` — for both
   * synced (REST `*sender` → participant `hostIdentityUrn`) and streamed
   * (SSE `fs_miniProfile` normalized) messages. In a group thread, match it
   * against `ConversationRecord.participants[].profileUrn` (NOT `backendUrn`).
   * Only when LinkedIn omits the participant from the response graph does
   * this degrade to the raw `urn:li:msg_messagingParticipant:…` reference,
   * which then matches `participants[].backendUrn`.
   */
  fromUrn: string;
  fromName: string;
  isFromMe: boolean;
  body: string;
  reactions: MessageReaction[];
  attachments: MessageAttachment[];
  /** Present on sent messages — used to detect echo events from SSE stream */
  originToken: string | null;
  // --- Optional: absent on records written before these were captured. ---
  /** Rich-text spans over `body`; @-mentions carry the mentioned member's URN. */
  bodyAttributes?: MessageBodyAttribute[];
  /** InMail / sponsored subject line. Ordinary DMs have none. */
  subject?: string | null;
  /** DEFAULT / SYSTEM / … — how LinkedIn wants the body rendered. */
  renderFormat?: string | null;
  /** Plain-text stand-in for content a client cannot render. */
  fallbackText?: string | null;
  /** `urn:li:messagingThread:…` the message belongs to. */
  conversationUrn?: string | null;
}

/** One span of rich text over a message body. */
export interface MessageBodyAttribute {
  start: number;
  length: number;
  /** Tagged union — `com.linkedin.pemberly.text.Entity` for an @-mention. */
  type: unknown;
}
