/**
 * ConnectionsStore: per-connection files + slug symlinks, idempotent upserts.
 * Uses a real temp directory (no git). Synthetic ids/slugs.
 */
import { mkdtemp, readFile, readlink, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConnectionsStore } from "@/store/connections-store.js";
import type { StoreGit } from "@/store/git.js";

const NOOP_GIT = {} as unknown as StoreGit; // store methods don't touch git

let accountDir: string;
let cstore: ConnectionsStore;

beforeEach(async () => {
  accountDir = await mkdtemp(join(tmpdir(), "allman-conn-"));
  cstore = new ConnectionsStore(accountDir, NOOP_GIT);
});
afterEach(async () => {
  await rm(accountDir, { recursive: true, force: true });
});

describe("upsertConnection", () => {
  const base = {
    memberUrn: "urn:li:fsd_profile:ACoAAB0000000000000000000000000000000001",
    flagshipId: "ACoAAB0000000000000000000000000000000001",
    publicIdentifier: "example-user-1",
    firstName: "Ex",
    lastName: "Ample",
    headline: null,
    connectedAt: "2026-01-01T00:00:00.000Z",
  };

  it("writes {flagshipId}.json and a {slug} symlink that resolves to it", async () => {
    await cstore.upsertConnection(base, "2026-05-01T00:00:00.000Z");
    const file = join(accountDir, "connections", `${base.flagshipId}.json`);
    const rec = JSON.parse(await readFile(file, "utf8"));
    expect(rec.memberUrn).toBe(base.memberUrn);
    expect(rec.firstSeenAt).toBe("2026-05-01T00:00:00.000Z");
    expect(rec.lastSeenAt).toBe("2026-05-01T00:00:00.000Z");

    const link = join(accountDir, "connections", "example-user-1");
    expect(await readlink(link)).toBe(`${base.flagshipId}.json`);
    // the symlink resolves to a real file
    expect((await stat(link)).isFile()).toBe(true);
  });

  it("preserves firstSeenAt and advances lastSeenAt on re-upsert", async () => {
    await cstore.upsertConnection(base, "2026-05-01T00:00:00.000Z");
    await cstore.upsertConnection(base, "2026-05-20T00:00:00.000Z");
    const rec = JSON.parse(
      await readFile(join(accountDir, "connections", `${base.flagshipId}.json`), "utf8")
    );
    expect(rec.firstSeenAt).toBe("2026-05-01T00:00:00.000Z");
    expect(rec.lastSeenAt).toBe("2026-05-20T00:00:00.000Z");
  });

  it("omits the symlink when there's no public identifier", async () => {
    await cstore.upsertConnection({ ...base, publicIdentifier: null }, "2026-05-01T00:00:00.000Z");
    await expect(readlink(join(accountDir, "connections", "example-user-1"))).rejects.toThrow();
  });
});

describe("connections-of storage", () => {
  it("writes RECORD.json + per-result files keyed by member id, with target-slug symlink", async () => {
    const targetUrn = "urn:li:fsd_profile:ACoAAB0000000000000000000000000000000099";
    const targetKey = ConnectionsStore.targetKeyFromUrn(targetUrn);
    expect(targetKey).toBe("ACoAAB0000000000000000000000000000000099");

    await cstore.writeConnectionOfTarget(targetKey, {
      targetSlug: "target-user",
      targetUrn,
      backend: "flagship",
      total: 22,
      fetched: 2,
      capturedAt: "2026-05-01T00:00:00.000Z",
    });
    await cstore.upsertConnectionOfResult(
      targetKey,
      {
        salesnavId: null,
        memberId: "1000001",
        memberUrn: "urn:li:fsd_profile:ACoAAB0000000000000000000000000000000001",
        publicIdentifier: "result-user-1",
      },
      "2026-05-01T00:00:00.000Z"
    );

    const dir = join(accountDir, "connections-of", targetKey);
    const meta = JSON.parse(await readFile(join(dir, "RECORD.json"), "utf8"));
    expect(meta).toMatchObject({ backend: "flagship", total: 22, fetched: 2 });

    // result keyed by numeric member id
    const result = JSON.parse(await readFile(join(dir, "1000001.json"), "utf8"));
    expect(result.memberId).toBe("1000001");
    expect(result.firstSeenAt).toBe("2026-05-01T00:00:00.000Z");
    // slug symlink for the result
    expect(await readlink(join(dir, "result-user-1"))).toBe("1000001.json");
    // target-slug symlink points at the search dir
    expect(await readlink(join(accountDir, "connections-of", "target-user"))).toBe(targetKey);
  });

  it("keys a result by salesnavId when there's no numeric member id", async () => {
    const targetKey = "ACoAAB0000000000000000000000000000000099";
    await cstore.upsertConnectionOfResult(
      targetKey,
      {
        salesnavId: "ACwAAB0000000000000000000000000000000005",
        memberId: null,
        memberUrn: null,
        publicIdentifier: null,
      },
      "2026-05-01T00:00:00.000Z"
    );
    const file = join(
      accountDir,
      "connections-of",
      targetKey,
      "ACwAAB0000000000000000000000000000000005.json"
    );
    expect((await stat(file)).isFile()).toBe(true);
  });
});
