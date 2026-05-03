# allman

LinkedIn messenger from the CLI. File-backed, git-versioned, designed for AI agents and humans.

Messages are stored locally as JSONL files in a git repository. All reads come from disk. Network calls go to LinkedIn's private APIs using cookies captured via a headed Playwright browser session.

> **Want a terminal inbox UI on top of this?** See the companion repo, [`tarkaai/allman-tui`](https://github.com/tarkaai/allman-tui). It bundles the `allman` binary, so installing the TUI gets you both.

---

## Installation

### From GitHub Releases (Linux and macOS, x64 and arm64)

```bash
curl -fsSL https://raw.githubusercontent.com/tarkaai/allman-cli/main/install.sh | bash
```

Pin a version or change the install prefix:

```bash
curl -fsSL .../install.sh | VERSION=2026-04-20.1-alpha bash
curl -fsSL .../install.sh | PREFIX=$HOME/.local bash
```

Or grab a binary directly from the [releases page](https://github.com/tarkaai/allman-cli/releases).

### From source

Requires [Bun](https://bun.sh) (latest, via asdf or direct install).

```bash
git clone git@github.com:tarkaai/allman-cli.git
cd allman-cli
bun install
bun run build          # produces dist/allman
```

Add `dist/allman` to your `$PATH`, or run directly with:

```bash
bun run dev -- <command> [options]
```

Playwright's Chromium browser is required for login only:

```bash
allman install-browsers
# or: bunx playwright install chromium
```

---

## Quick start

```bash
allman login                       # opens browser, saves session
allman sync                        # pull conversation history (default: since last sync)
allman conversations               # list conversations
allman messages sarah-chen         # show messages with sarah-chen
allman send sarah-chen "Hey!"      # send a message
allman listen                      # stream real-time events to stdout as NDJSON
```

---

## Commands

### Global flags

All commands accept these flags:

| Flag | Description |
|------|-------------|
| `-a, --account <slug>` | Account to use (default: `$ALLMAN_ACCOUNT`, or the only account if there is one) |
| `-s, --store <path>` | Store directory (default: `$ALLMAN_STORE`, or `./.allman`) |
| `--json` | Output as machine-readable JSON (stdout) |
| `--debug` | Verbose debug output to stderr |

---

### `allman login`

Authenticate with LinkedIn. Opens a headed Chromium browser. Complete the login in the browser window; cookies are captured automatically.

```bash
allman login
allman login --account your-account
allman login --proxy host:port
allman login --proxy host:port:username:password
```

On success, writes `AUTH.json` and `COOKIES.json` to the store and creates a slug symlink for the account.

**Options:**

| Flag | Description |
|------|-------------|
| `--account <slug>` | Account name to create or re-authenticate |
| `--proxy <host:port[:user:pass]>` | HTTP proxy for this account (saved to `config.json`) |

---

### `allman logout`

Clear session cookies for an account. Does not delete message history.

```bash
allman logout
allman logout --account your-account
```

---

### `allman status`

Show authentication status for one or all accounts.

```bash
allman status
allman status --account your-account
allman status --json
```

Output includes: profile slug, name, auth status, cookie validity, last sync time, proxy, and store path.

---

### `allman start`

Verify auth (login if needed), sync from the last sync date, then run `listen` indefinitely. Designed as a single entrypoint for daemon use.

```bash
allman start
allman start --account your-account
```

---

### `allman sync`

Pull conversation history from LinkedIn into the local store.

```bash
allman sync                         # sync all conversations since last sync
allman sync --since 3mo             # sync all conversations from 3 months ago
allman sync --since 2025-01-01      # sync from a specific date
allman sync sarah-chen              # sync only this conversation
```

**Behavior:**
- Default window: since `lastSyncAt` in `AUTH.json`. Falls back to 90 days if no prior sync.
- Fetches conversation list, then messages for each conversation.
- Resolves the contact's LinkedIn `publicIdentifier` (slug) via the profile API, with exponential backoff on rate limits.
- Writes `RECORD.json` and `messages/YYYY-MM.jsonl` files for each conversation.
- Auto-commits the store on completion.

**Options:**

| Flag | Description |
|------|-------------|
| `[conversation]` | Sync a single conversation (slug, profileId, or convId) |
| `--since <duration\|date>` | Duration (`1h`, `3d`, `1w`, `3mo`, `1y`) or ISO date (`YYYY-MM-DD`) |

---

### `allman listen`

Stream real-time LinkedIn events to **stdout** as NDJSON. All logs go to stderr.

```bash
allman listen
allman listen --account your-account

# Pipe to a handler
allman listen | while read -r event; do
  echo "Event: $event"
done
```

**Event types emitted:**

| Event | Description |
|-------|-------------|
| `connected` | SSE connection established |
| `heartbeat` | Keep-alive (every 60s) |
| `message.received` | Inbound message from a contact |
| `message.sent` | Outbound message echo (confirming delivery) |
| `typing` | Contact is typing |
| `read_receipt` | Contact read a message |
| `reaction` | Reaction added or removed |

Each event is a JSON object on a single line. Example:

```json
{"event":"message.received","account":"ACoAA...","timestamp":1704067200000,"conversation":{"urn":"urn:li:messagingThread:...","convId":"2-abc123","name":"Sarah Chen","slug":"sarah-chen"},"from":{"urn":"urn:li:fsd_profile:...","name":"Sarah Chen"},"message":{"urn":"urn:li:messagingMessage:...","body":"Hey, got a minute?","isFromMe":false}}
```

**Behavior:**
- Reconnects automatically with exponential backoff (1s → 2s → 4s → ... → 60s).
- Sends a heartbeat POST to LinkedIn every 60s to keep the connection alive.
- Persists received messages to the local store (JSONL files).
- Appends inbound messages to `INBOX.jsonl` (gitignored) for hook-based integrations.
- Schedules a debounced git commit after each new message (5s debounce).
- Fetches missing message body from the API when SSE delivers an empty body.
- Fetches and upserts conversation metadata for unknown conversations on first contact.

---

### `allman conversations` (alias: `convs`)

List conversations from the local store, sorted by most recent activity.

```bash
allman conversations
allman conversations --limit 20
allman conversations --json
```

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `-n, --limit <n>` | 50 | Max conversations to show |

---

### `allman messages <conversation>`  (alias: `msgs`)

Show messages for a conversation. Auto-syncs if the conversation is not found locally or if the last sync was more than 1 minute ago.

```bash
allman messages sarah-chen
allman messages sarah-chen --limit 100
allman messages sarah-chen --since 2025-01-01
allman messages "https://www.linkedin.com/in/sarah-chen"
allman messages "urn:li:messagingThread:2-abc123"
allman messages sarah-chen --no-sync   # skip auto-sync
```

The `<conversation>` argument accepts:
- LinkedIn profile slug (e.g. `sarah-chen`)
- LinkedIn profile URL (e.g. `https://www.linkedin.com/in/sarah-chen`)
- Conversation URN (e.g. `urn:li:messagingThread:2-abc123`)

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `-n, --limit <n>` | 50 | Max messages to show |
| `--since <date>` | — | ISO date filter |
| `--no-sync` | — | Skip auto-sync |

---

### `allman send <to> <text>`

Send a message to a LinkedIn contact.

```bash
allman send sarah-chen "Hey, how are you?"
allman send "https://www.linkedin.com/in/sarah-chen" "Hello!"
allman send "urn:li:messagingThread:2-abc123" "Following up"
```

The `<to>` argument accepts a slug, profile URL, or conversation URN.

**Behavior:**
- **Pre-send sync**: fetches the 10 most recent messages before sending. If there are new inbound messages since the last sync that arrived after your last reply, the send is **aborted** and the new messages are shown. Re-run after reading them.
- **New conversations**: if no existing thread is found (in local store or via LinkedIn API), starts a new conversation.
- **Rate limiting**: minimum 3000ms between sends (configurable). State persisted to `rate-state.json` across process restarts.
- Stores the sent message locally and commits the store.

---

### `allman search <query>`

Search contacts and conversations by name, slug, or profile ID. Fuzzy matching with confidence scores.

```bash
allman search "sarah"
allman search "ali smi"    # matches "Alice Smith"
allman search sarah-chen
allman search --limit 5 "sarah"
allman search --json "sarah"
```

**Confidence scoring:**

| Score | Match type |
|-------|-----------|
| 100 | Exact slug or profile ID |
| 95 | Exact name (case-insensitive) |
| 80 | Name starts with query |
| 70 | Every query word matches a word start in name (`"ali smi"` → `"Alice Smith"`) |
| 60 | Name or slug contains query as substring |
| 40 | Any query word found in name or slug |

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `-n, --limit <n>` | 10 | Max results |

---

### `allman inbox`

Show new messages since the last time `inbox` was run (watermark-based). Syncs first, then scans all conversations for inbound messages newer than the watermark.

```bash
allman inbox
allman inbox --since 1h        # override watermark
allman inbox --no-mark         # don't advance the watermark
allman inbox --limit 10
allman inbox --json
```

The watermark is stored in `inbox-state.json` (gitignored). On first run, defaults to 24 hours ago.

Per-conversation read tracking: if you sent a message to a conversation, that conversation is considered read up to the time of your send, so it won't appear in `inbox` unless a reply arrives after that.

**Options:**

| Flag | Description |
|------|-------------|
| `--since <duration\|date>` | Override watermark (`1h`, `3d`, `1w`, or ISO date) |
| `--no-mark` | Don't advance the watermark after viewing |
| `-n, --limit <n>` | Max conversations to show |

---

### `allman grep <query>`

Full-text search across all locally stored message bodies. Scans JSONL files directly.

```bash
allman grep "project proposal"
allman grep "contract" --since 3mo
allman grep "meeting" --limit 100
allman grep "invoice" --json
```

Results are sorted newest-first.

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `--since <duration\|date>` | — | Only search messages after this date |
| `-n, --limit <n>` | 50 | Max results |

---

### `allman store`

Manage the local file store.

```bash
allman store path              # print the store path
allman store status            # show account and conversation counts
allman store commit "message"  # manually trigger a git commit
```

---

### `allman install-browsers`

Install Playwright's Chromium browser (required for `allman login`).

```bash
allman install-browsers
```

---

## Local store layout

The store is a git repository. All message history is committed; session-sensitive files are gitignored.

```
.allman/
├── .git/
├── .gitignore
├── {myProfileId}/                    # one directory per logged-in account
│   ├── AUTH.json                     # profile info, auth status (committed)
│   ├── COOKIES.json                  # cookie jar (gitignored)
│   ├── config.json                   # proxy, rate limit config (committed)
│   ├── rate-state.json               # last send timestamp (gitignored)
│   ├── inbox-state.json              # inbox watermark (gitignored)
│   ├── INBOX.jsonl                   # new message log (gitignored)
│   ├── listen.log                    # SSE debug log (gitignored)
│   ├── {convId}/                     # one directory per conversation
│   │   ├── RECORD.json               # contact + conversation + sync metadata
│   │   └── messages/
│   │       ├── 2024-11.jsonl
│   │       └── 2025-01.jsonl
│   ├── {profileId} -> {convId}       # symlink: contact profile ID → conversation
│   └── {slug} -> {convId}           # symlink: LinkedIn slug → conversation
└── {accountSlug} -> {myProfileId}   # symlink: account slug → profile directory
```

**Gitignored:** `COOKIES.json`, `rate-state.json`, `inbox-state.json`, `INBOX.jsonl`, `listen.log`

### Committed to git

| File | Contents |
|------|----------|
| `AUTH.json` | Profile URN, slug, name, headline, `status`, `lastSyncAt` |
| `config.json` | Proxy config, rate limit settings, optional git remote |
| `{convId}/RECORD.json` | Contact info, conversation metadata, sync state |
| `{convId}/messages/YYYY-MM.jsonl` | Message history (one JSON object per line) |

### RECORD.json fields

| Field | Description |
|-------|-------------|
| `convId` | LinkedIn conversation ID (matches directory name) |
| `profileId` | Contact's LinkedIn profile ID |
| `slug` | Contact's LinkedIn `publicIdentifier`, or `null` if unresolved |
| `convUrn` | `urn:li:msg_conversation:...` |
| `backendUrn` | `urn:li:messagingThread:...` |
| `firstName`, `lastName`, `name` | Contact name |
| `headline` | Contact's LinkedIn headline |
| `unreadCount` | Unread message count (from last sync) |
| `lastActivityAt` | ISO timestamp of last conversation activity |
| `lastReadAt` | ISO timestamp of last read (used by `inbox`) |
| `syncState` | `oldestMessageAt`, `newestMessageAt`, `lastSyncAt`, `totalSynced` |

### Message JSONL format

Each line in a `YYYY-MM.jsonl` file is one message:

```json
{
  "urn": "urn:li:messagingMessage:...",
  "timestamp": 1704067200000,
  "fromUrn": "urn:li:fsd_profile:...",
  "fromName": "Jamie Rivera",
  "isFromMe": false,
  "body": "Hey, got a minute?",
  "reactions": [],
  "attachments": [],
  "originToken": null
}
```

Attachment types: `image`, `video`, `file`, `gif`, `link_preview`, `voice`, `other`.

### Git commit strategy

| Operation | Commit timing |
|-----------|--------------|
| `send` | Immediate on send |
| `sync` | One commit at end of sync |
| `listen` | Debounced — 5s after last write |
| `store commit` | Immediate (manual) |

---

## Key concepts

### Slug resolution

Slugs are the LinkedIn `publicIdentifier` (e.g. `sarah-chen` from `linkedin.com/in/sarah-chen`). They are never guessed from names — always fetched from the LinkedIn profile API.

During `sync`, each new contact's slug is resolved via the profile API with exponential backoff:
- Success: 1s base delay
- HTTP 429 or 5xx: delay doubles (1s → 2s → 4s → ... → 60s cap), then retry
- HTTP 401: abort sync, prompt user to re-login
- Unresolvable: `slug: null` stored in `RECORD.json`, symlink skipped

Once resolved, slugs are cached in `RECORD.json` and used for all subsequent lookups. Three O(1) lookups:
- `convId` → direct directory
- `profileId` → symlink → `convId`
- `slug` → symlink → `convId`

### Rate limiting

Outbound messages are rate-limited per account. Default: 3000ms minimum between sends.

- Enforced automatically on every message send
- State persisted to `rate-state.json` — survives process restarts
- Configurable in `config.json`: `rateLimit.minMessageIntervalMs`

To change the interval:

```json
// .allman/{profileId}/config.json
{
  "rateLimit": {
    "minMessageIntervalMs": 5000
  }
}
```

### Pre-send abort

Before sending, `allman send` fetches the 10 most recent messages from LinkedIn. If new inbound messages arrived since your last reply, the send is aborted and the new messages are printed to stderr. This prevents sending without reading context.

### SSE streaming

`allman listen` connects to `https://www.linkedin.com/realtime/connect?rc=1` with `Accept: text/event-stream`. The stream delivers `data: {JSON}` lines. Event type is extracted from the `topic` field.

The stream reconnects automatically on disconnect. A heartbeat POST is sent every 60s to keep the connection alive.

### stdout vs stderr

`allman listen` writes NDJSON events to **stdout**. All informational output, warnings, errors, and debug messages go to **stderr**. This separation is intentional — agents and pipes read stdout without log noise.

All other commands write human-readable output to stdout, and errors to stderr.

### Inbox watermark

`allman inbox` uses a per-account watermark (`inbox-state.json`) to track what has been seen. Each run:
1. Syncs from LinkedIn
2. Scans all conversations for inbound messages newer than the watermark
3. Advances the watermark to now (unless `--no-mark`)

Per-conversation: if you sent a message in a conversation, that conversation's read position is the time of your last send. A reply only appears in `inbox` if it arrives after your last send.

---

## Environment variables

| Variable | Description |
|----------|-------------|
| `ALLMAN_STORE` | Override default store path (default: `./.allman`) |
| `ALLMAN_ACCOUNT` | Default account slug (used when `--account` is not specified) |
| `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` | Use an existing Chromium binary for login |

---

## Architecture

```
src/index.ts                     CLI entry (commander), registers all commands
src/commands/                    One file per subcommand
src/linkedin/auth/
  playwright-auth.ts             Headed Chromium login, captures cookies
src/linkedin/api/
  client.ts                      Axios client with LinkedIn headers + cookie management
  cookies.ts                     Cookie jar loading, CSRF token extraction
  session.ts                     Session loading (reads account + initializes client)
  endpoints/
    conversations.ts             List conversations, find by recipient
    messages.ts                  Fetch messages, send message, send first message
    profiles.ts                  Resolve profile slug and URN by ID
src/linkedin/realtime/
  sse-client.ts                  SSE stream with reconnect + heartbeat
src/store/
  index.ts                       Store class (init, git, accounts, conversations)
  types.ts                       TypeScript types for all stored data
  accounts.ts                    AccountStore: AUTH.json, COOKIES.json, config, state
  conversations.ts               ConversationStore: RECORD.json, JSONL messages, symlinks
  git.ts                         Debounced git auto-commit
  alias.ts                       Symlink helpers (create, resolve)
  search.ts                      Fuzzy name search with confidence scoring
src/utils/
  output.ts                      stdout/stderr helpers, JSON mode, relativeTime
  rate-limiter.ts                Per-account message rate limiter
  slug.ts                        Extract slug from LinkedIn URL
  time.ts                        parseSince: duration/ISO string → Unix ms
  urn.ts                         URN parsing and construction helpers
```

### HTTP client

Every API request uses the stored cookie jar. After each response, `Set-Cookie` headers are merged by name and written back to `COOKIES.json`. The CSRF token is extracted from the `JSESSIONID` cookie value.

### Proxy support

Configured per account via `config.json`. Applied to all API calls for that account (not to the Playwright login browser, which uses system settings).

---

## Development

```bash
bun install
bun run dev -- <command>        # run without building
bun test                        # vitest (unit + integration)
bun run build                   # compile to dist/allman (standalone binary)
bun run lint                    # biome check
bun run lint:fix                # biome check --write
```

Tests are in `tests/unit/` (no network, temp dirs) and `tests/integration/` (mock axios).

Never install packages with `npm` or `yarn` — use `bun add <package>`.

---

## Contributing

Issues and pull requests welcome. For non-trivial changes, open an issue first so we can align on approach.

Before sending a PR:

```bash
bun test
bun run lint
```

## License

MIT — see [LICENSE](./LICENSE).

`allman` is named in tribute to [Eric Allman](https://en.wikipedia.org/wiki/Eric_Allman), author of sendmail.
