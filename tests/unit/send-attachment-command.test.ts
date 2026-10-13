/**
 * `allman send --audio/--file` end to end through `sendCommand`, with the
 * transport mocked and a real temp-dir store:
 *
 *   - the attachment is read + validated BEFORE dispatch and before any
 *     network call (size cap, missing --duration-ms, audio mime check)
 *   - the uploaded asset's render unit rides on sendMessage / sendFirstMessage
 *     (1:1 and group paths alike)
 *   - the stored message carries the `voice` / `file` attachment
 *   - the bytes are cached as `{conv}/media/<messageId>-<index>.<ext>`, with
 *     the extension derived from the mime type when the name has none
 *   - no cache write when the message id or conv id is unknown
 *   - `--dry-run` folds the upload plan into the ordinary preview
 */

import { mkdtemp, open, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_ATTACHMENT_BYTES, sendCommand } from "@/commands/send.js";
import { type ConversationStore, Store } from "@/store/index.js";
import type { AccountRecord, ConversationRecord } from "@/store/types.js";
import { setJsonMode } from "@/utils/output.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@/linkedin/api/client.js", () => ({
  buildApiClient: vi.fn(() => ({ updateJar: vi.fn(), request: vi.fn(), getJar: vi.fn() })),
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

// Upload handshake mocked; the render-unit / mime builders stay real.
const mockRequestUploadSlot = vi.fn();
const mockUploadBytes = vi.fn();
vi.mock("@/linkedin/api/endpoints/media-upload.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/linkedin/api/endpoints/media-upload.js")>();
  return {
    ...actual,
    requestUploadSlot: (...args: unknown[]) => mockRequestUploadSlot(...args),
    uploadBytes: (...args: unknown[]) => mockUploadBytes(...args),
  };
});

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
const ONE_CONV_ID = "2-T25lVG9PbmVFeGFtcGxl";
const NEW_CONV_ID = "2-R3JvdXBFeGFtcGxlVGhyZWFk";
const NEW_THREAD_URN = `urn:li:messagingThread:${NEW_CONV_ID}`;
const SENT_AT = 1786982000000;
const ASSET = "urn:li:digitalmediaAsset:D5620AQSYNTHETIC";

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

const oneToOneResult = {
  messageUrn: "urn:li:messagingMessage:2-sentA",
  conversationUrn: `urn:li:msg_conversation:(${ME},${ONE_CONV_ID})`,
  backendConversationUrn: `urn:li:messagingThread:${ONE_CONV_ID}`,
  deliveredAt: SENT_AT,
};

const groupResult = {
  messageUrn: "urn:li:messagingMessage:2-sentG",
  conversationUrn: `urn:li:msg_conversation:(${ME},${NEW_CONV_ID})`,
  backendConversationUrn: NEW_THREAD_URN,
  deliveredAt: SENT_AT,
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
): Promise<{ stdout: string; stderr: string; exited: boolean }> {
  const out = capture("stdout");
  const err = capture("stderr");
  let exited = false;
  try {
    await sendCommand(target, text, opts);
  } catch (e) {
    if ((e as Error).message !== "process.exit called") throw e;
    exited = true;
  } finally {
    out.restore();
    err.restore();
  }
  return { stdout: out.lines.join(""), stderr: err.lines.join(""), exited };
}

const expectNoNetwork = () => {
  expect(mockRequestUploadSlot).not.toHaveBeenCalled();
  expect(mockUploadBytes).not.toHaveBeenCalled();
  expect(mockSendMessage).not.toHaveBeenCalled();
  expect(mockSendFirstMessage).not.toHaveBeenCalled();
  expect(mockFetchMessages).not.toHaveBeenCalled();
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("send --audio / --file through sendCommand", () => {
  let tempDir: string;
  let filesDir: string;
  let store: Store;
  let conversations: ConversationStore;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  const noteBytes = Buffer.from("not really an m4a, but the bytes travel as-is");

  beforeEach(async () => {
    vi.clearAllMocks();
    setJsonMode(true);
    mockFetchMessages.mockResolvedValue({ messages: [], hasMore: false });
    mockGetProfileUrnBySlug.mockImplementation(async (_c: unknown, slug: string) =>
      slug === "avery-example" ? AVERY : null
    );
    mockFindConversationsByRecipients.mockResolvedValue([]);
    mockSendMessage.mockResolvedValue(oneToOneResult);
    mockSendFirstMessage.mockResolvedValue(groupResult);
    mockRequestUploadSlot.mockResolvedValue({
      assetUrn: ASSET,
      singleUploadUrl: "https://www.linkedin.com/dms-uploads/synthetic",
      singleUploadHeaders: {},
    });
    mockUploadBytes.mockResolvedValue(undefined);
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);

    tempDir = await mkdtemp(join(tmpdir(), "allman-send-attach-"));
    filesDir = await mkdtemp(join(tmpdir(), "allman-send-attach-files-"));
    store = new Store({ path: tempDir, gitDebounceMs: 0 });
    await store.init();
    await store.accounts.write(ME_ID, accountRecord);
    await store.accounts.createAlias("test-user", ME_ID);
    conversations = store.forAccount(ME_ID);
    await conversations.upsert(ONE_CONV_ID, blakeRecord);
    await writeFile(join(filesDir, "note.m4a"), noteBytes);
  });

  afterEach(async () => {
    exitSpy.mockRestore();
    setJsonMode(false);
    await rm(tempDir, { recursive: true, force: true });
    await rm(filesDir, { recursive: true, force: true });
  });

  it("1:1 voice note: uploads, sends the audio unit, stores the voice attachment, caches the bytes", async () => {
    const { stdout, exited } = await run("blake-example", "", {
      store: tempDir,
      json: true,
      audio: join(filesDir, "note.m4a"),
      durationMs: "12300",
    });
    expect(exited).toBe(false);

    // upload handshake happened with the file's facts
    expect(mockRequestUploadSlot).toHaveBeenCalledTimes(1);
    expect(mockRequestUploadSlot.mock.calls[0]?.slice(1)).toEqual([
      "audio",
      noteBytes.length,
      "note.m4a",
    ]);
    expect(mockUploadBytes).toHaveBeenCalledTimes(1);
    expect(mockUploadBytes.mock.calls[0]?.[2]).toEqual(noteBytes);
    expect(mockUploadBytes.mock.calls[0]?.[3]).toBe("audio/mp4");

    // render unit rides on the message call (no reply quote → it's the only unit)
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    const [, convUrn, sender, text, replyTo, units] = mockSendMessage.mock.calls[0] ?? [];
    expect(convUrn).toBe(`urn:li:messagingThread:${ONE_CONV_ID}`);
    expect(sender).toBe(ME);
    expect(text).toBe("");
    expect(replyTo).toBeUndefined();
    expect(units).toEqual([{ audio: { assetUrn: ASSET, duration: 12300 } }]);

    // stored message carries the voice attachment
    const stored = await conversations.readMessages(ONE_CONV_ID, { limit: 10 });
    const sent = stored.find((m) => m.urn === oneToOneResult.messageUrn);
    expect(sent?.attachments).toEqual([
      {
        type: "voice",
        name: "note.m4a",
        mimeType: "audio/mp4",
        size: noteBytes.length,
        durationMs: 12300,
      },
    ]);

    // bytes cached as media/<messageId>-<index>.<ext>, same name `allman media` writes
    const mediaDir = join(tempDir, ME_ID, ONE_CONV_ID, "media");
    expect(await readdir(mediaDir)).toEqual(["2-sentA-0.m4a"]);
    expect(await readFile(join(mediaDir, "2-sentA-0.m4a"))).toEqual(noteBytes);

    expect(JSON.parse(stdout)).toMatchObject({ messageUrn: oneToOneResult.messageUrn });
  });

  it("group file attachment: the file unit rides on sendFirstMessage and the cache lands under the new convId", async () => {
    const pdf = Buffer.from("%PDF-1.4 synthetic");
    await writeFile(join(filesDir, "deck.pdf"), pdf);

    const { exited } = await run("avery-example,blake-example", "see attached", {
      store: tempDir,
      json: true,
      file: join(filesDir, "deck.pdf"),
    });
    expect(exited).toBe(false);

    expect(mockRequestUploadSlot.mock.calls[0]?.slice(1)).toEqual(["file", pdf.length, "deck.pdf"]);
    expect(mockSendFirstMessage).toHaveBeenCalledTimes(1);
    expect(mockSendFirstMessage.mock.calls[0]?.slice(1)).toEqual([
      [AVERY, BLAKE],
      ME,
      "see attached",
      [
        {
          file: {
            assetUrn: ASSET,
            byteSize: pdf.length,
            mediaType: "application/pdf",
            name: "deck.pdf",
          },
        },
      ],
    ]);
    expect(mockSendMessage).not.toHaveBeenCalled();

    const stored = await conversations.readMessages(NEW_CONV_ID, { limit: 10 });
    expect(stored[0]?.attachments).toEqual([
      { type: "file", name: "deck.pdf", mimeType: "application/pdf", size: pdf.length },
    ]);

    const mediaDir = join(tempDir, ME_ID, NEW_CONV_ID, "media");
    expect(await readdir(mediaDir)).toEqual(["2-sentG-0.pdf"]);
    // nothing leaked into the 1:1 thread or the account dir
    await expect(stat(join(tempDir, ME_ID, ONE_CONV_ID, "media"))).rejects.toThrow();
    await expect(stat(join(tempDir, ME_ID, "media"))).rejects.toThrow();
  });

  it("derives the cached extension from the mime type when the filename has none", async () => {
    // A copy of the m4a with a bare name: mimeTypeFor("voice-memo") is
    // octet-stream, so this has to go through --file; the point is the
    // `.bin` suffix that lets `allman media` match `<base>.`.
    await writeFile(join(filesDir, "voice-memo"), noteBytes);
    const { exited } = await run("blake-example", "memo", {
      store: tempDir,
      json: true,
      file: join(filesDir, "voice-memo"),
    });
    expect(exited).toBe(false);
    const files = await readdir(join(tempDir, ME_ID, ONE_CONV_ID, "media"));
    expect(files).toEqual(["2-sentA-0.bin"]);
    expect(files[0]?.startsWith("2-sentA-0.")).toBe(true);
  });

  it("caches alongside a reply quote at the attachment's own index", async () => {
    await conversations.appendMessages(ONE_CONV_ID, [
      {
        urn: "urn:li:messagingMessage:2-orig",
        timestamp: 1786981000000,
        fromUrn: BLAKE,
        fromName: "Blake Example",
        isFromMe: false,
        body: "can you send it?",
        reactions: [],
        attachments: [],
        originToken: null,
      },
    ]);
    const { exited } = await run("blake-example", "here", {
      store: tempDir,
      json: true,
      replyTo: "urn:li:messagingMessage:2-orig",
      audio: join(filesDir, "note.m4a"),
      durationMs: 4000,
    });
    expect(exited).toBe(false);
    const units = mockSendMessage.mock.calls[0]?.[5];
    expect(units).toEqual([{ audio: { assetUrn: ASSET, duration: 4000 } }]);
    const sent = (await conversations.readMessages(ONE_CONV_ID, { limit: 10 })).find(
      (m) => m.urn === oneToOneResult.messageUrn
    );
    expect(sent?.attachments.map((a) => a.type)).toEqual(["replied", "voice"]);
    expect(await readdir(join(tempDir, ME_ID, ONE_CONV_ID, "media"))).toEqual(["2-sentA-1.m4a"]);
  });

  it("does not cache when LinkedIn returns no message id (never media/-0.m4a)", async () => {
    mockSendMessage.mockResolvedValue({ ...oneToOneResult, messageUrn: "" });
    const { exited } = await run("blake-example", "", {
      store: tempDir,
      json: true,
      audio: join(filesDir, "note.m4a"),
      durationMs: 1000,
    });
    expect(exited).toBe(false);
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    await expect(stat(join(tempDir, ME_ID, ONE_CONV_ID, "media"))).rejects.toThrow();
    await expect(stat(join(tempDir, ME_ID, "media"))).rejects.toThrow();
  });

  it("does not cache a group send when the new thread is not identified", async () => {
    mockSendFirstMessage.mockResolvedValue({
      ...groupResult,
      conversationUrn: "",
      backendConversationUrn: "",
    });
    const { exited, stderr } = await run("avery-example,blake-example", "hi", {
      store: tempDir,
      json: true,
      audio: join(filesDir, "note.m4a"),
      durationMs: 1000,
    });
    expect(exited).toBe(false);
    expect(stderr).toContain("did not identify the new thread");
    const entries = await readdir(join(tempDir, ME_ID));
    expect(entries.some((e) => e === "media" || e.startsWith("-"))).toBe(false);
    await expect(stat(join(tempDir, ME_ID, "media"))).rejects.toThrow();
  });

  it("refuses an oversize attachment before any network call", async () => {
    const big = join(filesDir, "big.pdf");
    const fh = await open(big, "w");
    await fh.truncate(MAX_ATTACHMENT_BYTES + 1); // sparse: no 20 MB actually written
    await fh.close();

    const { exited, stderr } = await run("blake-example", "huge", {
      store: tempDir,
      file: big,
    });
    expect(exited).toBe(true);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(stderr).toContain("over the 20.0 MB attachment limit");
    expectNoNetwork();
  });

  it("requires a positive-integer --duration-ms for --audio, before any network call", async () => {
    for (const durationMs of [undefined, "", "0", "-5", "abc", "12.5", 0]) {
      vi.clearAllMocks();
      const { exited, stderr } = await run("blake-example", "", {
        store: tempDir,
        audio: join(filesDir, "note.m4a"),
        durationMs: durationMs as string | number | undefined,
      });
      expect(exited, `durationMs=${String(durationMs)}`).toBe(true);
      expect(stderr).toContain("--audio needs --duration-ms");
      expectNoNetwork();
    }
  });

  it("rejects a non-audio file for --audio, both flags at once, and an empty send", async () => {
    await writeFile(join(filesDir, "deck.pdf"), "x");
    let r = await run("blake-example", "", {
      store: tempDir,
      audio: join(filesDir, "deck.pdf"),
      durationMs: 1000,
    });
    expect(r.exited).toBe(true);
    expect(r.stderr).toContain("--audio expects an audio file");

    vi.clearAllMocks();
    r = await run("blake-example", "", {
      store: tempDir,
      audio: join(filesDir, "note.m4a"),
      file: join(filesDir, "deck.pdf"),
      durationMs: 1000,
    });
    expect(r.exited).toBe(true);
    expect(r.stderr).toContain("either --audio or --file");

    vi.clearAllMocks();
    r = await run("blake-example", "", { store: tempDir });
    expect(r.exited).toBe(true);
    expect(r.stderr).toContain("Nothing to send");

    vi.clearAllMocks();
    r = await run("blake-example", "", { store: tempDir, file: join(filesDir, "missing.pdf") });
    expect(r.exited).toBe(true);
    expect(r.stderr).toContain("Can't read");
    expectNoNetwork();
  });

  it("--dry-run folds the upload plan into the ordinary preview and sends nothing", async () => {
    const { stdout, exited } = await run("blake-example", "", {
      store: tempDir,
      json: true,
      dryRun: true,
      audio: join(filesDir, "note.m4a"),
      durationMs: "12300",
    });
    expect(exited).toBe(false);
    const preview = JSON.parse(stdout);
    expect(preview).toMatchObject({
      dryRun: true,
      convId: ONE_CONV_ID,
      isGroup: false,
      participants: null,
      text: "",
      attachment: {
        kind: "audio",
        name: "note.m4a",
        mimeType: "audio/mp4",
        bytes: noteBytes.length,
        durationMs: 12300,
      },
      upload: {
        step1: {
          POST: "voyagerVideoDashMediaUploadMetadata?action=upload",
          body: {
            mediaUploadType: "MESSAGING_VOICE_MESSAGE",
            fileSize: noteBytes.length,
            filename: "note.m4a",
          },
        },
        step2: { contentType: "audio/mp4", bytes: noteBytes.length },
        renderUnit: { audio: { assetUrn: "<assetUrn from step 1>", duration: 12300 } },
      },
    });
    expectNoNetwork();
    await expect(stat(join(tempDir, ME_ID, ONE_CONV_ID, "media"))).rejects.toThrow();
  });

  it("--dry-run for a group carries the same plan next to the recipients", async () => {
    await writeFile(join(filesDir, "deck.pdf"), "%PDF");
    const { stdout } = await run("avery-example,blake-example", "hi both", {
      store: tempDir,
      json: true,
      dryRun: true,
      file: join(filesDir, "deck.pdf"),
    });
    const preview = JSON.parse(stdout);
    expect(preview).toMatchObject({
      isGroup: true,
      hostRecipientUrns: [AVERY, BLAKE],
      attachment: { kind: "file", name: "deck.pdf", mimeType: "application/pdf" },
      upload: { step1: { body: { mediaUploadType: "MESSAGING_FILE_ATTACHMENT" } } },
    });
    expectNoNetwork();
  });
});
