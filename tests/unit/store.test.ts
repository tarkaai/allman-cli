import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { Store } from "@/store/index.js";
import type { AccountRecord, ContactRecord, ConversationRecord, StoredMessage } from "@/store/types.js";

// Note: simple-git is mocked globally in tests/setup.ts

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
  const slug = "test-user";
  const record: AccountRecord = {
    urn: "urn:li:fsd_profile:ABC123",
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
    await store.accounts.write(slug, record);
    const result = await store.accounts.read(slug);
    expect(result).toEqual(record);
  });

  it("returns null for non-existent account", async () => {
    const result = await store.accounts.read("no-such-account");
    expect(result).toBeNull();
  });

  it("lists all account slugs", async () => {
    await store.accounts.write("alice", { ...record, name: "Alice" });
    await store.accounts.write("bob", { ...record, name: "Bob" });
    const slugs = await store.accounts.list();
    expect(slugs.sort()).toEqual(["alice", "bob"]);
  });

  it("updates specific fields without clobbering others", async () => {
    await store.accounts.write(slug, record);
    const updated = await store.accounts.update(slug, { status: "expired" });
    expect(updated.status).toBe("expired");
    expect(updated.name).toBe("Test User");
  });

  it("getDefault returns first alphabetically when no preference given", async () => {
    await store.accounts.write("charlie", { ...record, name: "Charlie" });
    await store.accounts.write("alice", { ...record, name: "Alice" });
    const defaultSlug = await store.accounts.getDefault();
    expect(defaultSlug).toBe("alice");
  });

  it("getDefault throws when no accounts exist", async () => {
    await expect(store.accounts.getDefault()).rejects.toThrow("No accounts found");
  });

  it("getDefault throws for missing specific slug", async () => {
    await expect(store.accounts.getDefault("ghost")).rejects.toThrow(
      'Account "ghost" not found'
    );
  });
});

// ---------------------------------------------------------------------------
// Contact store
// ---------------------------------------------------------------------------

describe("ContactStore", () => {
  const contact: ContactRecord = {
    urn: "urn:li:fsd_profile:XYZ456",
    name: "Sarah Chen",
    headline: "CTO at Acme",
    profileUrl: "https://www.linkedin.com/in/sarah-chen/",
    imageUrl: null,
    connectedAt: null,
    fetchedAt: "2026-03-30T00:00:00Z",
  };

  it("writes and reads a contact record", async () => {
    await store.contacts.write("sarah-chen", contact);
    const result = await store.contacts.read("sarah-chen");
    expect(result).toEqual(contact);
  });

  it("upsert creates when contact does not exist", async () => {
    await store.contacts.upsert("sarah-chen", contact);
    const result = await store.contacts.read("sarah-chen");
    expect(result?.name).toBe("Sarah Chen");
  });

  it("upsert merges when contact already exists", async () => {
    await store.contacts.write("sarah-chen", contact);
    await store.contacts.upsert("sarah-chen", { ...contact, headline: "Updated Headline" });
    const result = await store.contacts.read("sarah-chen");
    expect(result?.headline).toBe("Updated Headline");
    expect(result?.name).toBe("Sarah Chen");
  });

  it("findByUrn returns matching contact", async () => {
    await store.contacts.write("sarah-chen", contact);
    const result = await store.contacts.findByUrn("urn:li:fsd_profile:XYZ456");
    expect(result?.slug).toBe("sarah-chen");
  });

  it("findByUrn returns null when not found", async () => {
    const result = await store.contacts.findByUrn("urn:li:fsd_profile:MISSING");
    expect(result).toBeNull();
  });

  it("search finds by partial name", async () => {
    await store.contacts.write("sarah-chen", contact);
    await store.contacts.write("sarah-jones", { ...contact, urn: "urn:li:fsd_profile:SJ", name: "Sarah Jones", profileUrl: "" });
    const results = await store.contacts.search("sarah");
    expect(results.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Conversation store + message JSONL
// ---------------------------------------------------------------------------

describe("ConversationStore", () => {
  const conv: ConversationRecord = {
    urn: "urn:li:msg_conversation:CONV1",
    backendUrn: "urn:li:messagingThread:THREAD1",
    title: "Sarah Chen",
    isGroup: false,
    account: "test-user",
    participants: [
      { slug: "test-user", urn: "urn:li:fsd_profile:ABC123", name: "Test User" },
      { slug: "sarah-chen", urn: "urn:li:fsd_profile:XYZ456", name: "Sarah Chen" },
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

  it("writes and reads a conversation record", async () => {
    await store.conversations.write("sarah-chen", conv);
    const result = await store.conversations.read("sarah-chen");
    expect(result?.urn).toBe("urn:li:msg_conversation:CONV1");
  });

  it("findByUrn returns matching conversation", async () => {
    await store.conversations.write("sarah-chen", conv);
    const result = await store.conversations.findByUrn("urn:li:msg_conversation:CONV1");
    expect(result?.slug).toBe("sarah-chen");
  });

  it("findByUrn matches on backendUrn too", async () => {
    await store.conversations.write("sarah-chen", conv);
    const result = await store.conversations.findByUrn("urn:li:messagingThread:THREAD1");
    expect(result?.slug).toBe("sarah-chen");
  });

  it("appendMessages writes and deduplicates messages", async () => {
    await store.conversations.upsert("sarah-chen", conv);

    const msg: StoredMessage = {
      urn: "urn:li:msg_message:MSG1",
      timestamp: new Date("2026-03-01T10:00:00Z").getTime(),
      fromUrn: "urn:li:fsd_profile:XYZ456",
      fromName: "Sarah Chen",
      fromSlug: "sarah-chen",
      isFromMe: false,
      body: "Hello!",
      reactions: [],
      attachments: [],
      originToken: null,
    };

    const count1 = await store.conversations.appendMessages("sarah-chen", [msg]);
    expect(count1).toBe(1);

    // Appending the same message again should be a no-op
    const count2 = await store.conversations.appendMessages("sarah-chen", [msg]);
    expect(count2).toBe(0);
  });

  it("readMessages returns messages within time range", async () => {
    await store.conversations.upsert("sarah-chen", conv);

    const msgs: StoredMessage[] = [
      {
        urn: "urn:li:msg_message:M1",
        timestamp: new Date("2026-03-01T10:00:00Z").getTime(),
        fromUrn: "urn:li:fsd_profile:XYZ456",
        fromName: "Sarah Chen",
        fromSlug: "sarah-chen",
        isFromMe: false,
        body: "First",
        reactions: [],
        attachments: [],
        originToken: null,
      },
      {
        urn: "urn:li:msg_message:M2",
        timestamp: new Date("2026-03-15T10:00:00Z").getTime(),
        fromUrn: "urn:li:fsd_profile:ABC123",
        fromName: "Test User",
        fromSlug: "test-user",
        isFromMe: true,
        body: "Reply",
        reactions: [],
        attachments: [],
        originToken: "some-token",
      },
    ];

    await store.conversations.appendMessages("sarah-chen", msgs);

    const all = await store.conversations.readMessages("sarah-chen");
    expect(all.length).toBe(2);

    const limited = await store.conversations.readMessages("sarah-chen", { limit: 1 });
    expect(limited.length).toBe(1);
  });

  it("updateSyncState merges sync state correctly", async () => {
    await store.conversations.upsert("sarah-chen", conv);
    await store.conversations.updateSyncState("sarah-chen", {
      newestMessageAt: 1748722800000,
      totalSynced: 10,
    });
    const result = await store.conversations.read("sarah-chen");
    expect(result?.syncState.newestMessageAt).toBe(1748722800000);
    expect(result?.syncState.totalSynced).toBe(10);
    expect(result?.syncState.oldestMessageAt).toBeNull();
  });
});
