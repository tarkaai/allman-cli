# CLAUDE.md — allman-cli

LinkedIn messenger CLI. File-backed, git-versioned, designed for AI agents and humans.

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
│   ├── query-cache.json             # cached flagship search queryId (gitignored)
│   ├── {convId}/
│   │   ├── RECORD.json              # contact + conversation + sync state
│   │   └── messages/YYYY-MM.jsonl
│   ├── connections/                 # `connections`: {flagshipId}.json + {slug} symlinks
│   ├── connections-of/{targetId}/   # `connections-of`: RECORD.json + per-result files + symlinks
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

### Volume quotas (enrichment + invitations)
Enrichment and connection requests are the two most account-sensitive surfaces,
so they carry **persistent rolling-window volume caps** on top of the spacing
throttles. Defaults are seat-aware — a Sales Navigator seat is the signal that
an account is provisioned for higher-volume work:

| | with SalesNav seat | without |
|---|---|---|
| enrichment | 100 / hour | 25 / day |
| connection requests | 40 / day | 10 / day |

- Implemented in `utils/quota.ts` (pure rolling-window counter) +
  `utils/account-quota.ts` (store binding). Ledgers persist as timestamp arrays
  in `rate-state.json` (`enrichmentTimestamps`, `inviteTimestamps`), so **caps
  survive process restarts** — ten `enrich` runs don't each get a fresh
  allowance.
- Quotas **refuse rather than sleep** (windows are hours/days; blocking would
  hang the CLI). `enrich` stops early and reports when capacity returns;
  `connect` exits non-zero.
- A slot is claimed *before* the request and only for work actually done —
  skipped (already-enriched) records don't burn quota.
- **Counting unit differs by backend**, deliberately: flagship `enrich` charges
  **per profile** (matches the user-facing "100/hour"), while the SalesNav
  connections sweep is a bulk list operation charged per *page* of up to 100
  people — it is not billed as per-person enrichment.
- Override per account in `config.json` → `rateLimit`: `maxEnrichments`,
  `enrichmentWindowMs`, `maxInvitesPerDay`, `minInviteIntervalMs`.

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
allman connections [--salesnav|--flagship] [--limit N] [--csv <path>] [--no-save] [--include-headline] [--enrich [--deep]] [--json]
allman connections-of <slug> [--flagship|--salesnav] [--limit N] [--csv <path>] [--no-save] [--json]
allman enrich [target] [--deep] [--force] [--limit N] [--json]
allman connect <slug|url|urn> [--note <text>] [--dry-run] [--json]
allman store path|commit|status
```

### Connections (network export)
- `connections` (your 1st-degree) uses flagship `relationships/dash/connections`; `connections-of`
  defaults to Sales Navigator (`salesApiLeadSearch`) and falls back to flagship people search
  (`voyagerSearchDashClusters`) when there's no SalesNav seat. `--flagship`/`--salesnav` force a
  backend (no fallback). IDs only — never fetch a profile page.
- SalesNav seat = the `li_a` cookie that `login` captures by visiting `/sales/` (best-effort,
  `--no-salesnav` to skip). The flagship search queryId rotates per deploy and is auto-discovered
  from the live bundle (headless) and cached in `query-cache.json`; `ALLMAN_SEARCH_CLUSTERS_QID`
  overrides.
- Both commands **store by default** (per-entity files + slug symlinks via `ConnectionsStore`,
  git-committed, idempotent firstSeenAt/lastSeenAt). `--csv <path>` also exports; `--no-save` skips
  the store; `--json` streams NDJSON to stdout without storing. Pages are paced with a random 2–8s
  delay (`utils/random-delay.ts`).

### Connections backends (`connections --salesnav|--flagship`)
Two backends with **different identity models** — this is the thing to understand
before touching either:

| | flagship | Sales Navigator |
|---|---|---|
| resource | `relationships/dash/connections` | `salesApiLeadSearch` + `RELATIONSHIP:F` |
| identity | flagship id (`ACo…`) + **public slug** | salesnav id (`ACw…`) + **numeric member id** |
| profile data | none (needs `enrich`, 2 req/person) | title, company, location, about **inline** |
| page size | 100 | 100 (not 25) |
| depth cap | **none** observed | **2500, hard** — `start=2500` → HTTP 400 |
| extras | `connectedAt` | `degree`, `pendingInvitation` |

- **Default: flagship, always.** SalesNav is opt-in via `--salesnav` despite
  being richer, because its 2500 wall silently truncates any larger network.
  Don't "improve" this by defaulting to the seat.
- SalesNav results live in `connections-salesnav/{memberId}.json`, not merged
  into `connections/`, because the search returns no flagship id or slug.
- **The join key exists**: `salesApiProfiles?ids=List(...)` takes *flagship* ids
  and returns salesnav ids, **100 per request** (150 → 400) —
  `resolveSalesnavIdsFromFlagshipIds`. It is a genuine batched lookup over a
  known id set.
- **There is no per-person SalesNav enrichment.** `salesApiProfiles` with a
  field projection returns 400, and without one returns empty shells; rich
  SalesNav data only comes from the search sweep. Do NOT rebuild "SalesNav
  enrichment" by scanning the sweep for particular people — that is a
  brute-force search wearing a lookup's clothes, and it reads thousands of
  profiles to find a handful. Bulk SalesNav data belongs to
  `connections --salesnav`, where enumerating IS the operation.
- Only flagship records have slugs, so only they are usable as
  `allman send <slug>` / `connect <slug>` targets without a lookup.
- Not found (guessed names, all 404): `salesApiConnections`, `salesApiMyNetwork`,
  `salesApiRelationships`, `salesApiLeadLists`, `salesApiSavedLeads`. If a
  higher-capacity SalesNav enumeration endpoint exists, find it by driving the
  SalesNav UI in a browser and watching the network tab — don't guess names.

### Enrichment (`enrich`, `connections --enrich`)
- `connections` stores IDs + name + headline only. `enrich` does the per-profile
  fetch that fills in **title, company, location, about** (and, with `--deep`,
  work history + education + skills), writing them back onto each connection
  record with an `enrichedAt` / `enrichDepth` stamp. Idempotent: skips
  already-enriched records unless `--force` (a core→deep upgrade re-fetches).
- **Split across four resources** (all `identity/dash/*` API calls, not
  profile-page scrapes, so the `no-profile-pages` guard still holds):
  `profiles?q=memberIdentity` (name/headline/location/about),
  `profilePositions?q=viewee` (title/company/history),
  `profileEducations?q=viewee`, `profileSkills?q=viewee`.
  The core resource carries **no** positions/education/skills — verified against
  live responses — so title/company *always* costs a second request. Core = 2
  requests/profile, `--deep` = 4. The `?q=viewee` sub-resources take no
  decorationId, so they're immune to decoration rotation; only the core one
  needs `ALLMAN_PROFILE_DECORATION` if LinkedIn rotates it. `memberIdentity`
  accepts a slug **or** a flagship profile id.
- **Order matters**: `included[]` is unordered — resolve `data["*elements"]` to
  get LinkedIn's display order. Someone with several concurrent roles (CTO at
  one company, venture partner at another) reports the wrong current employer
  if you trust `included[]` order. Same idiom as `parseConnectionsResponse`.
- Location lives at `profile.geoLocation["*geo"]` → resolve into `included`.
  Never fall back to "any Geo in the graph": the graph also carries a
  country-level Geo, which silently downgrades a metro area to "United States".
- The legacy `identity/profiles/{slug}/profileView` aggregate (one call for
  everything) now returns **HTTP 410 Gone**.
- Fetches are paced with the same random 2–8s page delay. `enrich <slug>`
  enriches one person (adding them to the store if new).

### Connection requests (`connect`)
- `POST voyagerRelationshipsDashMemberRelationships?action=verifyQuotaAndCreateV2`
  with `{ invitee: { inviteeUnion: { memberProfile } }, customMessage? }`; success =
  an `invitationUrn` in the response. Sent invites are stored under
  `{profileId}/invitations/{inviteeId}.json` (+ slug symlink).
- **Conservative by default**: refuses to re-invite anyone already in
  `connections/` or already recorded in `invitations/`; caps the note at 300
  chars (`MAX_NOTE_LENGTH`); rate-limits invites on their **own** slow throttle
  (`rateLimit.minInviteIntervalMs`, default 60s, persisted as
  `rate-state.json:lastInviteSentAt`). A 403 is surfaced as a likely
  invitation-quota hit. `--dry-run` previews without sending.
- The pre-check is **local by necessity**: LinkedIn's `memberRelationships`
  REST resource returns HTTP 400 for every documented URL form (verified live
  2026-08-08; the `MemberRelationshipV2` decoration still exists in the bundle,
  so the data moved behind GraphQL). See `endpoints/relationships.ts`. A store
  miss means "not known locally", not "definitely not connected" — LinkedIn
  still rejects true duplicates server-side.

## Environment variables

```
ALLMAN_STORE        Override default store path (default: ./.allman)
ALLMAN_ACCOUNT      Default account slug
ALLMAN_SEARCH_CLUSTERS_QID  Override the flagship people-search queryId (else auto-discovered)
ALLMAN_PROFILE_DECORATION   Override the `enrich` profile decoration (else FullProfile default)
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
