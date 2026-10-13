/**
 * Group conversation records — the store contract.
 *
 * Covers:
 *   1. buildConversationRecord writes the agreed group shape (isGroup, title,
 *      participants[] with profileUrn + backendUrn, contact fields from the
 *      first other participant, slug null, name = title or joined names).
 *   2. The 1:1 shape is unchanged — same keys, same order, no group keys.
 *   3. Participant slug lookups are bounded: cached from the existing record,
 *      borrowed from a local 1:1 record, and capped per group.
 *   4. ConversationStore.upsert creates NO alias symlinks for a group, still
 *      creates them for a 1:1, and findByProfileUrn ignores group records.
 *   5. A group is resolvable by its bare convId (case preserved).
 */

import { readFileSync } from "node:fs";
import { lstat, mkdtemp, readlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ConversationData,
  parseConversationsResponse,
} from "@/linkedin/api/endpoints/conversations.js";
import {
  buildConversationRecord,
  groupName,
  participantName,
  resolveParticipantSlugs,
} from "@/store/conversation-record.js";
import { type ConversationStore, Store } from "@/store/index.js";
import type { ConversationRecord } from "@/store/types.js";

const ME_ID = "ACoSYNTHME000000000000000000000000001";
const ME = `urn:li:fsd_profile:${ME_ID}`;
const ALICE_ID = "ACoSYNTHALICE0000000000000000000001";
const BOB_ID = "ACoSYNTHBOB000000000000000000000001";
const GROUP_CONV_ID = "2-R3JvdXBTeW50aGV0aWNUaHJlYWQ=";
const ONE_CONV_ID = "2-T25lVG9PbmVTeW50aGV0aWM=";

const fixture = JSON.parse(
  readFileSync(join(__dirname, "../fixtures/group-conversations-page.json"), "utf8")
);

function page(): { oneToOne: ConversationData; group: ConversationData } {
  const [oneToOne, group] = parseConversationsResponse(fixture);
  if (!oneToOne || !group) throw new Error("fixture did not parse");
  return { oneToOne, group };
}

/** Exact key order a 1:1 RECORD.json had before group support. */
const LEGACY_ONE_TO_ONE_KEYS = [
  "convId",
  "profileId",
  "slug",
  "convUrn",
  "backendUrn",
  "profileUrn",
  "memberUrn",
  "firstName",
  "lastName",
  "name",
  "headline",
  "profileUrl",
  "profilePictures",
  "distance",
  "pronoun",
  "memberBadgeType",
  "isPremium",
  "isVerified",
  "unreadCount",
  "lastActivityAt",
  "lastReadAt",
  "createdAt",
  "read",
  "notificationStatus",
  "categories",
  "conversationUrl",
  "disabledFeatures",
  "syncState",
  "fetchedAt",
];

describe("group conversation records", () => {
  let tempDir: string;
  let store: Store;
  let conversations: ConversationStore;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "allman-group-test-"));
    store = new Store({ path: tempDir, gitDebounceMs: 0 });
    await store.init();
    conversations = store.forAccount(ME_ID);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("parses the fixture as one 1:1 thread and one group thread", () => {
    const { oneToOne, group } = page();
    expect(oneToOne.isGroup).toBe(false);
    expect(group.isGroup).toBe(true);
    expect(group.title).toBeNull();
    expect(group.participants.map((p) => p.entityUrn)).toEqual([
      ME,
      `urn:li:fsd_profile:${ALICE_ID}`,
      `urn:li:fsd_profile:${BOB_ID}`,
    ]);
  });

  it("writes the group contract: isGroup, title, participants[], first-participant contact fields", async () => {
    const { group } = page();
    const resolveSlug = vi.fn(async (id: string) =>
      id === ALICE_ID ? "alice-example" : id === BOB_ID ? "bob-example" : null
    );
    const record = await buildConversationRecord({
      conv: group,
      myProfileUrn: ME,
      existing: null,
      conversations,
      resolveSlug,
    });
    expect(record).not.toBeNull();
    if (!record) return;

    expect(record.convId).toBe(GROUP_CONV_ID);
    expect(record.isGroup).toBe(true);
    expect(record.title).toBeNull();
    expect(record.slug).toBeNull();
    // Name: no title → participants' full names joined with ", ".
    expect(record.name).toBe("Alice Example, Bob Example");

    // Every participant except me, in LinkedIn's order.
    expect(record.participants).toHaveLength(2);
    expect(record.participants?.[0]).toEqual({
      profileId: ALICE_ID,
      profileUrn: `urn:li:fsd_profile:${ALICE_ID}`,
      backendUrn: `urn:li:msg_messagingParticipant:urn:li:fsd_profile:${ALICE_ID}`,
      slug: "alice-example",
      firstName: "Alice",
      lastName: "Example",
      name: "Alice Example",
      headline: "Alice's headline",
      profileUrl: "https://www.linkedin.com/in/alice-example",
      profilePictures: [
        { width: 100, height: 100, url: "https://media.licdn.com/dms/image/alice/100.jpg" },
        { width: 200, height: 200, url: "https://media.licdn.com/dms/image/alice/200.jpg" },
      ],
      distance: "DISTANCE_1",
      pronoun: "SHE_HER",
      memberBadgeType: "VERIFIED_PROFILE",
      isPremium: false,
      isVerified: true,
    });
    expect(record.participants?.[1]).toMatchObject({
      profileId: BOB_ID,
      slug: "bob-example",
      name: "Bob Example",
      isPremium: true,
      isVerified: false,
    });

    // Single-person fields mirror the FIRST other participant.
    expect(record.profileId).toBe(ALICE_ID);
    expect(record.profileUrn).toBe(`urn:li:fsd_profile:${ALICE_ID}`);
    expect(record.firstName).toBe("Alice");
    expect(record.lastName).toBe("Example");
    expect(record.headline).toBe("Alice's headline");
    expect(record.profileUrl).toBe("https://www.linkedin.com/in/alice-example");
    expect(record.profilePictures).toHaveLength(2);
    expect(record.distance).toBe("DISTANCE_1");
    expect(record.pronoun).toBe("SHE_HER");
    expect(record.memberBadgeType).toBe("VERIFIED_PROFILE");
    expect(record.isVerified).toBe(true);

    // Conversation state still comes through.
    expect(record.backendUrn).toBe(`urn:li:messagingThread:${GROUP_CONV_ID}`);
    expect(record.unreadCount).toBe(1);
    expect(record.read).toBe(false);
    expect(record.disabledFeatures).toEqual(["REMOVE_PARTICIPANT"]);

    // One lookup per participant, never more.
    expect(resolveSlug).toHaveBeenCalledTimes(2);
  });

  it("uses LinkedIn's title as the name when the group has one", async () => {
    const { group } = page();
    const record = await buildConversationRecord({
      conv: { ...group, title: "Launch planning" },
      myProfileUrn: ME,
      existing: null,
      conversations,
      resolveSlug: async () => null,
    });
    expect(record?.name).toBe("Launch planning");
    expect(record?.title).toBe("Launch planning");
    expect(groupName("  ", [{ name: "A" }, { name: "B" }])).toBe("A, B");
    expect(groupName(null, [])).toBe("Group conversation");
  });

  it("keeps the 1:1 record shape byte-for-byte: same keys, same order, no group keys", async () => {
    const { oneToOne } = page();
    const record = await buildConversationRecord({
      conv: oneToOne,
      myProfileUrn: ME,
      existing: null,
      conversations,
      resolveSlug: async () => "bob-example",
    });
    expect(record).not.toBeNull();
    if (!record) return;
    expect(Object.keys(record)).toEqual(LEGACY_ONE_TO_ONE_KEYS);
    expect("isGroup" in record).toBe(false);
    expect("title" in record).toBe(false);
    expect("participants" in record).toBe(false);
    expect(record).toMatchObject({
      convId: ONE_CONV_ID,
      profileId: BOB_ID,
      slug: "bob-example",
      name: "Bob Example",
      isPremium: true,
    });
    // Serialized exactly as the legacy writer would have produced it.
    const json = JSON.stringify(record);
    expect(json).not.toContain('"isGroup"');
    expect(json).not.toContain('"participants"');
  });

  it("reuses participant slugs from the existing record instead of looking them up again", async () => {
    const { group } = page();
    const first = await buildConversationRecord({
      conv: group,
      myProfileUrn: ME,
      existing: null,
      conversations,
      resolveSlug: async (id) => (id === ALICE_ID ? "alice-example" : null),
    });
    const resolveSlug = vi.fn(async () => "should-not-be-called");
    const second = await buildConversationRecord({
      conv: group,
      myProfileUrn: ME,
      existing: first,
      conversations,
      resolveSlug,
    });
    expect(resolveSlug).not.toHaveBeenCalled();
    // Resolved once and cached — including the unresolved (null) one.
    expect(second?.participants?.map((p) => p.slug)).toEqual(["alice-example", null]);
  });

  it("borrows a participant's slug from their local 1:1 record", async () => {
    const { oneToOne, group } = page();
    const bob = await buildConversationRecord({
      conv: oneToOne,
      myProfileUrn: ME,
      existing: null,
      conversations,
      resolveSlug: async () => "bob-example",
    });
    if (!bob) throw new Error("no 1:1 record");
    await conversations.upsert(ONE_CONV_ID, bob);

    const resolveSlug = vi.fn(async (id: string) => (id === ALICE_ID ? "alice-example" : null));
    const record = await buildConversationRecord({
      conv: group,
      myProfileUrn: ME,
      existing: null,
      conversations,
      resolveSlug,
    });
    expect(resolveSlug).toHaveBeenCalledTimes(1);
    expect(resolveSlug).toHaveBeenCalledWith(ALICE_ID);
    expect(record?.participants?.[1]?.slug).toBe("bob-example");
  });

  it("caps API slug lookups per group", async () => {
    const { group } = page();
    const alice = group.participants[1];
    if (!alice) throw new Error("fixture");
    const many = Array.from({ length: 12 }, (_, i) => ({
      ...alice,
      entityUrn: `urn:li:fsd_profile:ACoSYNTHMEMBER${String(i).padStart(2, "0")}`,
      name: `Member ${i}`,
    }));
    const resolveSlug = vi.fn(async () => null);
    const slugs = await resolveParticipantSlugs(conversations, many, null, resolveSlug, 10);
    expect(resolveSlug).toHaveBeenCalledTimes(10);
    expect(slugs.size).toBe(12);
  });

  it("upsert creates no alias symlinks for a group, but still does for a 1:1", async () => {
    const { oneToOne, group } = page();
    const groupRecord = await buildConversationRecord({
      conv: group,
      myProfileUrn: ME,
      existing: null,
      conversations,
      resolveSlug: async (id) => (id === ALICE_ID ? "alice-example" : "bob-example"),
    });
    const oneRecord = await buildConversationRecord({
      conv: oneToOne,
      myProfileUrn: ME,
      existing: null,
      conversations,
      resolveSlug: async () => "bob-example",
    });
    if (!groupRecord || !oneRecord) throw new Error("records");

    await conversations.upsert(GROUP_CONV_ID, groupRecord);
    await conversations.upsert(ONE_CONV_ID, oneRecord);

    const accountDir = join(tempDir, ME_ID);
    // The group directory exists under its bare convId, case preserved.
    expect((await lstat(join(accountDir, GROUP_CONV_ID))).isDirectory()).toBe(true);
    // No {profileId} or {slug} alias for the group's first participant.
    await expect(lstat(join(accountDir, ALICE_ID))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(join(accountDir, "alice-example"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    // Bob is in the group too, but his aliases point at the 1:1 thread only.
    expect(await readlink(join(accountDir, BOB_ID))).toBe(ONE_CONV_ID);
    expect(await readlink(join(accountDir, "bob-example"))).toBe(ONE_CONV_ID);

    // Resolution: a group by bare convId only; a person by profileId/slug → 1:1.
    expect(await conversations.resolve(GROUP_CONV_ID)).toBe(GROUP_CONV_ID);
    expect(await conversations.resolve(ALICE_ID)).toBeNull();
    expect(await conversations.resolve("bob-example")).toBe(ONE_CONV_ID);

    // findByProfileUrn never returns a group for its first participant.
    expect(await conversations.findByProfileUrn(`urn:li:fsd_profile:${ALICE_ID}`)).toBeNull();
    expect((await conversations.findByProfileUrn(`urn:li:fsd_profile:${BOB_ID}`))?.convId).toBe(
      ONE_CONV_ID
    );

    // And the written file carries the group fields.
    const written = (await conversations.read(GROUP_CONV_ID)) as ConversationRecord;
    expect(written.isGroup).toBe(true);
    expect(written.participants?.map((p) => p.profileUrn)).toEqual([
      `urn:li:fsd_profile:${ALICE_ID}`,
      `urn:li:fsd_profile:${BOB_ID}`,
    ]);
  });

  it("a group record upserted even with a stale alias in the way never rewrites it", async () => {
    const { oneToOne, group } = page();
    const oneRecord = await buildConversationRecord({
      conv: oneToOne,
      myProfileUrn: ME,
      existing: null,
      conversations,
      resolveSlug: async () => "bob-example",
    });
    if (!oneRecord) throw new Error("record");
    await conversations.upsert(ONE_CONV_ID, oneRecord);

    // A group whose FIRST participant is Bob (Alice removed) must not steal Bob's alias.
    const bobFirst: ConversationData = {
      ...group,
      participants: [group.participants[0], group.participants[2]].filter(
        (p): p is NonNullable<typeof p> => p !== undefined
      ),
    };
    const groupRecord = await buildConversationRecord({
      conv: bobFirst,
      myProfileUrn: ME,
      existing: null,
      conversations,
      resolveSlug: async () => null,
    });
    if (!groupRecord) throw new Error("record");
    expect(groupRecord.profileId).toBe(BOB_ID);
    await conversations.upsert(GROUP_CONV_ID, groupRecord);

    const accountDir = join(tempDir, ME_ID);
    expect(await readlink(join(accountDir, BOB_ID))).toBe(ONE_CONV_ID);
    expect(await readlink(join(accountDir, "bob-example"))).toBe(ONE_CONV_ID);
  });

  it("participantName maps a sender's profile URN (or backend URN) to a name", async () => {
    const { group } = page();
    const record = await buildConversationRecord({
      conv: group,
      myProfileUrn: ME,
      existing: null,
      conversations,
      resolveSlug: async () => null,
    });
    expect(participantName(record, `urn:li:fsd_profile:${BOB_ID}`)).toBe("Bob Example");
    expect(
      participantName(record, `urn:li:msg_messagingParticipant:urn:li:fsd_profile:${ALICE_ID}`)
    ).toBe("Alice Example");
    expect(participantName(record, "urn:li:fsd_profile:NOBODY")).toBeNull();
    // 1:1 records keep the old behaviour: the thread name is the sender.
    expect(participantName({ ...record, isGroup: false, name: "Only Person" }, "x")).toBe(
      "Only Person"
    );
  });
});
