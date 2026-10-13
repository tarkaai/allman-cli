/**
 * `allman send` with several recipients creates a group thread. Transport is
 * mocked; the store is a real temp dir.
 *
 *   - comma-separated `<to>` and repeated `--to` both add recipients, and a
 *     composite URN's inner comma is never split
 *   - each recipient resolves like a single target: local 1:1 record first
 *     (no lookup), then the slug→URN profile lookup; URNs pass through
 *   - `--dry-run` prints the resolved recipients and the plan, no write
 *   - the send is ONE createMessage with every recipient (sendFirstMessage)
 *   - the new thread is stored with the group record shape, with no alias
 *     symlinks, whether the by-recipients lookup confirms it or not
 *   - thread ids, `--reply-to`, and self-only lists are refused
 */

import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendCommand, splitTargets } from "@/commands/send.js";
import type { ConversationData } from "@/linkedin/api/endpoints/conversations.js";
import { type ConversationStore, Store } from "@/store/index.js";
import type { AccountRecord, ConversationRecord } from "@/store/types.js";
import { setJsonMode } from "@/utils/output.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@/linkedin/api/client.js", () => ({
  buildApiClient: vi.fn(() => ({ updateJar: vi.fn(), request: vi.fn() })),
  LinkedInError: class LinkedInError extends Error {},
}));

const mockFindConversationByRecipient = vi.fn().mockResolvedValue(null);
const mockFindConversationsByRecipients = vi.fn().mockResolvedValue([]);
vi.mock("@/linkedin/api/endpoints/conversations.js", () => ({
  findConversationByRecipient: (...args: unknown[]) => mockFindConversationByRecipient(...args),
  findConversationsByRecipients: (...args: unknown[]) => mockFindConversationsByRecipients(...args),
  listConversations: vi.fn().mockResolvedValue({ conversations: [], nextCursor: null }),
  markConversationsRead: vi.fn().mockResolvedValue(undefined),
}));

const mockGetProfileUrnBySlug = vi.fn();
const mockGetProfileSlugById = vi.fn().mockResolvedValue(null);
vi.mock("@/linkedin/api/endpoints/profiles.js", () => ({
  getProfileUrnBySlug: (...args: unknown[]) => mockGetProfileUrnBySlug(...args),
  getProfileSlugById: (...args: unknown[]) => mockGetProfileSlugById(...args),
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
// Fixtures — every id and name is synthetic
// ---------------------------------------------------------------------------

const ME_ID = "ACoAAEXAMPLE000000000000000000000000ME";
const ME = `urn:li:fsd_profile:${ME_ID}`;
const AVERY_ID = "ACoAAEXAMPLE000001";
const AVERY = `urn:li:fsd_profile:${AVERY_ID}`;
const BLAKE_ID = "ACoAAEXAMPLE000002";
const BLAKE = `urn:li:fsd_profile:${BLAKE_ID}`;
const CASEY_ID = "ACoAAEXAMPLE000003";
const CASEY = `urn:li:fsd_profile:${CASEY_ID}`;
const ONE_CONV_ID = "2-T25lVG9PbmVFeGFtcGxl";
const NEW_CONV_ID = "2-R3JvdXBFeGFtcGxlVGhyZWFk";
const NEW_THREAD_URN = `urn:li:messagingThread:${NEW_CONV_ID}`;
const SENT_AT = 1786982000000;

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

/** Blake already has a 1:1 thread locally, so their slug resolves offline. */
const blakeRecord: ConversationRecord = {
  convId: ONE_CONV_ID,
  profileId: BLAKE_ID,
  slug: "blake-example",
  convUrn: `urn:li:msg_conversation:(${ME},${ONE_CONV_ID})`,
  backendUrn: `urn:li:messagingThread:${ONE_CONV_ID}`,
  profileUrn: BLAKE,
  memberUrn: null,
  firstName: "Blake",
  lastName: "Example",
  name: "Blake Example",
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

const sendResult = {
  messageUrn: "urn:li:messagingMessage:2-sent1",
  conversationUrn: `urn:li:msg_conversation:(${ME},${NEW_CONV_ID})`,
  backendConversationUrn: NEW_THREAD_URN,
  deliveredAt: SENT_AT,
};

function participant(urn: string, first: string): ConversationData["participants"][number] {
  return {
    entityUrn: urn,
    name: `${first} Example`,
    profileUrl: `https://www.linkedin.com/in/${first.toLowerCase()}-example`,
    imageUrl: null,
    headline: `${first}'s headline`,
    profilePictures: [],
    distance: "DISTANCE_1",
    pronoun: null,
    memberBadgeType: null,
    isPremium: false,
    isVerified: false,
    backendUrn: `urn:li:msg_messagingParticipant:${urn}`,
  };
}

/** What the by-recipients lookup returns for the thread LinkedIn just created. */
const createdGroup: ConversationData = {
  urn: `urn:li:msg_conversation:(${ME},${NEW_CONV_ID})`,
  backendUrn: NEW_THREAD_URN,
  title: null,
  isGroup: true,
  lastActivityAt: SENT_AT,
  unreadCount: 0,
  participants: [participant(ME, "Test"), participant(AVERY, "Avery"), participant(BLAKE, "Blake")],
  createdAt: SENT_AT,
  lastReadAt: SENT_AT,
  read: true,
  notificationStatus: null,
  categories: ["INBOX", "PRIMARY_INBOX"],
  conversationUrl: null,
  disabledFeatures: [],
};

function capture(stream: "stdout" | "stderr"): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const spy = vi.spyOn(process[stream], "write").mockImplementation((chunk) => {
    lines.push(String(chunk));
    return true;
  });
  return { lines, restore: () => spy.mockRestore() };
}

async function run(
  target: string,
  text: string,
  opts: Parameters<typeof sendCommand>[2]
): Promise<{ stdout: string; stderr: string }> {
  const out = capture("stdout");
  const err = capture("stderr");
  try {
    await sendCommand(target, text, opts);
  } finally {
    out.restore();
    err.restore();
  }
  return { stdout: out.lines.join(""), stderr: err.lines.join("") };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("splitTargets", () => {
  it("splits on commas and trims, dropping blanks", () => {
    expect(splitTargets("avery-example, blake-example ,,urn:li:fsd_profile:X")).toEqual([
      "avery-example",
      "blake-example",
      "urn:li:fsd_profile:X",
    ]);
  });

  it("never splits the comma inside a composite URN", () => {
    const composite = `urn:li:msg_conversation:(${ME},${ONE_CONV_ID})`;
    expect(splitTargets(composite)).toEqual([composite]);
    expect(splitTargets(`${composite},avery-example`)).toEqual([composite, "avery-example"]);
  });

  it("returns [] for an empty string", () => {
    expect(splitTargets("")).toEqual([]);
  });
});

describe("send — several recipients create a group thread", () => {
  let tempDir: string;
  let store: Store;
  let conversations: ConversationStore;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    setJsonMode(true);
    mockFetchMessages.mockResolvedValue({ messages: [], hasMore: false });
    mockGetProfileUrnBySlug.mockImplementation(async (_c: unknown, slug: string) =>
      slug === "avery-example" ? AVERY : slug === "casey-example" ? CASEY : null
    );
    mockFindConversationsByRecipients.mockResolvedValue([]);
    mockSendFirstMessage.mockResolvedValue(sendResult);
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);

    tempDir = await mkdtemp(join(tmpdir(), "allman-group-send-"));
    store = new Store({ path: tempDir, gitDebounceMs: 0 });
    await store.init();
    await store.accounts.write(ME_ID, accountRecord);
    await store.accounts.createAlias("test-user", ME_ID);
    conversations = store.forAccount(ME_ID);
    await conversations.upsert(ONE_CONV_ID, blakeRecord);
  });

  afterEach(async () => {
    exitSpy.mockRestore();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("--dry-run resolves every recipient and prints the plan without any write", async () => {
    const { stdout } = await run("avery-example,blake-example", "hi both", {
      store: tempDir,
      json: true,
      dryRun: true,
    });
    const preview = JSON.parse(stdout);
    expect(preview).toMatchObject({
      dryRun: true,
      convId: null,
      conversationUrn: null,
      isGroup: true,
      isNewConversation: true,
      participants: ["avery-example", "Blake Example"],
      hostRecipientUrns: [AVERY, BLAKE],
      text: "hi both",
    });
    expect(preview.recipients).toEqual([
      { target: "avery-example", profileUrn: AVERY, slug: "avery-example", name: null },
      { target: "blake-example", profileUrn: BLAKE, slug: "blake-example", name: "Blake Example" },
    ]);

    // Blake came from the local 1:1 record; only Avery needed the profile lookup.
    expect(mockGetProfileUrnBySlug).toHaveBeenCalledTimes(1);
    expect(mockGetProfileUrnBySlug.mock.calls[0]?.[1]).toBe("avery-example");
    expect(mockSendFirstMessage).not.toHaveBeenCalled();
    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(mockFetchMessages).not.toHaveBeenCalled();
    expect(mockFindConversationByRecipient).not.toHaveBeenCalled();
    expect(mockFindConversationsByRecipients).not.toHaveBeenCalled();
    expect(await conversations.list()).toEqual([ONE_CONV_ID]);
  });

  it("--dry-run human output names each recipient, its URN and the plan", async () => {
    const { stderr, stdout } = await run("avery-example", "hi all", {
      store: tempDir,
      dryRun: true,
      to: ["blake-example", `urn:li:fsd_profile:${CASEY_ID}`],
    });
    expect(stdout).toBe("");
    expect(stderr).toContain("[dry-run] Would create a new group conversation with 3 recipients");
    expect(stderr).toContain(`avery-example  ${AVERY}`);
    expect(stderr).toContain(`blake-example (Blake Example)  ${BLAKE}`);
    expect(stderr).toContain(CASEY);
    expect(stderr).toContain("hostRecipientUrns");
    expect(stderr).toContain("no conversationUrn");
    expect(stderr).toContain("  hi all\n");
    expect(mockSendFirstMessage).not.toHaveBeenCalled();
  });

  it("sends ONE createMessage with every recipient and stores the confirmed group record", async () => {
    mockFindConversationsByRecipients.mockResolvedValue([createdGroup]);

    const { stdout } = await run("avery-example", "hi both", {
      store: tempDir,
      json: true,
      to: ["https://www.linkedin.com/in/blake-example/"],
    });

    expect(mockSendFirstMessage).toHaveBeenCalledTimes(1);
    expect(mockSendFirstMessage.mock.calls[0]?.slice(1)).toEqual([
      [AVERY, BLAKE],
      ME,
      "hi both",
      [], // no attachment → no render units
    ]);
    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(mockFetchMessages).not.toHaveBeenCalled(); // no pre-send sync for a new thread
    expect(mockFindConversationsByRecipients.mock.calls[0]?.slice(1)).toEqual([[AVERY, BLAKE], ME]);

    expect(JSON.parse(stdout)).toEqual({
      messageUrn: "urn:li:messagingMessage:2-sent1",
      conversationUrn: NEW_THREAD_URN,
      convId: NEW_CONV_ID,
      deliveredAt: SENT_AT,
      isNewConversation: true,
      isGroup: true,
      recipients: [AVERY, BLAKE],
    });

    // Group record shape (see CLAUDE.md): isGroup, title, participants minus me,
    // contact fields from the first participant, slug null, joined name.
    const record = await conversations.read(NEW_CONV_ID);
    expect(record).toMatchObject({
      convId: NEW_CONV_ID,
      isGroup: true,
      title: null,
      slug: null,
      profileId: AVERY_ID,
      profileUrn: AVERY,
      firstName: "Avery",
      lastName: "Example",
      name: "Avery Example, Blake Example",
      convUrn: createdGroup.urn,
      backendUrn: NEW_THREAD_URN,
      read: true,
      lastActivityAt: new Date(SENT_AT).toISOString(),
      syncState: { newestMessageAt: SENT_AT, oldestMessageAt: SENT_AT, totalSynced: 1 },
    });
    expect(record?.participants?.map((p) => [p.profileUrn, p.backendUrn, p.slug, p.name])).toEqual([
      [AVERY, `urn:li:msg_messagingParticipant:${AVERY}`, "avery-example", "Avery Example"],
      [BLAKE, `urn:li:msg_messagingParticipant:${BLAKE}`, "blake-example", "Blake Example"],
    ]);
    // Slugs were known from the targets — no per-participant lookups burned.
    expect(mockGetProfileSlugById).not.toHaveBeenCalled();

    const stored = await conversations.readMessages(NEW_CONV_ID);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      urn: "urn:li:messagingMessage:2-sent1",
      body: "hi both",
      isFromMe: true,
      fromUrn: ME,
      timestamp: SENT_AT,
    });

    // No alias symlinks for a group: avery-example / blake-example / profile ids
    // still mean "the 1:1 thread with that person".
    const entries = await readdir(join(tempDir, ME_ID));
    expect(entries).not.toContain("avery-example");
    expect(entries).not.toContain(AVERY_ID);
    expect(await conversations.resolve("blake-example")).toBe(ONE_CONV_ID);
    expect(await conversations.resolve(BLAKE_ID)).toBe(ONE_CONV_ID);
  });

  it("stores a provisional group record when the lookup cannot confirm the thread", async () => {
    mockFindConversationsByRecipients.mockRejectedValue(new Error("lookup down"));
    mockGetProfileSlugById.mockResolvedValue("casey-example");

    const { stdout } = await run(`avery-example,${CASEY}`, "hi both", {
      store: tempDir,
      json: true,
    });
    expect(JSON.parse(stdout)).toMatchObject({ convId: NEW_CONV_ID, isGroup: true });

    const record = await conversations.read(NEW_CONV_ID);
    expect(record).toMatchObject({
      isGroup: true,
      title: null,
      slug: null,
      profileUrn: AVERY,
      backendUrn: NEW_THREAD_URN,
      convUrn: sendResult.conversationUrn,
      // What we know: the slug for Avery, the id for Casey until sync fills it in.
      name: "avery-example, casey-example",
    });
    expect(record?.participants?.map((p) => [p.profileUrn, p.backendUrn, p.slug])).toEqual([
      [AVERY, null, "avery-example"],
      [CASEY, null, "casey-example"],
    ]);
    // Casey was given as a bare URN, so their slug cost exactly one lookup.
    expect(mockGetProfileSlugById).toHaveBeenCalledTimes(1);
    expect(mockGetProfileSlugById.mock.calls[0]?.[1]).toBe(CASEY_ID);
    expect((await conversations.readMessages(NEW_CONV_ID)).map((m) => m.body)).toEqual(["hi both"]);
  });

  it("only warns when the send response names no thread at all", async () => {
    mockSendFirstMessage.mockResolvedValue({
      ...sendResult,
      conversationUrn: "",
      backendConversationUrn: "",
    });
    const { stdout, stderr } = await run("avery-example,blake-example", "hi", {
      store: tempDir,
      json: true,
    });
    expect(JSON.parse(stdout)).toMatchObject({
      convId: null,
      conversationUrn: null,
      isGroup: true,
    });
    expect(stderr).toContain("allman sync");
    expect(await conversations.list()).toEqual([ONE_CONV_ID]);
  });

  it("drops the signed-in account and duplicates; a single survivor is sent 1:1", async () => {
    mockFindConversationByRecipient.mockResolvedValue(null);
    const { stdout, stderr } = await run(`blake-example,${BLAKE},${ME}`, "just you", {
      store: tempDir,
      json: true,
      dryRun: true,
    });
    expect(stderr).toContain("signed-in account");
    expect(stderr).toContain("sending 1:1");
    const preview = JSON.parse(stdout);
    expect(preview).toMatchObject({
      convId: ONE_CONV_ID,
      isGroup: false,
      isNewConversation: false,
    });
    expect(mockSendFirstMessage).not.toHaveBeenCalled();
  });

  it("refuses conversation ids, thread URNs, unknown slugs and --reply-to", async () => {
    for (const [target, opts] of [
      [`avery-example,${ONE_CONV_ID}`, {}],
      [`avery-example,urn:li:messagingThread:${ONE_CONV_ID}`, {}],
      ["avery-example,nobody-here", {}],
      ["avery-example,blake-example", { replyTo: "urn:li:messagingMessage:2-x" }],
    ] as const) {
      await expect(run(target, "hi", { store: tempDir, json: true, ...opts })).rejects.toThrow(
        "process.exit called"
      );
      expect(exitSpy).toHaveBeenLastCalledWith(1);
    }
    expect(mockSendFirstMessage).not.toHaveBeenCalled();
    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(await conversations.list()).toEqual([ONE_CONV_ID]);
  });

  it("a single composite URN with a comma still addresses that one thread", async () => {
    const { stdout } = await run(`urn:li:msg_conversation:(${ME},${ONE_CONV_ID})`, "hi", {
      store: tempDir,
      json: true,
      dryRun: true,
    });
    expect(JSON.parse(stdout)).toMatchObject({ convId: ONE_CONV_ID, isGroup: false });
    expect(mockGetProfileUrnBySlug).not.toHaveBeenCalled();
  });
});
