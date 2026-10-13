/**
 * `allman sync` and `allman listen` with a group thread in the inbox.
 *
 * Network is fully mocked (recorded-style fixture through the real parser);
 * assertions are on the temp file store:
 *   - the group thread is written under its bare convId with the group shape
 *   - its messages land in the JSONL with `fromUrn` as the fsd_profile URN
 *   - no alias symlinks are created for the group; the 1:1 in the same page
 *     keeps its aliases and its legacy shape
 *   - a re-sync performs no further slug lookups for the group
 *   - listen materializes an unknown group thread instead of skipping it
 */

import { readFileSync } from "node:fs";
import { lstat, mkdtemp, readFile, readlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchAndUpsertConversation } from "@/commands/listen.js";
import { syncCommand } from "@/commands/sync.js";
import { parseConversationsResponse } from "@/linkedin/api/endpoints/conversations.js";
import type { MessageData } from "@/linkedin/api/endpoints/messages.js";
import { Store } from "@/store/index.js";
import type { AccountRecord, ConversationRecord, StoredMessage } from "@/store/types.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@/linkedin/api/client.js", () => ({
  buildApiClient: vi.fn(() => ({ updateJar: vi.fn(), request: vi.fn() })),
  LinkedInError: class LinkedInError extends Error {},
}));

const mockListConversations = vi.fn();
vi.mock("@/linkedin/api/endpoints/conversations.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/linkedin/api/endpoints/conversations.js")>();
  return {
    ...actual,
    listConversations: (...args: unknown[]) => mockListConversations(...args),
  };
});

const mockFetchMessages = vi.fn();
vi.mock("@/linkedin/api/endpoints/messages.js", () => ({
  fetchMessages: (...args: unknown[]) => mockFetchMessages(...args),
}));

const mockGetProfileSlugById = vi.fn();
vi.mock("@/linkedin/api/endpoints/profiles.js", () => ({
  getProfileSlugById: (...args: unknown[]) => mockGetProfileSlugById(...args),
}));

vi.mock("@/utils/rate-limiter.js", () => {
  const stub = { acquire: vi.fn().mockResolvedValue(undefined) };
  return {
    getRateLimiter: vi.fn(() => stub),
    buildRateLimiter: vi.fn(() => stub),
    getDownloadRateLimiter: vi.fn(() => stub),
    RateLimiter: class {},
    DownloadRateLimiter: class {},
  };
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ME_ID = "ACoSYNTHME000000000000000000000000001";
const ME = `urn:li:fsd_profile:${ME_ID}`;
const ALICE_ID = "ACoSYNTHALICE0000000000000000000001";
const BOB_ID = "ACoSYNTHBOB000000000000000000000001";
const GROUP_CONV_ID = "2-R3JvdXBTeW50aGV0aWNUaHJlYWQ=";
const ONE_CONV_ID = "2-T25lVG9PbmVTeW50aGV0aWM=";
const GROUP_THREAD_URN = `urn:li:messagingThread:${GROUP_CONV_ID}`;

const fixture = JSON.parse(
  readFileSync(join(__dirname, "../fixtures/group-conversations-page.json"), "utf8")
);

const accountRecord: AccountRecord = {
  urn: ME,
  profileSlug: "test-user",
  name: "Test User",
  headline: null,
  profileUrl: "https://www.linkedin.com/in/test-user/",
  imageUrl: null,
  userType: "basic",
  networkSize: 500,
  status: "authenticated",
  cookieJar: null,
  cookiesUpdatedAt: null,
  lastSyncAt: null,
};

function message(
  id: string,
  fromUrn: string,
  fromName: string,
  body: string,
  deliveredAt: number
): MessageData {
  return {
    urn: `urn:li:messagingMessage:${id}`,
    deliveredAt,
    fromUrn,
    fromName,
    body,
    bodyAttributes: [],
    subject: null,
    renderFormat: "DEFAULT",
    fallbackText: null,
    conversationUrn: GROUP_THREAD_URN,
    reactions: [],
    attachments: [],
    originToken: null,
  } as unknown as MessageData;
}

const GROUP_MESSAGES: MessageData[] = [
  message("2-msgB", `urn:li:fsd_profile:${BOB_ID}`, "Bob Example", "Sounds good", 1786981000000),
  message("2-msgA", `urn:li:fsd_profile:${ALICE_ID}`, "Alice Example", "Hi both", 1786980800000),
  message("2-msgMe", ME, "Test User", "Hello Alice and Bob", 1786980600000),
];

const slugs: Record<string, string | null> = {
  [ALICE_ID]: "alice-example",
  [BOB_ID]: "bob-example",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("sync — group conversations", () => {
  let tempDir: string;
  let store: Store;
  let accountDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tempDir = await mkdtemp(join(tmpdir(), "allman-group-sync-"));
    store = new Store({ path: tempDir, gitDebounceMs: 0 });
    await store.init();
    await store.accounts.write(ME_ID, accountRecord);
    await store.accounts.createAlias("test-user", ME_ID);
    accountDir = join(tempDir, ME_ID);

    mockListConversations.mockResolvedValue({
      conversations: parseConversationsResponse(fixture),
      nextCursor: null,
    });
    mockFetchMessages.mockImplementation(async (_client: unknown, convUrn: string) => ({
      messages: convUrn === GROUP_THREAD_URN ? GROUP_MESSAGES : [],
      hasMore: false,
    }));
    mockGetProfileSlugById.mockImplementation(
      async (_client: unknown, id: string) => slugs[id] ?? null
    );
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("writes the group thread, its messages, and no aliases; keeps the 1:1 intact", async () => {
    await syncCommand({ store: tempDir, from: "2025-01-01", json: true });

    // --- group record -----------------------------------------------------
    const raw = await readFile(join(accountDir, GROUP_CONV_ID, "RECORD.json"), "utf8");
    const group = JSON.parse(raw) as ConversationRecord;
    expect(group).toMatchObject({
      convId: GROUP_CONV_ID,
      isGroup: true,
      title: null,
      slug: null,
      name: "Alice Example, Bob Example",
      profileId: ALICE_ID,
      profileUrn: `urn:li:fsd_profile:${ALICE_ID}`,
      firstName: "Alice",
      lastName: "Example",
      backendUrn: GROUP_THREAD_URN,
      unreadCount: 1,
    });
    expect(group.participants?.map((p) => [p.profileId, p.slug, p.backendUrn])).toEqual([
      [ALICE_ID, "alice-example", `urn:li:msg_messagingParticipant:urn:li:fsd_profile:${ALICE_ID}`],
      [BOB_ID, "bob-example", `urn:li:msg_messagingParticipant:urn:li:fsd_profile:${BOB_ID}`],
    ]);
    expect(group.syncState.totalSynced).toBe(3);
    expect(group.syncState.newestMessageAt).toBe(1786981000000);

    // --- group messages ---------------------------------------------------
    const jsonl = await readFile(
      join(accountDir, GROUP_CONV_ID, "messages", "2026-08.jsonl"),
      "utf8"
    );
    const lines = jsonl
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as StoredMessage);
    expect(lines).toHaveLength(3);
    const fromAlice = lines.find((m) => m.body === "Hi both");
    expect(fromAlice?.fromUrn).toBe(`urn:li:fsd_profile:${ALICE_ID}`);
    expect(fromAlice?.isFromMe).toBe(false);
    // The sender URN matches participants[].profileUrn — the documented join key.
    expect(group.participants?.some((p) => p.profileUrn === fromAlice?.fromUrn)).toBe(true);
    expect(lines.find((m) => m.body === "Hello Alice and Bob")?.isFromMe).toBe(true);

    // --- no aliases for the group ------------------------------------------
    await expect(lstat(join(accountDir, ALICE_ID))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(join(accountDir, "alice-example"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    // --- 1:1 from the same page is unchanged -------------------------------
    const one = JSON.parse(
      await readFile(join(accountDir, ONE_CONV_ID, "RECORD.json"), "utf8")
    ) as ConversationRecord;
    expect("isGroup" in one).toBe(false);
    expect("participants" in one).toBe(false);
    expect(one).toMatchObject({ profileId: BOB_ID, slug: "bob-example", name: "Bob Example" });
    expect(await readlink(join(accountDir, BOB_ID))).toBe(ONE_CONV_ID);
    expect(await readlink(join(accountDir, "bob-example"))).toBe(ONE_CONV_ID);

    // Slug lookups: Bob once (for the 1:1, reused by the group), Alice once.
    const lookedUp = mockGetProfileSlugById.mock.calls.map((c) => c[1]);
    expect(lookedUp.sort()).toEqual([ALICE_ID, BOB_ID].sort());
  }, 20_000);

  it("a re-sync performs no further slug lookups for the group", async () => {
    await syncCommand({ store: tempDir, from: "2025-01-01", json: true });
    const callsAfterFirst = mockGetProfileSlugById.mock.calls.length;
    await syncCommand({ store: tempDir, from: "2025-01-01", json: true });
    expect(mockGetProfileSlugById.mock.calls.length).toBe(callsAfterFirst);

    const group = JSON.parse(
      await readFile(join(accountDir, GROUP_CONV_ID, "RECORD.json"), "utf8")
    ) as ConversationRecord;
    expect(group.participants?.map((p) => p.slug)).toEqual(["alice-example", "bob-example"]);
    await expect(lstat(join(accountDir, ALICE_ID))).rejects.toMatchObject({ code: "ENOENT" });
  }, 20_000);
});

describe("listen — unknown group conversation", () => {
  let tempDir: string;
  let store: Store;

  beforeEach(async () => {
    vi.clearAllMocks();
    tempDir = await mkdtemp(join(tmpdir(), "allman-group-listen-"));
    store = new Store({ path: tempDir, gitDebounceMs: 0 });
    await store.init();
    await store.accounts.write(ME_ID, accountRecord);
    mockListConversations.mockResolvedValue({
      conversations: parseConversationsResponse(fixture),
      nextCursor: null,
    });
    mockGetProfileSlugById.mockImplementation(
      async (_client: unknown, id: string) => slugs[id] ?? null
    );
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("upserts the group thread instead of skipping it", async () => {
    const conversations = store.forAccount(ME_ID);
    const apiClient = { request: vi.fn() } as never;

    await fetchAndUpsertConversation(GROUP_THREAD_URN, ME, apiClient, conversations);

    const found = await conversations.findByUrn(GROUP_THREAD_URN);
    expect(found?.convId).toBe(GROUP_CONV_ID);
    expect(found?.record).toMatchObject({
      isGroup: true,
      slug: null,
      name: "Alice Example, Bob Example",
    });
    expect(found?.record.participants).toHaveLength(2);
    await expect(lstat(join(tempDir, ME_ID, ALICE_ID))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
