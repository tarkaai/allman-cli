# Lilac CLI Redesign

## What's wrong now

1. **Slugs are broken** — LinkedIn API returns profile IDs in `profileUrl`, so all symlinks have useless base64 names instead of `alice-smith`
2. **Over-engineered store** — separate `ContactStore` + `ConversationStore` + `contacts/` subdirectory for 1:1 conversations that each map to exactly one person
3. **No search** — no way to fuzzy-match "alice" to find Alice Smith
4. **No agent integration** — CLI outputs JSON but nothing connects it to Claude Code as an always-on agent
5. **Broken store-cmd.ts** — references `store.contacts`/`store.conversations` which don't exist

## What we're building

A flat, file-based messaging store designed for AI agents. One directory per conversation keyed by convId. Symlinks for profileId and slug (real LinkedIn `publicIdentifier`, resolved via profile API). A channel-based MCP server so Claude Code reacts to inbound messages in real-time.

---

## Part 1 — Store Layout

```
.lilac/                                    # git repo (message history database)
├── {myProfileId}/                         # one dir per logged-in account
│   ├── AUTH.json                          # profile info, auth status (committed)
│   ├── COOKIES.json                       # cookie jar (gitignored, sensitive)
│   ├── config.json                        # proxy, rate limits (committed)
│   ├── INBOX.jsonl                        # new message notifications (gitignored, ephemeral)
│   ├── listen.log                         # SSE debug log (gitignored)
│   │
│   ├── {convId}/                          # one dir per conversation (canonical key)
│   │   ├── RECORD.json                    # contact + conversation + sync state
│   │   └── messages/YYYY-MM.jsonl         # message history
│   │
│   ├── {profileId} -> {convId}            # symlink: contact profile ID → conversation
│   └── alice-smith -> {convId}         # symlink: real LinkedIn slug → conversation
│
├── mockuser -> {myProfileId}             # symlink: account login slug
└── dan-moore -> {myProfileId}             # symlink: account name slug
```

**Gitignored inside .lilac:** `COOKIES.json`, `INBOX.jsonl`, `listen.log`

**Three lookups, all O(1):**
- `convId` → direct directory
- `profileId` → symlink → convId
- `slug` → symlink → convId

---

## Part 2 — Slug resolution (real LinkedIn publicIdentifier)

Slugs are NEVER name-derived. They come from LinkedIn's profile API.

**New function: `getProfileSlugById(client, profileId) → string | null`**
- Calls `voyagerIdentityDashProfiles` GraphQL with profileId as `memberIdentity`
- Parses the full response (including `included` array) for `publicIdentifier` or a profile URL containing the real slug
- Returns the slug or null if not resolvable

**When slug resolution happens:**
- **sync**: after pulling conversations, resolve slug for each new contact. Rate-limited with exponential backoff. Can take minutes for large backlogs — that's fine, sync is backgroundable.
- **listen**: when an inbound message arrives from an unknown contact, one profile lookup to resolve slug.
- **send**: no slug resolution needed (user already provides the target).

**Exponential backoff (applies to all LinkedIn API calls during sync):**
- Success → 1s base delay between requests
- 429 / 5xx → double delay (1s → 2s → 4s → 8s → ... → 60s cap), retry
- 403 → double delay + warn
- 401 → abort sync entirely, tell user to re-login (session expired)
- Reset delay to base after each success

**If slug resolution fails after retries:** store `slug: null` in RECORD.json, skip the slug symlink. No guessing, no name-derived fallback. Slug can be resolved later on next sync or when listen encounters the contact.

---

## Part 3 — RECORD.json (per conversation)

Three canonical IDs at the top. Must match the filesystem — any mismatch is a hard error.

```ts
interface ConversationRecord {
  // === Three IDs (define the mapping) ===
  convId: string;                // directory name
  profileId: string;             // contact's LinkedIn profile ID
  slug: string | null;           // real LinkedIn publicIdentifier, or null if unresolved

  // === LinkedIn URNs (for API calls) ===
  convUrn: string;               // urn:li:msg_conversation:...
  backendUrn: string | null;     // urn:li:messagingThread:...
  profileUrn: string;            // urn:li:fsd_profile:{profileId}
  memberUrn: string | null;      // urn:li:member:{numericId}

  // === Contact info (cached from API) ===
  firstName: string;
  lastName: string;
  name: string;                  // "{firstName} {lastName}"
  headline: string | null;
  profileUrl: string | null;
  profilePictures: { width: number; height: number; url: string }[] | null;
  distance: string | null;       // DISTANCE_1, DISTANCE_2, etc.
  pronoun: string | null;
  memberBadgeType: string | null;
  isPremium: boolean;
  isVerified: boolean;

  // === Conversation state (cached from API) ===
  unreadCount: number;
  lastActivityAt: string | null;
  lastReadAt: string | null;
  createdAt: string | null;
  read: boolean;
  notificationStatus: string | null;
  categories: string[];
  conversationUrl: string | null;
  disabledFeatures: string[];

  // === Sync metadata ===
  syncState: SyncState;
  fetchedAt: string;
}
```

---

## Part 4 — Account files (AUTH.json + COOKIES.json)

Split because they update at different cadences:

**AUTH.json** (committed, updates on login/sync):
```
urn, profileSlug, name, headline, profileUrl, imageUrl, userType, networkSize, status, lastSyncAt
```

**COOKIES.json** (gitignored, updates on every API call):
```
cookieJar, cookiesUpdatedAt
```

---

## Part 5 — Git as database

`.lilac/` is its own git repo. Message history is the commit log.

**Commit strategy:**
- `send` → commit immediately
- `sync` → one commit at end
- `listen` → debounce 60 seconds

**Remote (optional):**
- Set at login: `lilac login --git-remote git@github.com:user/li-messages.git`
- Stored in `config.json` as `git.remote`
- Auto-push after each commit if configured (`git.autoPush: true`)
- Pull on login if remote has history (restore on new machine)

---

## Part 6 — Channel (MCP server for Claude Code)

`src/channel/index.ts` — small MCP server (~100 lines) that makes lilac "always on":

```
Claude Code (--channels plugin:lilac-channel)
    └── lilac-channel (MCP server, spawned by CC)
            ├── spawns `lilac listen --json` as subprocess
            ├── forwards inbound messages as <channel> events → Claude
            └── exposes tools:
                - reply(slug, text) → calls `lilac send`
                - search(query) → calls `lilac search`
                - history(slug, limit) → calls `lilac messages`
```

Launch: `claude --channels plugin:lilac-channel`

---

## Part 7 — INBOX.jsonl (filesystem notification fallback)

For non-channel use (hooks, scripts, pipes):

`lilac listen` appends a summary line to `INBOX.jsonl` for each inbound message. A Claude Code `user-prompt-submit` hook reads and clears it. Gitignored.

For pipe orchestration:
```bash
lilac listen --json | while read -r event; do
  claude "New LinkedIn message: $event"
done
```

---

## Part 8 — Search

**`src/store/search.ts`** — fuzzy name matching with confidence scores:
- 100: exact slug or profileId match
- 95: exact name (case-insensitive)
- 80: name starts with query
- 70: every query word matches word-start in name ("ali smi" → "Alice Smith")
- 60: name contains query
- 40: any query word in name

**`src/commands/search.ts`** — `lilac search <query> [--account] [--json] [--limit N]`

---

## Part 9 — Skills

| Skill | Invocation | Purpose |
|-------|-----------|---------|
| `search-contact/SKILL.md` | User or agent | Find contacts via `lilac search` |
| `send-message/SKILL.md` | User only (`disable-model-invocation: true`) | search → confirm → send |
| `read-conversation/SKILL.md` | User or agent | search → `lilac messages` → formatted thread |
| `lilac-reference/SKILL.md` | Auto-loaded (`user-invocable: false`) | Store layout, URNs, event shapes |

---

## Implementation order

| # | What | Files | Notes |
|---|------|-------|-------|
| 1 | Types rewrite | `src/store/types.ts` | New `ConversationRecord`, delete `ContactRecord` |
| 2 | Shared alias util | `src/store/alias.ts` (NEW) | Symlink creation with conflict detection |
| 3 | Profile slug resolver | `src/linkedin/api/endpoints/profiles.ts` | New `getProfileSlugById()` function |
| 4 | Unified ConversationStore | `src/store/conversations.ts` (REWRITE) | Replaces both old stores |
| 5 | Account AUTH/COOKIES split | `src/store/accounts.ts` | Two files instead of one |
| 6 | Store index | `src/store/index.ts` | `forAccount()` returns `ConversationStore` |
| 7 | Slug util update | `src/utils/slug.ts` | Unicode normalization |
| 8 | Update sync | `src/commands/sync.ts` | Slug resolution per contact, single store |
| 9 | Update listen | `src/commands/listen.ts` | Single store, INBOX.jsonl writes |
| 10 | Update send | `src/commands/send.ts` | Use `conversations.resolve()` |
| 11 | Update remaining commands | `messages.ts`, `conversations.ts`, `login.ts`, `logout.ts`, `status.ts`, `store-cmd.ts` | |
| 12 | Search | `src/store/search.ts`, `src/commands/search.ts` (NEW) | + register in index.ts |
| 13 | Channel | `src/channel/index.ts` (NEW) | MCP server wrapping listen/send/search |
| 14 | Skills | `.claude/skills/` (NEW) | 4 skill files |
| 15 | Tests | `tests/unit/store.test.ts` (REWRITE), `search.test.ts`, `alias.test.ts` (NEW) | |
| 16 | Wipe + verify | Delete `.lilac/`, login, sync, test all paths | |

## Files to delete
- `src/store/contacts.ts` — merged into conversations.ts

## Existing features preserved
All existing commands (login, logout, status, sync, listen, conversations, messages, send, store) are kept. Core behaviors (pre-send abort, message deduplication, git auto-commit, VCR test infra) are unchanged. Group chat support intentionally excluded for now.
