# lilac-cli — Architecture Plan

LinkedIn messenger from the CLI. A self-contained, file-backed, git-versioned tool
designed to be operated by humans and AI agents alike.

---

## 1. Goals

- Login to LinkedIn interactively (headed browser, handles all challenge flows)
- Send and receive messages via the LinkedIn Voyager internal API
- Stream real-time events (SSE) to stdout for AI agent consumption
- Pull conversation history ("catchup") on demand
- Store all data locally as files in a git-tracked `.lilac/` directory
- Support multiple LinkedIn accounts, each with independent processes
- Support HTTP proxies (per account)
- Ship as a single binary (no Node/Bun runtime required on target machine)

---

## 2. Technology Stack

| Concern | Choice | Rationale |
|---|---|---|
| Runtime | Bun (latest) | Single binary via `bun build --compile`, fast startup |
| Language | TypeScript (strict) | Direct port of existing lilac/api logic |
| CLI framework | `commander` | Simple, scriptable, no magic |
| Browser automation | `playwright` (Chromium) | Headed mode for interactive login; more capable than puppeteer |
| HTTP client | `axios` + `tough-cookie` | Matches existing implementation exactly |
| Proxy tunneling | `tunnel` | Matches existing implementation |
| Git integration | `simple-git` | Auto-commit on writes |
| Testing | `vitest` | Fast, ESM-native |
| Linting/formatting | `biome` | Single tool, fast |

---

## 3. File Store Structure

The store lives in `.lilac/` relative to cwd by default, overridable via `--store <path>`
or `LILAC_STORE` env var.

```
.lilac/
├── .git/                               # auto-initialized, auto-committed
├── accounts/
│   └── {linkedin-slug}/               # e.g. "chris-example"
│       ├── RECORD.json                # profile + auth state (see below)
│       └── config.json                # display name, proxy settings
├── contacts/
│   └── {linkedin-slug}/               # e.g. "sarah-chen" (from linkedin.com/in/sarah-chen)
│       └── RECORD.json                # profile data + URN lookup
└── conversations/
    └── {slug}/                        # e.g. "sarah-chen" for 1:1, "group-engineering" for groups
        ├── RECORD.json                # conversation metadata + URN
        └── messages/
            └── 2026-03.jsonl          # NDJSON, one message per line, partitioned by month
```

### RECORD.json schemas

**accounts/{slug}/RECORD.json**
```json
{
  "urn": "urn:li:fsd_profile:ABC123",
  "name": "Chris Example",
  "headline": "...",
  "profileUrl": "https://www.linkedin.com/in/chris-example/",
  "imageUrl": "...",
  "userType": "basic",
  "networkSize": 500,
  "status": "authenticated",
  "cookies": [...],
  "cookiesUpdatedAt": "2026-03-30T12:00:00Z",
  "lastSyncAt": "2026-03-30T12:00:00Z"
}
```

`status` values: `"unauthenticated"` | `"authenticated"` | `"expired"`

Cookies are stored inline (not a separate file) to keep the record atomic. The cookies
array matches the existing `Cookie[]` interface from `lilac/api`.

**contacts/{slug}/RECORD.json**
```json
{
  "urn": "urn:li:fsd_profile:XYZ456",
  "name": "Sarah Chen",
  "headline": "CTO at Acme Corp",
  "profileUrl": "https://www.linkedin.com/in/sarah-chen/",
  "imageUrl": "...",
  "connectedAt": "2025-01-15T00:00:00Z",
  "fetchedAt": "2026-03-30T12:00:00Z"
}
```

**conversations/{slug}/RECORD.json**
```json
{
  "urn": "urn:li:msg_conversation:...",
  "backendUrn": "urn:li:messagingThread:...",
  "title": "Sarah Chen",
  "isGroup": false,
  "account": "chris-example",
  "participants": [
    { "slug": "chris-example", "urn": "urn:li:fsd_profile:ABC123", "name": "Chris Example" },
    { "slug": "sarah-chen", "urn": "urn:li:fsd_profile:XYZ456", "name": "Sarah Chen" }
  ],
  "unreadCount": 0,
  "lastActivityAt": "2026-03-30T11:00:00Z",
  "createdAt": "2025-06-01T00:00:00Z"
}
```

**messages/2026-03.jsonl** (one JSON object per line)
```json
{"urn":"urn:li:msg_message:AAA","timestamp":1748722800000,"fromUrn":"urn:li:fsd_profile:XYZ456","fromName":"Sarah Chen","fromSlug":"sarah-chen","isFromMe":false,"body":"Hey, want to catch up?","reactions":[],"attachments":[],"originToken":null}
{"urn":"urn:li:msg_message:BBB","timestamp":1748722900000,"fromUrn":"urn:li:fsd_profile:ABC123","fromName":"Chris Example","fromSlug":"chris-example","isFromMe":true,"body":"Absolutely! When works for you?","reactions":[],"attachments":[],"originToken":"uuid-here"}
```

Attachment types stored verbatim from LinkedIn response: images, videos, GIFs, link
previews, voice notes. The `body` field may be empty for media-only messages.

---

## 4. Command Reference

```
lilac login [--account <name>] [--proxy <host:port[:user:pass]>]
            Opens a headed Chromium window. User completes login interactively
            (password, 2FA, app notification, captcha — whatever LinkedIn throws).
            CLI waits for authenticated state, extracts cookies, saves RECORD.json.

lilac logout [--account <name>]
             Clears cookies from RECORD.json, sets status to "unauthenticated".

lilac status [--account <name>] [--json]
             Shows auth status, cookie age, proxy config.

lilac sync [--account <name>] [--since <3mo|6mo|1y|YYYY-MM-DD>]
           Pulls conversation list + messages from LinkedIn into the file store.
           Commits to git after completion. Default: --since 3mo.

lilac listen [--account <name>]
             Long-running process. Connects to LinkedIn SSE stream.
             Streams NDJSON events to stdout. Writes received messages to file store.
             Auto-commits to git (debounced, 5s after last write).
             Outputs heartbeat events every 30s so the consumer can detect stalls.

lilac conversations [--account <name>] [--json] [--limit N]
                    Lists conversations from local file store.
                    Human output: name, last message preview, timestamp.
                    --json: full RECORD.json data.

lilac messages <conversation> [--account <name>] [--json] [--limit N] [--since <date>]
               <conversation> can be:
                 - LinkedIn profile URL: https://linkedin.com/in/sarah-chen
                 - Profile slug:         sarah-chen
                 - Conversation URN:     urn:li:msg_conversation:...
               Reads from local file store.

lilac send <conversation> <text> [--account <name>] [--json]
           <conversation> same resolution as above.
           Sends via LinkedIn API, writes sent message to file store, commits.

lilac store path             Print the resolved store path.
lilac store commit [message] Manual git commit.
lilac store status           Show git status of the store.
```

Global flags (all commands):
```
--account <name>    Account slug (default: first account found, or $LILAC_ACCOUNT)
--store <path>      Store directory (default: ./.lilac, or $LILAC_STORE)
--json              Machine-readable JSON output
--debug             Verbose logging to stderr
```

---

## 5. NDJSON Event Schema (`lilac listen` output)

All events go to stdout. Errors and debug logs go to stderr. This keeps the stdout
stream parseable regardless of what else happens.

```json
{ "event": "connected", "account": "chris-example", "timestamp": 1748722800000 }

{ "event": "message.received",
  "account": "chris-example",
  "timestamp": 1748722800000,
  "conversation": { "urn": "...", "slug": "sarah-chen", "title": "Sarah Chen", "isGroup": false },
  "from": { "urn": "...", "slug": "sarah-chen", "name": "Sarah Chen", "headline": "CTO at Acme" },
  "message": { "urn": "...", "body": "Hey!", "isFromMe": false, "attachments": [] }
}

{ "event": "message.sent",
  "account": "chris-example",
  "timestamp": 1748722900000,
  "conversation": { "urn": "...", "slug": "sarah-chen", "title": "Sarah Chen", "isGroup": false },
  "message": { "urn": "...", "body": "Hello!", "isFromMe": true }
}

{ "event": "typing", "account": "chris-example", "conversation": { ... }, "from": { ... }, "timestamp": ... }

{ "event": "read_receipt", "account": "chris-example", "conversation": { ... }, "timestamp": ... }

{ "event": "heartbeat", "account": "chris-example", "timestamp": 1748723000000 }

{ "event": "error", "account": "chris-example", "code": "COOKIE_EXPIRED", "message": "...", "timestamp": ... }
```

---

## 6. Authentication Flow

Because LinkedIn's login is interactive (app notifications, TOTP, email codes, captcha,
device verification), we always use a headed browser. There is no headless fast-path for
initial authentication.

```
lilac login
  │
  ├─ 1. Read existing RECORD.json if account exists (to pre-load cookies)
  │
  ├─ 2. Launch Playwright Chromium (headed)
  │      - If cookies exist, inject them before navigation (may skip login entirely)
  │
  ├─ 3. Navigate to https://www.linkedin.com/login
  │      - If already authenticated (cookies valid), skip to step 5
  │
  ├─ 4. Wait for user to complete login in browser window
  │      - User types credentials, handles 2FA/app notification/captcha manually
  │      - CLI polls for authenticated state: URL contains /feed or /in/
  │      - Timeout: 5 minutes (configurable)
  │
  ├─ 5. Extract cookies from browser context
  │      - Use playwright page.context().cookies()
  │      - Filter for linkedin.com domain
  │
  ├─ 6. Intercept profile URN
  │      - Set up route handler for voyagerIdentityDashProfiles before navigating to /in/
  │      - Extract urn:li:fsd_profile:... from response
  │
  ├─ 7. Extract profile data
  │      - Name, headline, image from page DOM
  │
  ├─ 8. Save RECORD.json
  │      - status: "authenticated", cookies, profile data
  │
  └─ 9. Git commit "login: {account}"
```

**Re-authentication** (cookies expired):
`lilac listen` and other commands detect `401` or redirect-to-login responses. They emit
`{ "event": "error", "code": "COOKIE_EXPIRED" }` to stdout and exit with code `1`. The
operator must run `lilac login` to re-authenticate.

---

## 7. Cookie Management

Direct port from `lilac/api`. Key invariants:

- Cookies stored as `Cookie[]` in `accounts/{slug}/RECORD.json`
- `JSESSIONID` cookie value (stripped of quotes) == `csrf-token` header value
- Every API response is checked for `Set-Cookie` headers; new cookies are merged
  using a name-keyed map (new values win)
- Expired cookies (by `expires` timestamp) are filtered before use
- `tough-cookie` used for RFC 6265 compliant parsing of `Set-Cookie` headers
- Cookies are saved to disk after every merge operation

Cookie flow in every API request:
```
Read RECORD.json cookies
  → filter expired
  → build "Cookie: name=value; name=value" header
  → extract csrf-token from JSESSIONID
  → make request
  → parse Set-Cookie headers from response
  → merge with existing cookies (name-keyed map)
  → write updated RECORD.json
  → git commit (debounced)
```

---

## 8. LinkedIn API Client

Base: `https://www.linkedin.com/voyager/api/`

Standard headers (sent with every request):
```
Accept: application/vnd.linkedin.normalized+json+2.1
Accept-Language: en-US,en;q=0.9
Content-Type: application/json
csrf-token: {JSESSIONID without quotes}
Cookie: {all valid cookies}
x-restli-protocol-version: 2.0.0
x-li-track: {"clientVersion":"1.13.8751","mpVersion":"1.13.8751","osName":"web","timezoneOffset":-5,"timezone":"America/New York","deviceFormFactor":"DESKTOP","mpName":"voyager-web","displayDensity":1,"displayWidth":2560,"displayHeight":1440}
x-li-recipe-accept: application/vnd.linkedin.normalized+json+2.1
x-li-recipe-map: {"inAppAlertsTopic":"com.linkedin.voyager.dash.deco.identity.notifications.InAppAlert-51","professionalEventsTopic":"com.linkedin.voyager.dash.deco.events.ProfessionalEventDetailPage-53","topCardLiveVideoTopic":"com.linkedin.voyager.dash.deco.video.TopCardLiveVideo-9"}
x-li-lang: en_US
x-li-page-instance: urn:li:page:feed_index_index;bcfe9fd6-239a-49e9-af15-44b7e5895eaa
Referer: https://www.linkedin.com/feed/
Authority: www.linkedin.com
User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36
sec-ch-ua: "Not_A Brand";v="8", "Chromium";v="120"
sec-ch-ua-mobile: ?0
sec-ch-ua-platform: "Linux"
sec-fetch-dest: empty
sec-fetch-mode: cors
sec-fetch-site: same-origin
```

Source: `monorepo/lib/services/src/lib/external-integrations/linkedin/api/linkedin-api-services.ts`
(originally pulled from https://github.com/beeper/linkedin)

Proxy support: `tunnel.httpsOverHttp()` wraps the axios agent when proxy is configured.
Per-account in `config.json`.

### Key endpoints (all confirmed from monorepo + mautrix)

**List conversations (GraphQL, paginated by cursor or timestamp):**
```
GET /voyager/api/voyagerMessagingGraphQL/graphql
  ?queryId=messengerConversations.45338e053010d1c19147f92de6de3ae6
  &variables=(query:(predicateUnions:List((conversationCategoryPredicate:(category:PRIMARY_INBOX)))),count:20,mailboxUrn:urn%3Ali%3Afsd_profile%3A{profileUrn},lastUpdatedBefore:{timestampMs})
  # For cursor pagination replace lastUpdatedBefore with: nextCursor:{cursor}
```

**Get conversation by recipients (find existing thread):**
```
GET /voyager/api/voyagerMessagingGraphQL/graphql
  ?queryId=messengerConversations.44030325d8f59d8cebbb804f16d6b0a3
  &variables=(recipients:List(urn%3Ali%3Afsd_profile%3A{contactUrn}),mailboxUrn:urn%3Ali%3Afsd_profile%3A{userUrn},count:20)
```

**Get messages (by anchor timestamp, paginated backwards):**
```
GET /voyager/api/voyagerMessagingGraphQL/graphql
  ?queryId=messengerMessages.90abe2bc64df3bc3e1323a1479989b49
  &variables=(deliveredAt:{timestampMs},conversationUrn:{encodedConvUrn},countBefore:20,countAfter:0)
  # encodedConvUrn = url-encoded urn:li:msg_conversation:(urn:li:fsd_profile:{senderUrn},{convUrn})
```

**Get profile URN from public identifier:**
```
GET /voyager/api/graphql
  ?queryId=voyagerIdentityDashProfiles.b5c27c04968c409fc0ed3546575b9b7a
  &variables=(memberIdentity:{publicIdentifier},...)
```

**Send message:**
```
POST /voyager/api/voyagerMessagingDashMessengerMessages?action=createMessage
Body: {
  message: { body: { attributes:[], text }, renderContentUnions:[], conversationUrn, originToken },
  mailboxUrn: "urn:li:fsd_profile:{senderUrn}",
  trackingId: <UUID-as-byte-string>,
  dedupeByClientGeneratedToken: false
}
```

**Create new conversation (first message to a contact):**
```
POST /voyager/api/voyagerMessagingDashMessengerMessages?action=createMessage
Body: same as send, but conversationUrn is omitted and hostRecipientUrns is added:
  hostRecipientUrns: ["urn:li:fsd_profile:{contactUrn}"]
```

**SSE real-time stream:**
```
GET https://www.linkedin.com/realtime/connect?rc=1
Accept: text/event-stream
responseType: stream (axios)
```

**Heartbeat (sent every 60s during listen):**
```
POST https://www.linkedin.com/realtime/realtimeFrontendClientConnectivityTracking
{ action:"sendHeartbeat", isFirstHeartbeat:bool, realtimeSessionId, mpName:"voyager-web", mpVersion:"1.13.8751", clientId:"voyager-web", actorUrn, contextUrns:[actorUrn] }
```

### Alternative/newer GraphQL query IDs (from mautrix, may be more current)
- Conversations: `messengerConversations.8656fb361a8ad0c178e8d3ff1a84ce26`
- Conversations with sync token: `messengerConversations.74c17e85611b60b7ba2700481151a316`
- Messages by anchor: `messengerMessages.4088d03bc70c91c3fa68965cb42336de`
- Messages by cursor: `messengerMessages.34c9888be71c8010fecfb575cb38308f`

If monorepo query IDs stop working, try these. LinkedIn rotates them periodically.

---

## 9. Real-time SSE Client

LinkedIn uses SSE (Server-Sent Events), not WebSocket.

```
GET https://www.linkedin.com/realtime/connect?rc=1
Accept: text/event-stream
```

Each event is a line: `data: {JSON}`. Lines are processed via `readline`.

Handled event types (extracted from `topic` field via regex `/:(\w+):urn:li-realtime/`):
- `messagesTopic` → message received/sent echo
- `typingIndicatorsTopic` → typing indicator
- `readReceiptsTopic` → read receipt
- `ClientConnection` → connection established (contains connection ID)
- `Heartbeat` → keep-alive (update last-activity timestamp)

The SSE client reconnects automatically on disconnect with exponential backoff (1s, 2s,
4s, 8s, max 60s). Each reconnect re-reads fresh cookies from disk (in case another
process updated them).

---

## 10. Multi-Account Model

Each account is independent. Commands default to the first account found (alphabetical),
or the `--account` flag, or `$LILAC_ACCOUNT` env var.

For parallel operation, run one `lilac listen` process per account:
```bash
lilac listen --account dan-work   &
lilac listen --account dan-sales  &
```

Each process:
- Reads/writes only its own account's cookies
- Writes to the shared contacts/ and conversations/ directories
- Uses file-level locking (via a `.lock` file) before writing RECORD.json to prevent
  races when multiple accounts share a contact

---

## 11. Source Layout

```
lilac-cli/
├── src/
│   ├── index.ts                    # CLI entry point
│   ├── commands/
│   │   ├── login.ts
│   │   ├── logout.ts
│   │   ├── status.ts
│   │   ├── listen.ts
│   │   ├── sync.ts
│   │   ├── conversations.ts
│   │   ├── messages.ts
│   │   ├── send.ts
│   │   └── store.ts
│   ├── linkedin/
│   │   ├── auth/
│   │   │   └── playwright-auth.ts  # headed browser login, cookie extraction
│   │   ├── api/
│   │   │   ├── client.ts           # axios client, header builder, cookie updater
│   │   │   ├── cookies.ts          # tough-cookie helpers, JSESSIONID extraction
│   │   │   ├── proxy.ts            # tunnel.httpsOverHttp setup
│   │   │   └── endpoints/
│   │   │       ├── conversations.ts
│   │   │       ├── messages.ts
│   │   │       └── profiles.ts
│   │   └── realtime/
│   │       └── sse-client.ts       # SSE stream, readline parsing, reconnect logic
│   ├── store/
│   │   ├── index.ts                # Store class, path resolution, git init
│   │   ├── git.ts                  # simple-git wrapper, debounced auto-commit
│   │   ├── accounts.ts             # read/write accounts/*/RECORD.json
│   │   ├── contacts.ts             # read/write contacts/*/RECORD.json
│   │   ├── conversations.ts        # read/write conversations/*/RECORD.json
│   │   └── messages.ts             # JSONL append/read, month partitioning
│   └── utils/
│       ├── urn.ts                  # URN parse/build helpers
│       ├── slug.ts                 # linkedin.com/in/slug extraction
│       ├── output.ts               # human vs --json output helpers
│       └── resolve.ts              # "sarah-chen" / URL / URN → conversation lookup
├── tests/
│   ├── unit/
│   │   ├── cookies.test.ts
│   │   ├── urn.test.ts
│   │   ├── slug.test.ts
│   │   ├── store.test.ts
│   │   └── sse-parser.test.ts
│   └── integration/
│       ├── api-client.test.ts      # mock axios responses
│       └── sync.test.ts            # mock LinkedIn API, assert file store output
├── PLAN.md
├── CLAUDE.md
├── package.json
├── tsconfig.json
├── biome.json
└── vitest.config.ts
```

---

## 12. Testing Strategy

**Unit tests** (fast, no network, no browser):
- Cookie merging, expiry filtering, JSESSIONID extraction
- URN parsing and construction
- LinkedIn URL → slug extraction
- File store read/write/JSONL append
- SSE line parser (given raw data lines, assert correct event objects)

**Integration tests** (mock network):
- API client: mock axios with `vitest`'s `vi.mock`, assert correct headers/cookies sent
- Sync flow: mock LinkedIn API responses, assert correct RECORD.json and JSONL written
- Cookie update flow: mock response with Set-Cookie headers, assert cookie file updated

**Manual / E2E** (not automated in CI):
- `lilac login` against real LinkedIn (requires human interaction by definition)
- `lilac listen` with real credentials

Test fixtures: use recorded LinkedIn API response payloads (sanitized) stored in
`tests/fixtures/`.

---

## 13. Build & Distribution

```bash
bun build --compile --minify src/index.ts --outfile dist/lilac
```

Produces a single ~30MB binary. No Bun/Node runtime required on target.

Playwright's Chromium is NOT bundled — it installs separately via:
```bash
lilac install-browsers   # runs: npx playwright install chromium
```

Or users can point to an existing Chromium via `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`.

---

## 14. Rate Limiting

LinkedIn enforces per-account messaging limits. We enforce our own floor to avoid bans.

**Default:** minimum 3 seconds between outbound messages per account.
**Configurable:** via `config.json` `rateLimit.minMessageIntervalMs` (default: 3000).
**Implementation:** A per-account token bucket stored in memory while `lilac listen`
or `lilac send` is running. On send, acquire the token; if unavailable, wait.

Error response from LinkedIn when rate-limited: typically HTTP 429. We treat 429 as
a retryable error with 60s backoff before re-queuing.

---

## 15. VCR Test Infrastructure

Tests must not hit the real LinkedIn API. We implement a record/replay system:

**Record mode** (`LILAC_VCR=record bun test`):
- Wraps the axios client with a response interceptor
- After each real response, serializes `{ url, method, status, headers, data }` to
  `tests/fixtures/{sanitized-url}.json`
- Cookie values are redacted in saved fixtures

**Replay mode** (default in CI/tests):
- Axios adapter reads from fixtures directory instead of making real requests
- Keyed by `{method}:{url-without-query-params}:{queryId-if-present}`
- Throws if no fixture found (prevents silent test gaps)

Fixture files live in `tests/fixtures/` and are committed to the repo (sanitized).
The VCR infrastructure lives in `tests/vcr.ts`.

---

## 16. Sync State Tracking

Each conversation's `RECORD.json` contains a `syncState` field:

```json
{
  "syncState": {
    "oldestMessageAt": 1738368000000,
    "newestMessageAt": 1748722800000,
    "lastSyncAt": "2026-03-30T12:00:00Z",
    "totalSynced": 247,
    "fullyBackfilled": false
  }
}
```

**Sync algorithm:**
1. Start from `now` as anchor timestamp
2. Fetch 20 messages before anchor (countBefore:20, countAfter:0)
3. Append to JSONL store, update `newestMessageAt` / `oldestMessageAt`
4. Move anchor to oldest message in batch
5. Repeat until: 100 messages fetched, or `last_message_sync_at` crossed, or batch empty
6. Update `syncState.lastSyncAt` and `totalSynced`

**Pre-send sync:** Before sending a message, `lilac send` fetches the latest messages
(anchor = now, countBefore:5, countAfter:0). If any inbound messages are newer than
the last known message in the store, they are written to the store and the user/agent
is warned via stderr: `⚠ New inbound messages received before send. Review before proceeding.`
The send then proceeds (agent/user can interrupt if needed).

---

## 17. Thread Creation Flow

When `lilac send` targets a contact with no existing conversation:

1. Look up contact URN from `contacts/{slug}/RECORD.json`
2. Query `getConversationByRecipients` → if found, use it
3. If not found: first send creates the conversation via `action=createMessage` without
   a `conversationUrn` but with `hostRecipientUrns: ["urn:li:fsd_profile:{contactUrn}"]`
4. LinkedIn returns `backendConversationUrn` in the response — save to new RECORD.json
5. Graceful errors:
   - `NOT_CONNECTED`: "You are not connected with {name} on LinkedIn"
   - `MESSAGING_BLOCKED`: "This person has restricted who can message them"
   - `PREMIUM_REQUIRED`: "Sending to this person requires LinkedIn Premium (InMail)"

---

## 18. References

- `monorepo/lib/services/src/lib/external-integrations/linkedin/api/linkedin-api-services.ts` — confirmed query IDs and request formats
- `lilac/api/src/services/` — cookie management, SSE stream handler, send payload format
- https://github.com/mautrix/linkedin — Go implementation, alternative query IDs, WebSocket details
- https://github.com/beeper/linkedin — original Python implementation (headers sourced from here)
- `/Users/example/Projects/tarka/playground/linkedin/linkedin.js` — 26MB obfuscated LinkedIn bundle (last resort for undocumented endpoints)

---

## 19. Open Questions / Future Work

- **Sending to new contacts** (no existing conversation): Need to initiate a new
  conversation. LinkedIn API supports this but requires special handling.
- **Message reactions**: Can be sent via a separate endpoint (not in scope for v1).
- **File/image attachments**: Requires multipart upload flow (not in scope for v1).
- **Connection requests**: Out of scope for v1 (messaging only).
- **Sales Navigator**: The `userType` field is tracked; API differences not yet mapped.
