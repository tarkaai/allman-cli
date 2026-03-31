import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { Store } from "@/store/index.js";
import type { AccountRecord, ContactRecord, ConversationRecord, StoredMessage } from "@/store/types.js";

// Note: simple-git is mocked globally in tests/setup.ts

// Realistic LinkedIn profile IDs (base64, start with ACo)
const MY_PROFILE_ID = "ACoAATEST00000000000000000000000000000";
const CONTACT_PROFILE_ID = "ACoXYZ456abc123TestContactID";
const CONV_BARE_ID = "2-OTg0N2NkZmMtNTViZC00N2I4LWI3YTYtODdhYmU0YzAzNzhjXzEwMA==";

let tempDir: string;
let store: Store;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "lilac-test-"));
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

  it("returns null for non-existent account", async () => {
    const result = await store.accounts.read("ACoNONEXISTENT");
    expect(result).toBeNull();
  });

  it("lists only real profile ID directories (ACo prefix)", async () => {
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
// Contact store
// ---------------------------------------------------------------------------

describe("ContactStore", () => {
  const contact: ContactRecord = {
    urn: `urn:li:fsd_profile:${CONTACT_PROFILE_ID}`,
    slug: "sarah-chen",
    name: "Sarah Chen",
    headline: "CTO at Acme",
    profileUrl: "https://www.linkedin.com/in/sarah-chen/",
    imageUrl: null,
    connectedAt: null,
    fetchedAt: "2026-03-30T00:00:00Z",
  };

  it("writes and reads a contact record", async () => {
    const { contacts } = store.forAccount(MY_PROFILE_ID);
    await contacts.write(CONTACT_PROFILE_ID, contact);
    const result = await contacts.read(CONTACT_PROFILE_ID);
    expect(result).toEqual(contact);
  });

  it("upsert creates when contact does not exist", async () => {
    const { contacts } = store.forAccount(MY_PROFILE_ID);
    await contacts.upsert(CONTACT_PROFILE_ID, contact);
    const result = await contacts.read(CONTACT_PROFILE_ID);
    expect(result?.name).toBe("Sarah Chen");
  });

  it("upsert merges when contact already exists", async () => {
    const { contacts } = store.forAccount(MY_PROFILE_ID);
    await contacts.write(CONTACT_PROFILE_ID, contact);
    await contacts.upsert(CONTACT_PROFILE_ID, { ...contact, headline: "Updated Headline" });
    const result = await contacts.read(CONTACT_PROFILE_ID);
    expect(result?.headline).toBe("Updated Headline");
    expect(result?.name).toBe("Sarah Chen");
  });

  it("findByUrn returns matching contact with profileId", async () => {
    const { contacts } = store.forAccount(MY_PROFILE_ID);
    await contacts.write(CONTACT_PROFILE_ID, contact);
    const result = await contacts.findByUrn(`urn:li:fsd_profile:${CONTACT_PROFILE_ID}`);
    expect(result?.profileId).toBe(CONTACT_PROFILE_ID);
  });

  it("findByUrn returns null when not found", async () => {
    const { contacts } = store.forAccount(MY_PROFILE_ID);
    const result = await contacts.findByUrn("urn:li:fsd_profile:MISSING");
    expect(result).toBeNull();
  });

  it("createAlias and resolveId follow symlinks", async () => {
    const { contacts } = store.forAccount(MY_PROFILE_ID);
    await contacts.write(CONTACT_PROFILE_ID, contact);
    await contacts.createAlias("sarah-chen", CONTACT_PROFILE_ID);
    const resolved = await contacts.resolveId("sarah-chen");
    expect(resolved).toBe(CONTACT_PROFILE_ID);
  });
});

// ---------------------------------------------------------------------------
// Conversation store + message JSONL
// ---------------------------------------------------------------------------

describe("ConversationStore", () => {
  const conv: ConversationRecord = {
    urn: "urn:li:msg_conversation:CONV1",
    backendUrn: "urn:li:messagingThread:THREAD1",
    bareId: CONV_BARE_ID,
    title: "Sarah Chen",
    isGroup: false,
    participants: [
      { profileId: MY_PROFILE_ID, slug: "test-user", urn: `urn:li:fsd_profile:${MY_PROFILE_ID}`, name: "Test User" },
      { profileId: CONTACT_PROFILE_ID, slug: "sarah-chen", urn: `urn:li:fsd_profile:${CONTACT_PROFILE_ID}`, name: "Sarah Chen" },
    ],
    unreadCount: 0,
    lastActivityAt: "2026-03-30T12:00:00Z",
    createdAt: "2026-01-01T00:00:00Z",
    syncState: {
      oldestMessageAt: null,
      newestMessageAt: null,
      lastSyncAt: null,
      totalSynced: 0,
      fullyBackfilled: false,
    },
  };

  it("upsert and reads a conversation record", async () => {
    const { conversations } = store.forAccount(MY_PROFILE_ID);
    await conversations.upsert(CONV_BARE_ID, conv);
    const result = await conversations.read(CONV_BARE_ID);
    expect(result?.urn).toBe("urn:li:msg_conversation:CONV1");
    expect(result?.bareId).toBe(CONV_BARE_ID);
  });

  it("findByUrn returns matching conversation with bareId", async () => {
    const { conversations } = store.forAccount(MY_PROFILE_ID);
    await conversations.upsert(CONV_BARE_ID, conv);
    const result = await conversations.findByUrn("urn:li:msg_conversation:CONV1");
    expect(result?.bareId).toBe(CONV_BARE_ID);
  });

  it("findByUrn matches on backendUrn too", async () => {
    const { conversations } = store.forAccount(MY_PROFILE_ID);
    await conversations.upsert(CONV_BARE_ID, conv);
    const result = await conversations.findByUrn("urn:li:messagingThread:THREAD1");
    expect(result?.bareId).toBe(CONV_BARE_ID);
  });

  it("createAlias and resolveId follow symlinks", async () => {
    const { conversations } = store.forAccount(MY_PROFILE_ID);
    await conversations.upsert(CONV_BARE_ID, conv);
    await conversations.createAlias("sarah-chen", CONV_BARE_ID);
    const resolved = await conversations.resolveId("sarah-chen");
    expect(resolved).toBe(CONV_BARE_ID);
  });

  it("appendMessages writes and deduplicates messages", async () => {
    const { conversations } = store.forAccount(MY_PROFILE_ID);
    await conversations.upsert(CONV_BARE_ID, conv);

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

    const count1 = await conversations.appendMessages(CONV_BARE_ID, [msg]);
    expect(count1).toBe(1);

    // Appending the same message again should be a no-op
    const count2 = await conversations.appendMessages(CONV_BARE_ID, [msg]);
    expect(count2).toBe(0);
  });

  it("readMessages returns messages within time range", async () => {
    const { conversations } = store.forAccount(MY_PROFILE_ID);
    await conversations.upsert(CONV_BARE_ID, conv);

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

    await conversations.appendMessages(CONV_BARE_ID, msgs);

    const all = await conversations.readMessages(CONV_BARE_ID);
    expect(all.length).toBe(2);

    const limited = await conversations.readMessages(CONV_BARE_ID, { limit: 1 });
    expect(limited.length).toBe(1);
  });

  it("updateSyncState merges sync state correctly", async () => {
    const { conversations } = store.forAccount(MY_PROFILE_ID);
    await conversations.upsert(CONV_BARE_ID, conv);
    await conversations.updateSyncState(CONV_BARE_ID, {
      newestMessageAt: 1748722800000,
      totalSynced: 10,
    });
    const result = await conversations.read(CONV_BARE_ID);
    expect(result?.syncState.newestMessageAt).toBe(1748722800000);
    expect(result?.syncState.totalSynced).toBe(10);
    expect(result?.syncState.oldestMessageAt).toBeNull();
  });
});
