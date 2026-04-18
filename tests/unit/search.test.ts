import { describe, expect, it, vi } from "vitest";
import type { ConversationStore } from "../../src/store/conversations.js";
import { search } from "../../src/store/search.js";
import type { ConversationRecord } from "../../src/store/types.js";

function makeRecord(overrides: Partial<ConversationRecord>): ConversationRecord {
  return {
    convId: "2-abc",
    profileId: "ACoAABtest",
    slug: null,
    convUrn: "urn:li:msg_conversation:x",
    backendUrn: null,
    profileUrn: "urn:li:fsd_profile:ACoAABtest",
    memberUrn: null,
    firstName: "Test",
    lastName: "User",
    name: "Test User",
    headline: null,
    profileUrl: null,
    profilePictures: null,
    distance: null,
    pronoun: null,
    memberBadgeType: null,
    isPremium: false,
    isVerified: false,
    unreadCount: 0,
    lastActivityAt: null,
    lastReadAt: null,
    createdAt: null,
    read: true,
    notificationStatus: null,
    categories: [],
    conversationUrl: null,
    disabledFeatures: [],
    syncState: {
      oldestMessageAt: null,
      newestMessageAt: null,
      lastSyncAt: null,
      totalSynced: 0,
      fullyBackfilled: false,
    },
    fetchedAt: new Date().toISOString(),
    ...overrides,
  };
}

function mockStore(records: ConversationRecord[]): ConversationStore {
  const byId = new Map(records.map((r) => [r.convId, r]));
  return {
    list: vi.fn().mockResolvedValue([...byId.keys()]),
    read: vi.fn((convId: string) => Promise.resolve(byId.get(convId) ?? null)),
  } as unknown as ConversationStore;
}

const alice = makeRecord({
  convId: "2-alice",
  profileId: "ACoAABalice",
  slug: "alice-smith",
  firstName: "Alice",
  lastName: "Smith",
  name: "Alice Smith",
});

const john = makeRecord({
  convId: "2-john",
  profileId: "ACoAABjohn",
  slug: "john-smith",
  firstName: "John",
  lastName: "Smith",
  name: "John Smith",
});

const jenny = makeRecord({
  convId: "2-jenny",
  profileId: "ACoAABjenny",
  slug: "jenny-jones",
  firstName: "Jenny",
  lastName: "Jones",
  name: "Jenny Jones",
});

describe("search", () => {
  const store = mockStore([alice, john, jenny]);

  it("returns empty for blank query", async () => {
    expect(await search("", store)).toEqual([]);
    expect(await search("  ", store)).toEqual([]);
  });

  it("100: exact slug match", async () => {
    const results = await search("alice-smith", store);
    expect(results[0]?.confidence).toBe(100);
    expect(results[0]?.convId).toBe("2-alice");
  });

  it("100: exact profileId match", async () => {
    const results = await search("ACoAABjohn", store);
    expect(results[0]?.confidence).toBe(100);
    expect(results[0]?.convId).toBe("2-john");
  });

  it("95: exact name match (case-insensitive)", async () => {
    const results = await search("alice smith", store);
    expect(results[0]?.confidence).toBe(95);
    expect(results[0]?.convId).toBe("2-alice");
  });

  it("80: name starts with query", async () => {
    const results = await search("alic", store);
    expect(results[0]?.confidence).toBe(80);
    expect(results[0]?.convId).toBe("2-alice");
  });

  it("70: word-start match across multiple words", async () => {
    const results = await search("ali smi", store);
    expect(results[0]?.confidence).toBe(70);
    expect(results[0]?.convId).toBe("2-alice");
  });

  it("60: name contains query substring", async () => {
    const results = await search("lice", store);
    expect(results[0]?.confidence).toBe(60);
    expect(results[0]?.convId).toBe("2-alice");
  });

  it("60: slug contains query substring", async () => {
    const results = await search("jones", store);
    expect(results[0]?.confidence).toBe(60);
    expect(results[0]?.convId).toBe("2-jenny");
  });

  it("40: any query word in name", async () => {
    const results = await search("alice xyz", store);
    expect(results[0]?.confidence).toBe(40);
    expect(results[0]?.convId).toBe("2-alice");
  });

  it("0: no match", async () => {
    const results = await search("zzzzz", store);
    expect(results).toHaveLength(0);
  });

  it("respects limit", async () => {
    const results = await search("smi", store, { limit: 1 });
    expect(results).toHaveLength(1);
  });

  it("sorts by confidence descending", async () => {
    const results = await search("smi", store);
    expect(results.length).toBeGreaterThan(1);
    for (let i = 1; i < results.length; i++) {
      const prev = results[i - 1];
      const curr = results[i];
      if (!prev || !curr) throw new Error("unreachable");
      expect(prev.confidence).toBeGreaterThanOrEqual(curr.confidence);
    }
  });

  it("returns all expected fields", async () => {
    const results = await search("alice-smith", store);
    expect(results[0]).toEqual({
      name: "Alice Smith",
      slug: "alice-smith",
      profileId: "ACoAABalice",
      convId: "2-alice",
      confidence: 100,
    });
  });
});
