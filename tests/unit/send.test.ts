/**
 * Tests for the send command's pre-send sync abort behavior.
 *
 * Scenario: when new inbound messages are discovered during pre-send sync,
 * the send should be aborted and the messages shown to the user.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { Store } from "@/store/index.js";
import { sendCommand } from "@/commands/send.js";
import type { AccountRecord, ConversationRecord } from "@/store/types.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("simple-git", () => ({
  default: vi.fn(() => ({
    init: vi.fn().mockResolvedValue(undefined),
    add: vi.fn().mockResolvedValue(undefined),
    commit: vi.fn().mockResolvedValue(undefined),
    status: vi.fn().mockResolvedValue({ files: [] }),
    checkIsRepo: vi.fn().mockResolvedValue(true),
  })),
}));

vi.mock("@/linkedin/api/client.js", () => ({
  buildApiClient: vi.fn(() => ({
    updateJar: vi.fn(),
    get: vi.fn(),
    post: vi.fn(),
  })),
  LinkedInError: class LinkedInError extends Error {},
}));

vi.mock("@/linkedin/api/endpoints/conversations.js", () => ({
  findConversationByRecipient: vi.fn().mockResolvedValue(null),
  listConversations: vi.fn().mockResolvedValue({ conversations: [] }),
}));

vi.mock("@/linkedin/api/endpoints/profiles.js", () => ({
  getProfileUrnBySlug: vi.fn().mockResolvedValue("urn:li:fsd_profile:ACoXYZ456CONTACT1"),
}));

const mockFetchMessages = vi.fn();
const mockSendMessage = vi.fn();
const mockSendFirstMessage = vi.fn();

vi.mock("@/linkedin/api/endpoints/messages.js", () => ({
  fetchMessages: (...args: unknown[]) => mockFetchMessages(...args),
  sendMessage: (...args: unknown[]) => mockSendMessage(...args),
  sendFirstMessage: (...args: unknown[]) => mockSendFirstMessage(...args),
}));

vi.mock("@/utils/rate-limiter.js", () => ({
  getRateLimiter: vi.fn(() => ({ acquire: vi.fn().mockResolvedValue(undefined) })),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MY_PROFILE_ID = "ACoAATEST00000000000000000000000000000";
const CONTACT_PROFILE_ID = "ACoXYZ456CONTACT1";
const CONV_BARE_ID = "2-ZGQ2ZmM4MGItMjRmYy00M2YzLTg0MTEtNjgxMzYwMzM0ZjM3XzEwMA==";

const accountRecord: AccountRecord = {
  urn: `urn:li:fsd_profile:${MY_PROFILE_ID}`,
  profileSlug: "mockuser",
  name: "Test User",
  headline: null,
  profileUrl: "https://www.linkedin.com/in/mockuser/",
  imageUrl: null,
  userType: "basic",
  networkSize: 500,
  status: "authenticated",
  cookieJar: null,
  cookiesUpdatedAt: null,
  lastSyncAt: null,
};

const convRecord: ConversationRecord = {
  convId: CONV_BARE_ID,
  profileId: CONTACT_PROFILE_ID,
  slug: "example-user-1",
  convUrn: `urn:li:msg_conversation:(urn:li:fsd_profile:${MY_PROFILE_ID},${CONV_BARE_ID})`,
  backendUrn: `urn:li:messagingThread:${CONV_BARE_ID}`,
  profileUrn: `urn:li:fsd_profile:${CONTACT_PROFILE_ID}`,
  memberUrn: null,
  firstName: "James",
  lastName: "Foo",
  name: "James Foo",
  headline: null,
  profileUrl: null,
  profilePictures: null,
  distance: null,
  pronoun: null,
  memberBadgeType: null,
  isPremium: false,
  isVerified: false,
  unreadCount: 0,
  lastActivityAt: "2026-03-30T12:00:00Z",
  lastReadAt: null,
  createdAt: "2026-01-01T00:00:00Z",
  read: true,
  notificationStatus: null,
  categories: [],
  conversationUrl: null,
  disabledFeatures: [],
  syncState: {
    oldestMessageAt: 1000000000000,
    newestMessageAt: 1743350000000,
    lastSyncAt: "2026-03-30T00:00:00Z",
    totalSynced: 10,
    fullyBackfilled: false,
  },
  fetchedAt: "2026-03-30T00:00:00Z",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("send command — pre-send sync abort", () => {
  let tempDir: string;
  let store: Store;

  beforeEach(async () => {
    vi.clearAllMocks();
    tempDir = await mkdtemp(join(tmpdir(), "lilac-send-test-"));
    store = new Store({ path: tempDir, gitDebounceMs: 0 });
    await store.init();

    // Write account
    await store.accounts.write(MY_PROFILE_ID, accountRecord);
    await store.accounts.createAlias("mockuser", MY_PROFILE_ID);

    // Write conversation — upsert creates slug + profileId symlinks automatically
    const conversations = store.forAccount(MY_PROFILE_ID);
    await conversations.upsert(CONV_BARE_ID, convRecord);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("aborts send and prints new messages when inbound messages arrived since last sync", async () => {
    // Simulate 3 new inbound messages received since last sync (matching the real scenario)
    const newMessages = [
      {
        urn: "urn:li:msg_message:NEW1",
        deliveredAt: 1743360000001,
        fromUrn: `urn:li:fsd_profile:${CONTACT_PROFILE_ID}`,
        fromName: "James Foo",
        body: "Hey! Did you get my last message?",
        originToken: null,
        reactions: [],
        attachments: [],
      },
      {
        urn: "urn:li:msg_message:NEW2",
        deliveredAt: 1743360000002,
        fromUrn: `urn:li:fsd_profile:${CONTACT_PROFILE_ID}`,
        fromName: "James Foo",
        body: "Just wanted to follow up",
        originToken: null,
        reactions: [],
        attachments: [],
      },
      {
        urn: "urn:li:msg_message:NEW3",
        deliveredAt: 1743360000003,
        fromUrn: `urn:li:fsd_profile:${CONTACT_PROFILE_ID}`,
        fromName: "James Foo",
        body: "Let me know when you have a minute",
        originToken: null,
        reactions: [],
        attachments: [],
      },
    ];

    mockFetchMessages.mockResolvedValue({ messages: newMessages, hasMore: false });

    const stderrLines: string[] = [];
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderrLines.push(String(chunk));
      return true;
    });

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);

    await expect(
      sendCommand("example-user-1", "Hey, thanks!", { store: tempDir })
    ).rejects.toThrow("process.exit called");

    // Should have exited with code 1
    expect(exitSpy).toHaveBeenCalledWith(1);

    // sendMessage should NOT have been called
    expect(mockSendMessage).not.toHaveBeenCalled();

    // stderr should mention each new message body
    const allStderr = stderrLines.join("");
    expect(allStderr).toContain("new message(s) received before send");
    expect(allStderr).toContain("Hey! Did you get my last message?");
    expect(allStderr).toContain("Just wanted to follow up");
    expect(allStderr).toContain("Let me know when you have a minute");
    expect(allStderr).toContain("James Foo");

    stderrSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("proceeds when inbound messages exist but user already replied after them", async () => {
    // Inbound messages arrived, but user sent a reply AFTER them — no abort needed
    const newMessages = [
      {
        urn: "urn:li:msg_message:IN1",
        deliveredAt: 1743360000001,
        fromUrn: `urn:li:fsd_profile:${CONTACT_PROFILE_ID}`,
        fromName: "James Foo",
        body: "Hey",
        originToken: null,
        reactions: [],
        attachments: [],
      },
      {
        urn: "urn:li:msg_message:IN2",
        deliveredAt: 1743360000002,
        fromUrn: `urn:li:fsd_profile:${CONTACT_PROFILE_ID}`,
        fromName: "James Foo",
        body: "You're awesome",
        originToken: null,
        reactions: [],
        attachments: [],
      },
      {
        urn: "urn:li:msg_message:OUT1",
        deliveredAt: 1743360000003, // AFTER the inbounds
        fromUrn: `urn:li:fsd_profile:${MY_PROFILE_ID}`,
        fromName: "Test User",
        body: "Hey, thanks!",
        originToken: null,
        reactions: [],
        attachments: [],
      },
    ];

    mockFetchMessages.mockResolvedValue({ messages: newMessages, hasMore: false });

    mockSendMessage.mockResolvedValue({
      messageUrn: "urn:li:msg_message:SENT1",
      conversationUrn: `urn:li:msg_conversation:(urn:li:fsd_profile:${MY_PROFILE_ID},${CONV_BARE_ID})`,
      backendConversationUrn: `urn:li:messagingThread:${CONV_BARE_ID}`,
      deliveredAt: Date.now(),
    });

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);

    // Should NOT abort — user already replied
    await sendCommand("example-user-1", "I love you", { store: tempDir });

    expect(mockSendMessage).toHaveBeenCalledOnce();
    expect(exitSpy).not.toHaveBeenCalled();

    exitSpy.mockRestore();
  });

  it("proceeds with send when no new inbound messages", async () => {
    // No new messages since last sync
    mockFetchMessages.mockResolvedValue({ messages: [], hasMore: false });

    mockSendMessage.mockResolvedValue({
      messageUrn: "urn:li:msg_message:SENT1",
      conversationUrn: `urn:li:msg_conversation:(urn:li:fsd_profile:${MY_PROFILE_ID},${CONV_BARE_ID})`,
      backendConversationUrn: `urn:li:messagingThread:${CONV_BARE_ID}`,
      deliveredAt: Date.now(),
    });

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);

    // Should not throw
    await sendCommand("example-user-1", "Hey, thanks!", { store: tempDir });

    expect(mockSendMessage).toHaveBeenCalledOnce();
    expect(exitSpy).not.toHaveBeenCalled();

    exitSpy.mockRestore();
  });
});
