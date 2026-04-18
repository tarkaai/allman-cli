import { mkdtemp, readlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store } from "@/store/index.js";
import type { AccountRecord, ConversationRecord, StoredMessage } from "@/store/types.js";

// Note: simple-git is mocked globally in tests/setup.ts

const MY_PROFILE_ID = "ACoAATEST00000000000000000000000000000";
const CONTACT_PROFILE_ID = "ACoXYZ456abc123TestContactID";
const CONV_ID = "2-OTg0N2NkZmMtNTViZC00N2I4LWI3YTYtODdhYmU0YzAzNzhjXzEwMA==";

let tempDir: string;
let store: Store;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "allman-test-"));
  store = new Store({ path: tempDir, gitDebounceMs: 0 });
  await store.init();
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Account store
// ---------------------------------------------------------------------------

describe("AccountStore", () => {
  const record: AccountRecord = {
    urn: `urn:li:fsd_profile:${MY_PROFILE_ID}`,
    profileSlug: "test-user",
    name: "Test User",
    headline: "Engineer",
    profileUrl: "https://www.linkedin.com/in/test-user/",
    imageUrl: null,
    userType: "basic",
    networkSize: 500,
    status: "authenticated",
    cookieJar: null,
    cookiesUpdatedAt: null,
    lastSyncAt: null,
  };

  it("writes and reads an account record", async () => {
    await store.accounts.write(MY_PROFILE_ID, record);
    const result = await store.accounts.read(MY_PROFILE_ID);
    expect(result).toEqual(record);
  });

  it("splits AUTH.json and COOKIES.json", async () => {
    await store.accounts.write(MY_PROFILE_ID, record);
    const auth = await store.accounts.readAuth(MY_PROFILE_ID);
    expect(auth?.name).toBe("Test User");
    expect(auth).not.toHaveProperty("cookieJar");
    const cookies = await store.accounts.readCookies(MY_PROFILE_ID);
    expect(cookies?.cookieJar).toBeNull();
  });

  it("returns null for non-existent account", async () => {
    const result = await store.accounts.read("ACoNONEXISTENT");
    expect(result).toBeNull();
  });

  it("lists only real profile ID directories", async () => {
    await store.accounts.write(MY_PROFILE_ID, record);
    await store.accounts.write(CONTACT_PROFILE_ID, { ...record, name: "Other" });
    const ids = await store.accounts.list();
    expect(ids.sort()).toEqual([CONTACT_PROFILE_ID, MY_PROFILE_ID].sort());
  });

  it("updates specific fields without clobbering others", async () => {
    await store.accounts.write(MY_PROFILE_ID, record);
    const updated = await store.accounts.update(MY_PROFILE_ID, { status: "expired" });
    expect(updated.status).toBe("expired");
    expect(updated.name).toBe("Test User");
  });

  it("createAlias and resolveId follow symlinks", async () => {
    await store.accounts.write(MY_PROFILE_ID, record);
    await store.accounts.createAlias("test-user", MY_PROFILE_ID);
    const resolved = await store.accounts.resolveId("test-user");
    expect(resolved).toBe(MY_PROFILE_ID);
  });

  it("getDefault returns the single account when only one exists", async () => {
    await store.accounts.write(MY_PROFILE_ID, record);
    const result = await store.accounts.getDefault();
    expect(result).toBe(MY_PROFILE_ID);
  });

  it("getDefault resolves alias to profile ID", async () => {
    await store.accounts.write(MY_PROFILE_ID, record);
    await store.accounts.createAlias("test-user", MY_PROFILE_ID);
    const result = await store.accounts.getDefault("test-user");
    expect(result).toBe(MY_PROFILE_ID);
  });

  it("getDefault throws when no accounts exist", async () => {
    await expect(store.accounts.getDefault()).rejects.toThrow("No accounts found");
  });

  it("getDefault throws for missing specific account", async () => {
    await expect(store.accounts.getDefault("ACoNONEXISTENT")).rejects.toThrow(
      'Account "ACoNONEXISTENT" not found'
    );
  });

  it("getDefault throws when multiple accounts and no selection", async () => {
    await store.accounts.write(MY_PROFILE_ID, record);
    await store.accounts.write(CONTACT_PROFILE_ID, { ...record, name: "Other" });
    await expect(store.accounts.getDefault()).rejects.toThrow("Multiple accounts found");
  });
});

// ---------------------------------------------------------------------------
// Conversation store
// ---------------------------------------------------------------------------

describe("ConversationStore", () => {
  const conv: ConversationRecord = {
    convId: CONV_ID,
    profileId: CONTACT_PROFILE_ID,
    slug: "sarah-chen",
    convUrn: "urn:li:msg_conversation:CONV1",
    backendUrn: "urn:li:messagingThread:THREAD1",
    profileUrn: `urn:li:fsd_profile:${CONTACT_PROFILE_ID}`,
    memberUrn: null,
    firstName: "Sarah",
    lastName: "Chen",
    name: "Sarah Chen",
    headline: "CTO at Acme",
    profileUrl: null,
    profilePictures: null,
    distance: "DISTANCE_1",
    pronoun: null,
    memberBadgeType: null,
    isPremium: false,
    isVerified: false,
    unreadCount: 0,
    lastActivityAt: "2026-03-30T12:00:00Z",
    lastReadAt: null,
    createdAt: "2026-01-01T00:00:00Z",
    read: true,
    notificationStatus: "ACTIVE",
    categories: ["PRIMARY_INBOX"],
    conversationUrl: null,
    disabledFeatures: [],
    syncState: {
      oldestMessageAt: null,
      newestMessageAt: null,
      lastSyncAt: null,
      totalSynced: 0,
      fullyBackfilled: false,
    },
    fetchedAt: "2026-03-30T00:00:00Z",
  };

  it("upsert and reads a conversation record", async () => {
    const conversations = store.forAccount(MY_PROFILE_ID);
    await conversations.upsert(CONV_ID, conv);
    const result = await conversations.read(CONV_ID);
    expect(result?.convUrn).toBe("urn:li:msg_conversation:CONV1");
    expect(result?.convId).toBe(CONV_ID);
    expect(result?.name).toBe("Sarah Chen");
  });

  it("creates profileId and slug symlinks on upsert", async () => {
    const conversations = store.forAccount(MY_PROFILE_ID);
    await conversations.upsert(CONV_ID, conv);

    // profileId symlink → convId
    const profileLink = await readlink(join(tempDir, MY_PROFILE_ID, CONTACT_PROFILE_ID));
    expect(profileLink).toBe(CONV_ID);

    // slug symlink → convId
    const slugLink = await readlink(join(tempDir, MY_PROFILE_ID, "sarah-chen"));
    expect(slugLink).toBe(CONV_ID);
  });

  it("resolve follows symlinks", async () => {
    const conversations = store.forAccount(MY_PROFILE_ID);
    await conversations.upsert(CONV_ID, conv);

    // By convId (direct)
    expect(await conversations.resolve(CONV_ID)).toBe(CONV_ID);
    // By profileId (symlink)
    expect(await conversations.resolve(CONTACT_PROFILE_ID)).toBe(CONV_ID);
    // By slug (symlink)
    expect(await conversations.resolve("sarah-chen")).toBe(CONV_ID);
  });

  it("findByUrn returns matching conversation", async () => {
    const conversations = store.forAccount(MY_PROFILE_ID);
    await conversations.upsert(CONV_ID, conv);
    const result = await conversations.findByUrn("urn:li:msg_conversation:CONV1");
    expect(result?.convId).toBe(CONV_ID);
  });

  it("findByUrn matches on backendUrn too", async () => {
    const conversations = store.forAccount(MY_PROFILE_ID);
    await conversations.upsert(CONV_ID, conv);
    const result = await conversations.findByUrn("urn:li:messagingThread:THREAD1");
    expect(result?.convId).toBe(CONV_ID);
  });

  it("findByProfileUrn matches contact", async () => {
    const conversations = store.forAccount(MY_PROFILE_ID);
    await conversations.upsert(CONV_ID, conv);
    const result = await conversations.findByProfileUrn(`urn:li:fsd_profile:${CONTACT_PROFILE_ID}`);
    expect(result?.convId).toBe(CONV_ID);
  });

  it("appendMessages writes and deduplicates messages", async () => {
    const conversations = store.forAccount(MY_PROFILE_ID);
    await conversations.upsert(CONV_ID, conv);

    const msg: StoredMessage = {
      urn: "urn:li:msg_message:MSG1",
      timestamp: new Date("2026-03-01T10:00:00Z").getTime(),
      fromUrn: `urn:li:fsd_profile:${CONTACT_PROFILE_ID}`,
      fromName: "Sarah Chen",
      isFromMe: false,
      body: "Hello!",
      reactions: [],
      attachments: [],
      originToken: null,
    };

    const count1 = await conversations.appendMessages(CONV_ID, [msg]);
    expect(count1).toBe(1);

    const count2 = await conversations.appendMessages(CONV_ID, [msg]);
    expect(count2).toBe(0);
  });

  it("deduplicates across SSE and API URN formats with same message ID", async () => {
    const conversations = store.forAccount(MY_PROFILE_ID);
    await conversations.upsert(CONV_ID, conv);

    const msgId = "2-MTc3NDkzOTc3MzE2OGI0MTg2OQ==";
    const apiMsg: StoredMessage = {
      urn: `urn:li:messagingMessage:${msgId}`,
      timestamp: 1774939773168,
      fromUrn: `urn:li:fsd_profile:${CONTACT_PROFILE_ID}`,
      fromName: "Sarah Chen",
      isFromMe: false,
      body: "Hello!",
      reactions: [],
      attachments: [],
      originToken: null,
    };
    const sseMsg: StoredMessage = {
      urn: `urn:li:fs_event:(${CONV_ID},${msgId})`,
      timestamp: 1774939773168,
      fromUrn: `urn:li:fsd_profile:${CONTACT_PROFILE_ID}`,
      fromName: "Sarah Chen",
      isFromMe: false,
      body: "Hello!",
      reactions: [],
      attachments: [],
      originToken: null,
    };

    const count1 = await conversations.appendMessages(CONV_ID, [apiMsg]);
    expect(count1).toBe(1);

    // SSE URN with same message ID should be deduped
    const count2 = await conversations.appendMessages(CONV_ID, [sseMsg]);
    expect(count2).toBe(0);

    const all = await conversations.readMessages(CONV_ID);
    expect(all.length).toBe(1);
    expect(all[0]?.body).toBe("Hello!");
  });

  it("concurrent appendMessages calls don't create duplicates", async () => {
    const conversations = store.forAccount(MY_PROFILE_ID);
    await conversations.upsert(CONV_ID, conv);

    const msgId = "2-MTc3NDkzOTc3MzE2OGI0MTg2OQ==";
    const msg1: StoredMessage = {
      urn: `urn:li:messagingMessage:${msgId}`,
      timestamp: 1774939773168,
      fromUrn: `urn:li:fsd_profile:${CONTACT_PROFILE_ID}`,
      fromName: "Sarah Chen",
      isFromMe: false,
      body: "Hello!",
      reactions: [],
      attachments: [],
      originToken: null,
    };
    const msg2: StoredMessage = {
      urn: `urn:li:fs_event:(${CONV_ID},${msgId})`,
      timestamp: 1774939773168,
      fromUrn: `urn:li:fsd_profile:${CONTACT_PROFILE_ID}`,
      fromName: "Sarah Chen",
      isFromMe: false,
      body: "Hello!",
      reactions: [],
      attachments: [],
      originToken: null,
    };

    // Fire both concurrently — simulates two SSE events arriving at once
    const [count1, count2] = await Promise.all([
      conversations.appendMessages(CONV_ID, [msg1]),
      conversations.appendMessages(CONV_ID, [msg2]),
    ]);

    expect(count1 + count2).toBe(1); // only one should be written

    const all = await conversations.readMessages(CONV_ID);
    expect(all.length).toBe(1);
  });

  it("upserts existing messages with fresh data (reactions, attachments)", async () => {
    const conversations = store.forAccount(MY_PROFILE_ID);
    await conversations.upsert(CONV_ID, conv);

    const msg: StoredMessage = {
      urn: "urn:li:msg_message:MSG_UPSERT",
      timestamp: new Date("2026-03-10T10:00:00Z").getTime(),
      fromUrn: `urn:li:fsd_profile:${CONTACT_PROFILE_ID}`,
      fromName: "Sarah Chen",
      isFromMe: false,
      body: "Hello!",
      reactions: [],
      attachments: [{ type: "file", name: "resume.pdf" }],
      originToken: null,
    };

    // First write
    const count1 = await conversations.appendMessages(CONV_ID, [msg]);
    expect(count1).toBe(1);

    // Re-sync with updated reactions and corrected attachment type
    const updated: StoredMessage = {
      ...msg,
      reactions: [{ emoji: "👍", count: 1, hasUserReacted: true }],
      attachments: [{ type: "post_share", url: "https://linkedin.com/feed/update/..." }],
    };
    const count2 = await conversations.appendMessages(CONV_ID, [updated]);
    expect(count2).toBe(0); // not a new message

    // But the stored data should reflect the update
    const all = await conversations.readMessages(CONV_ID);
    expect(all.length).toBe(1);
    expect(all[0]?.reactions).toEqual([{ emoji: "👍", count: 1, hasUserReacted: true }]);
    expect(all[0]?.attachments[0]?.type).toBe("post_share");
  });

  it("readMessages returns messages within time range", async () => {
    const conversations = store.forAccount(MY_PROFILE_ID);
    await conversations.upsert(CONV_ID, conv);

    const msgs: StoredMessage[] = [
      {
        urn: "urn:li:msg_message:M1",
        timestamp: new Date("2026-03-01T10:00:00Z").getTime(),
        fromUrn: `urn:li:fsd_profile:${CONTACT_PROFILE_ID}`,
        fromName: "Sarah Chen",
        isFromMe: false,
        body: "First",
        reactions: [],
        attachments: [],
        originToken: null,
      },
      {
        urn: "urn:li:msg_message:M2",
        timestamp: new Date("2026-03-15T10:00:00Z").getTime(),
        fromUrn: `urn:li:fsd_profile:${MY_PROFILE_ID}`,
        fromName: "Test User",
        isFromMe: true,
        body: "Reply",
        reactions: [],
        attachments: [],
        originToken: "some-token",
      },
    ];

    await conversations.appendMessages(CONV_ID, msgs);

    const all = await conversations.readMessages(CONV_ID);
    expect(all.length).toBe(2);

    const limited = await conversations.readMessages(CONV_ID, { limit: 1 });
    expect(limited.length).toBe(1);
  });

  it("updateSyncState merges sync state correctly", async () => {
    const conversations = store.forAccount(MY_PROFILE_ID);
    await conversations.upsert(CONV_ID, conv);
    await conversations.updateSyncState(CONV_ID, {
      newestMessageAt: 1748722800000,
      totalSynced: 10,
    });
    const result = await conversations.read(CONV_ID);
    expect(result?.syncState.newestMessageAt).toBe(1748722800000);
    expect(result?.syncState.totalSynced).toBe(10);
    expect(result?.syncState.oldestMessageAt).toBeNull();
  });
});
