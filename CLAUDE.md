# CLAUDE.md — allman-cli

LinkedIn messenger CLI. File-backed, git-versioned, designed for AI agents and humans.

## Key references

Before writing any LinkedIn API code, read these files first:
- `/Users/example/Projects/tarka/allman/api/src/services/api/linkedin-api-client.ts` — exact headers, cookie handling
- `/Users/example/Projects/tarka/allman/api/src/services/session/cookie-set.ts` — cookie merge logic
- `/Users/example/Projects/tarka/allman/api/src/services/realtime/stream-handler.ts` — SSE parsing
- `/Users/example/Projects/tarka/allman/api/src/services/messaging/message-sender.ts` — send payload format
- `/Users/example/Projects/tarka/allman/api/src/services/auth/linkedin-auth.ts` — auth flow

The monorepo at `/Users/example/Projects/tarka/monorepo` also has LinkedIn API response type definitions.

## Stack

- **Bun** (latest via asdf) — runtime and build tool
- **TypeScript** (strict) — language
- **commander** — CLI framework
- **playwright** (Chromium, headed) — browser auth only
- **axios** + **tough-cookie** — HTTP client
- **tunnel** — HTTP proxy support
- **simple-git** — git auto-commit
- **vitest** — testing
- **biome** — lint + format

## Architecture summary

See `PLAN.md` for full details. Short version:

```
src/index.ts                 CLI entry (commander)
src/commands/                One file per subcommand
src/linkedin/auth/           Playwright-based interactive login
src/linkedin/api/            Axios client with LinkedIn headers + cookie management
src/linkedin/realtime/       SSE stream client with reconnect
src/store/                   File store: RECORD.json files + JSONL messages + git
src/utils/                   URN helpers, slug extraction, output formatting
tests/unit/                  Fast, no network
tests/integration/           Mock network responses
```

## File store layout

```
.allman/
├── .git/
├── {myProfileId}/
│   ├── AUTH.json                    # profile info, auth status (committed)
│   ├── COOKIES.json                 # cookie jar (gitignored)
│   ├── config.json                  # proxy, rate limits (committed)
│   ├── rate-state.json              # last send timestamp (gitignored)
│   ├── {convId}/
│   │   ├── RECORD.json              # contact + conversation + sync state
│   │   └── messages/YYYY-MM.jsonl
│   ├── {profileId} -> {convId}      # symlink: contact profile ID → conversation
│   └── {slug} -> {convId}           # symlink: LinkedIn slug → conversation
└── {accountSlug} -> {myProfileId}   # symlink: account slug → profile dir
```

Slug = the LinkedIn `publicIdentifier` (e.g. `linkedin.com/in/sarah-chen` → `sarah-chen`).

## Critical patterns

### Cookie management
Every API call must:
1. Read cookies from `accounts/{slug}/RECORD.json`
2. Filter out expired cookies
3. Build `Cookie:` header string
4. Extract `csrf-token` from `JSESSIONID` value (strip surrounding quotes)
5. After response: parse `Set-Cookie` headers with `tough-cookie`, merge by name, save back

### URN construction for send
```
conversationUrn in payload: urn:li:msg_conversation:(urn:li:fsd_profile:{senderUrn},{conversationUrn})
mailboxUrn: urn:li:fsd_profile:{senderUrn}
originToken: UUID v4
trackingId: UUID v4 converted to byte array (see existing message-sender.ts)
```

For **new conversations** (no existing thread), omit `conversationUrn` from the `message` object
entirely — do not set it to empty string. LinkedIn returns 400 if it is present but malformed.

### Rate limiting
Outbound message sends are rate-limited per account. Default: 3000ms between sends.

- Enforced inside `LinkedInApiClient.request()` on every `POST` to the messages endpoint
- State persisted to `rate-state.json` (`lastMessageSentAt`) — survives process restarts
- Configurable via `config.json`: `rateLimit.minMessageIntervalMs`
- **All send paths are automatically rate-limited** — no per-command opt-in needed

### SSE parsing
Stream from `https://www.linkedin.com/realtime/connect?rc=1` with `Accept: text/event-stream`.
Lines arrive as `data: {JSON}`. Extract event type from `topic` field via:
`topic.match(/:(\w+):urn:li-realtime/)` → group 1 is the event type key.

### stdout vs stderr
`allman listen` streams NDJSON to **stdout**. All logs, errors, debug output go to **stderr**.
This separation is mandatory — agents parse stdout.

## Commands

```
allman login [--account <slug>] [--proxy host:port[:user:pass]]
allman logout [--account <slug>]
allman status [--account <slug>] [--json]
allman sync [--account <slug>] [--since 3mo|6mo|1y|YYYY-MM-DD]
allman listen [--account <slug>]
allman conversations [--account <slug>] [--json] [--limit N]
allman messages <contact-slug|url|urn> [--account <slug>] [--json] [--limit N]
allman send <contact-slug|url|urn> <text> [--account <slug>] [--json]
allman store path|commit|status
```

## Environment variables

```
ALLMAN_STORE        Override default store path (default: ./.allman)
ALLMAN_ACCOUNT      Default account slug
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH  Use existing Chromium
```

## Development

```bash
bun install
bun run dev          # runs src/index.ts directly
bun test             # vitest
bun run build        # bun build --compile → dist/allman
```

Never install packages without using `bun add <package>` (or `bun add -d <package>`
for dev deps). Always install to get the latest version — don't assume a version exists.

## Testing

Unit tests: `tests/unit/` — no network, no filesystem side effects (use temp dirs).
Integration tests: `tests/integration/` — mock axios, assert file store state.

Use `vitest`'s `vi.mock` for axios. Use real temp directories (via `os.tmpdir()`) for
store tests — don't mock the filesystem.

Recorded LinkedIn API fixtures go in `tests/fixtures/`.
