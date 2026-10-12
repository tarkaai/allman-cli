/**
 * Group threads have no slug alias, so every per-conversation command must
 * resolve them by bare convId (`2-…`, case preserved). Network is mocked —
 * nothing here touches LinkedIn.
 *
 *   - `send --dry-run <convId>` resolves the group and performs no write
 *   - `send <convId>` (mocked transport) posts to the group's thread URN
 *   - `send <slug>` for a group member still goes to their 1:1, never the group
 *   - `messages <convId>` and `read <convId>` resolve the group
 *   - `conversations` marks group threads in text output and carries the
 *     group fields in --json
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { conversationsCommand } from "@/commands/conversations.js";
import { messagesCommand } from "@/commands/messages.js";
import { readCommand } from "@/commands/read.js";
import { sendCommand } from "@/commands/send.js";
import { type ConversationStore, Store } from "@/store/index.js";
import type { AccountRecord, ConversationRecord, StoredMessage } from "@/store/types.js";
import { setJsonMode } from "@/utils/output.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@/linkedin/api/client.js", () => ({
  buildApiClient: vi.fn(() => ({ updateJar: vi.fn(), request: vi.fn() })),
  LinkedInError: class LinkedInError extends Error {},
}));

const mockFindConversationByRecipient = vi.fn().mockResolvedValue(null);
const mockMarkConversationsRead = vi.fn().mockResolvedValue(undefined);
vi.mock("@/linkedin/api/endpoints/conversations.js", () => ({
  findConversationByRecipient: (...args: unknown[]) => mockFindConversationByRecipient(...args),
  listConversations: vi.fn().mockResolvedValue({ conversations: [], nextCursor: null }),
  markConversationsRead: (...args: unknown[]) => mockMarkConversationsRead(...args),
}));

const mockGetProfileUrnBySlug = vi.fn();
vi.mock("@/linkedin/api/endpoints/profiles.js", () => ({
  getProfileUrnBySlug: (...args: unknown[]) => mockGetProfileUrnBySlug(...args),
  getProfileSlugById: vi.fn().mockResolvedValue(null),
}));

const mockFetchMessages = vi.fn();
const mockSendMessage = vi.fn();
const mockSendFirstMessage = vi.fn();
vi.mock("@/linkedin/api/endpoints/messages.js", () => ({
  fetchMessages: (...args: unknown[]) => mockFetchMessages(...args),
  sendMessage: (...args: unknown[]) => mockSendMessage(...args),
  sendFirstMessage: (...args: unknown[]) => mockSendFirstMessage(...args),
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

const baseState = {
  memberUrn: null,
  headline: null,
  profileUrl: null,
  profilePictures: null,
  distance: null,
  pronoun: null,
  memberBadgeType: null,
  isPremium: false,
  isVerified: false,
  unreadCount: 0,
  lastActivityAt: "2026-08-13T00:00:00.000Z",
  lastReadAt: null,
  createdAt: "2026-08-01T00:00:00.000Z",
  read: true,
  notificationStatus: null,
  categories: [],
  conversationUrl: null,
  disabledFeatures: [],
  syncState: {
    oldestMessageAt: 1786980600000,
    newestMessageAt: 1786981000000,
    lastSyncAt: "2026-08-13T00:00:00.000Z",
    totalSynced: 1,
    fullyBackfilled: false,
  },
  fetchedAt: "2026-08-13T00:00:00.000Z",
};

const groupRecord: ConversationRecord = {
  convId: GROUP_CONV_ID,
  profileId: ALICE_ID,
  slug: null,
  isGroup: true,
  title: null,
  participants: [
    {
      profileId: ALICE_ID,
      profileUrn: `urn:li:fsd_profile:${ALICE_ID}`,
      backendUrn: `urn:li:msg_messagingParticipant:urn:li:fsd_profile:${ALICE_ID}`,
      slug: "alice-example",
      firstName: "Alice",
      lastName: "Example",
      name: "Alice Example",
      headline: null,
      profileUrl: null,
      profilePictures: null,
      distance: null,
      pronoun: null,
      memberBadgeType: null,
      isPremium: false,
      isVerified: false,
    },
    {
      profileId: BOB_ID,
      profileUrn: `urn:li:fsd_profile:${BOB_ID}`,
      backendUrn: `urn:li:msg_messagingParticipant:urn:li:fsd_profile:${BOB_ID}`,
      slug: "bob-example",
      firstName: "Bob",
      lastName: "Example",
      name: "Bob Example",
      headline: null,
      profileUrl: null,
      profilePictures: null,
      distance: null,
      pronoun: null,
      memberBadgeType: null,
      isPremium: false,
      isVerified: false,
    },
  ],
  convUrn: `urn:li:msg_conversation:(${ME},${GROUP_CONV_ID})`,
  backendUrn: GROUP_THREAD_URN,
  profileUrn: `urn:li:fsd_profile:${ALICE_ID}`,
  firstName: "Alice",
  lastName: "Example",
  name: "Alice Example, Bob Example",
  ...baseState,
};

const bobRecord: ConversationRecord = {
  convId: ONE_CONV_ID,
  profileId: BOB_ID,
  slug: "bob-example",
  convUrn: `urn:li:msg_conversation:(${ME},${ONE_CONV_ID})`,
  backendUrn: `urn:li:messagingThread:${ONE_CONV_ID}`,
  profileUrn: `urn:li:fsd_profile:${BOB_ID}`,
  firstName: "Bob",
  lastName: "Example",
  name: "Bob Example",
  ...baseState,
};

const groupMessage: StoredMessage = {
  urn: "urn:li:messagingMessage:2-msgA",
  timestamp: 1786981000000,
  fromUrn: `urn:li:fsd_profile:${ALICE_ID}`,
  fromName: "Alice Example",
  isFromMe: false,
  body: "Hi both",
  reactions: [],
  attachments: [],
  originToken: null,
};

function captureStdout(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    lines.push(String(chunk));
    return true;
  });
  return { lines, restore: () => spy.mockRestore() };
}

function captureStderr(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    lines.push(String(chunk));
    return true;
  });
  return { lines, restore: () => spy.mockRestore() };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("group threads — command resolution by bare convId", () => {
  let tempDir: string;
  let store: Store;
  let conversations: ConversationStore;

  beforeEach(async () => {
    vi.clearAllMocks();
    // `printData` honours the global json mode that the CLI entry sets from --json.
    setJsonMode(true);
    mockFetchMessages.mockResolvedValue({ messages: [], hasMore: false });
    tempDir = await mkdtemp(join(tmpdir(), "allman-group-cmd-"));
    store = new Store({ path: tempDir, gitDebounceMs: 0 });
    await store.init();
    await store.accounts.write(ME_ID, accountRecord);
    await store.accounts.createAlias("test-user", ME_ID);
    conversations = store.forAccount(ME_ID);
    await conversations.upsert(ONE_CONV_ID, bobRecord);
    await conversations.upsert(GROUP_CONV_ID, groupRecord);
    await conversations.appendMessages(GROUP_CONV_ID, [groupMessage]);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("send --dry-run <convId> resolves the group thread and performs no write", async () => {
    const out = captureStdout();
    try {
      await sendCommand(GROUP_CONV_ID, "hello everyone", {
        store: tempDir,
        json: true,
        dryRun: true,
      });
    } finally {
      out.restore();
    }
    const preview = JSON.parse(out.lines.join(""));
    expect(preview).toMatchObject({
      dryRun: true,
      convId: GROUP_CONV_ID,
      conversationUrn: GROUP_THREAD_URN,
      name: "Alice Example, Bob Example",
      isGroup: true,
      participants: ["Alice Example", "Bob Example"],
      isNewConversation: false,
      text: "hello everyone",
    });
    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(mockSendFirstMessage).not.toHaveBeenCalled();
    expect(mockFetchMessages).not.toHaveBeenCalled();
    expect(mockGetProfileUrnBySlug).not.toHaveBeenCalled();
  });

  it("send --dry-run prints a human preview naming the group", async () => {
    const err = captureStderr();
    try {
      await sendCommand(GROUP_CONV_ID, "hello everyone", { store: tempDir, dryRun: true });
    } finally {
      err.restore();
    }
    const text = err.lines.join("");
    expect(text).toContain("dry-run");
    expect(text).toContain("Alice Example, Bob Example (group)");
    expect(text).toContain(GROUP_CONV_ID);
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it("send <convId> (mocked transport) posts to the group's thread URN and stores the message", async () => {
    mockSendMessage.mockResolvedValue({
      messageUrn: "urn:li:messagingMessage:2-sent1",
      conversationUrn: groupRecord.convUrn,
      backendConversationUrn: GROUP_THREAD_URN,
      deliveredAt: 1786982000000,
    });
    const out = captureStdout();
    try {
      await sendCommand(GROUP_CONV_ID, "hello everyone", { store: tempDir, json: true });
    } finally {
      out.restore();
    }
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    expect(mockSendMessage.mock.calls[0]?.[1]).toBe(GROUP_THREAD_URN);
    expect(mockSendFirstMessage).not.toHaveBeenCalled();

    const stored = await conversations.readMessages(GROUP_CONV_ID);
    expect(stored.map((m) => m.body)).toEqual(["Hi both", "hello everyone"]);
    const record = await conversations.read(GROUP_CONV_ID);
    expect(record?.isGroup).toBe(true);
    expect(record?.slug).toBeNull();
    expect(record?.syncState.newestMessageAt).toBe(1786982000000);
  });

  it("send <slug> for a group member goes to their 1:1 thread, never the group", async () => {
    mockSendMessage.mockResolvedValue({
      messageUrn: "urn:li:messagingMessage:2-sent2",
      conversationUrn: bobRecord.convUrn,
      backendConversationUrn: bobRecord.backendUrn,
      deliveredAt: 1786982000000,
    });
    const out = captureStdout();
    try {
      await sendCommand("bob-example", "just you", { store: tempDir, json: true });
    } finally {
      out.restore();
    }
    expect(mockSendMessage.mock.calls[0]?.[1]).toBe(`urn:li:messagingThread:${ONE_CONV_ID}`);

    // Alice has no 1:1 thread. Her slug must not resolve to the group she is
    // the first participant of; it falls through to a new-conversation path.
    vi.clearAllMocks();
    mockGetProfileUrnBySlug.mockResolvedValue(`urn:li:fsd_profile:${ALICE_ID}`);
    mockFindConversationByRecipient.mockResolvedValue(null);
    const out2 = captureStdout();
    const err2 = captureStderr();
    try {
      await sendCommand("alice-example", "new thread?", {
        store: tempDir,
        json: true,
        dryRun: true,
      });
    } finally {
      out2.restore();
      err2.restore();
    }
    const preview = JSON.parse(out2.lines.join(""));
    expect(preview.isNewConversation).toBe(true);
    expect(preview.convId).toBeNull();
    expect(preview.isGroup).toBe(false);
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it("messages <convId> resolves the group thread", async () => {
    const out = captureStdout();
    try {
      await messagesCommand(GROUP_CONV_ID, { store: tempDir, json: true, noSync: true });
    } finally {
      out.restore();
    }
    const printed = JSON.parse(out.lines.join("")) as StoredMessage[];
    expect(printed).toHaveLength(1);
    expect(printed[0]?.fromUrn).toBe(`urn:li:fsd_profile:${ALICE_ID}`);
  });

  it("read <convId> resolves the group thread and marks its msg_conversation URN", async () => {
    const out = captureStdout();
    try {
      await readCommand(GROUP_CONV_ID, { store: tempDir, json: true });
    } finally {
      out.restore();
    }
    expect(mockMarkConversationsRead).toHaveBeenCalledTimes(1);
    expect(mockMarkConversationsRead.mock.calls[0]?.[1]).toEqual([groupRecord.convUrn]);
    expect((await conversations.read(GROUP_CONV_ID))?.read).toBe(true);
  });

  it("conversations lists the group with a marker and the group fields in --json", async () => {
    setJsonMode(false);
    const text = captureStdout();
    try {
      await conversationsCommand({ store: tempDir });
    } finally {
      text.restore();
      setJsonMode(true);
    }
    const listing = text.lines.join("");
    expect(listing).toContain("Alice Example, Bob Example");
    expect(listing).toContain("(group, 2 others)");
    expect(listing).toContain("Bob Example");

    const json = captureStdout();
    try {
      await conversationsCommand({ store: tempDir, json: true });
    } finally {
      json.restore();
    }
    const records = JSON.parse(json.lines.join("")) as ConversationRecord[];
    const group = records.find((r) => r.convId === GROUP_CONV_ID);
    expect(group?.isGroup).toBe(true);
    expect(group?.participants?.map((p) => p.slug)).toEqual(["alice-example", "bob-example"]);
    const one = records.find((r) => r.convId === ONE_CONV_ID);
    expect(one && "isGroup" in one).toBe(false);
  });
});
