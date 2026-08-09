/**
 * ConnectionsStore enrichment + invitation methods.
 * Real temp directory (no git). Synthetic ids/slugs.
 */
import { mkdtemp, readFile, readlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConnectionsStore } from "@/store/connections-store.js";
import type { StoreGit } from "@/store/git.js";

const NOOP_GIT = {} as unknown as StoreGit;

const ID_A = "ACoAAB0000000000000000000000000000000001";
const ID_B = "ACoAAB0000000000000000000000000000000002";

let accountDir: string;
let cstore: ConnectionsStore;

beforeEach(async () => {
  accountDir = await mkdtemp(join(tmpdir(), "allman-enrich-"));
  cstore = new ConnectionsStore(accountDir, NOOP_GIT);
});
afterEach(async () => {
  await rm(accountDir, { recursive: true, force: true });
});

async function seed(id: string, slug: string | null) {
  await cstore.upsertConnection(
    {
      memberUrn: `urn:li:fsd_profile:${id}`,
      flagshipId: id,
      publicIdentifier: slug,
      firstName: "Seed",
      lastName: "User",
      headline: null,
      connectedAt: null,
    },
    "2026-05-01T00:00:00.000Z"
  );
}

describe("listConnectionIds", () => {
  it("returns record ids and ignores slug symlinks", async () => {
    await seed(ID_A, "user-a");
    await seed(ID_B, null);
    const ids = (await cstore.listConnectionIds()).sort();
    expect(ids).toEqual([ID_A, ID_B].sort());
  });

  it("returns [] when there are no connections", async () => {
    expect(await cstore.listConnectionIds()).toEqual([]);
  });
});

describe("enrichConnection", () => {
  it("merges enrichment, stamps enrichedAt/depth, preserves firstSeenAt", async () => {
    await seed(ID_A, "user-a");
    const ok = await cstore.enrichConnection(
      ID_A,
      {
        title: "Staff Engineer",
        company: "Test Co",
        location: "Remote",
        about: "hi",
        headline: "Builder",
      },
      "core",
      "2026-06-01T00:00:00.000Z"
    );
    expect(ok).toBe(true);
    const rec = await cstore.readConnection(ID_A);
    expect(rec?.title).toBe("Staff Engineer");
    expect(rec?.company).toBe("Test Co");
    expect(rec?.headline).toBe("Builder");
    expect(rec?.enrichedAt).toBe("2026-06-01T00:00:00.000Z");
    expect(rec?.enrichDepth).toBe("core");
    expect(rec?.firstSeenAt).toBe("2026-05-01T00:00:00.000Z"); // preserved
    expect(rec?.firstName).toBe("Seed"); // untouched fields stay
  });

  it("does not overwrite existing values with null/undefined patch fields", async () => {
    await seed(ID_A, "user-a");
    await cstore.enrichConnection(
      ID_A,
      { title: "Eng", company: "Co" },
      "core",
      "2026-06-01T00:00:00.000Z"
    );
    // A later core pass that resolves no company must not wipe the prior one.
    await cstore.enrichConnection(
      ID_A,
      { title: "Senior Eng", company: null },
      "core",
      "2026-06-02T00:00:00.000Z"
    );
    const rec = await cstore.readConnection(ID_A);
    expect(rec?.title).toBe("Senior Eng");
    expect(rec?.company).toBe("Co");
  });

  it("returns false for an unknown record", async () => {
    expect(
      await cstore.enrichConnection(
        "does-not-exist",
        { title: "x" },
        "core",
        "2026-06-01T00:00:00.000Z"
      )
    ).toBe(false);
  });
});

describe("hasConnection / readInvitation (connect pre-checks)", () => {
  it("finds a stored connection by flagship id and by slug", async () => {
    await seed(ID_A, "user-a");
    expect(await cstore.hasConnection(ID_A)).toBe(true);
    expect(await cstore.hasConnection("user-a")).toBe(true);
  });

  it("returns false for someone not in the store", async () => {
    await seed(ID_A, "user-a");
    expect(await cstore.hasConnection(ID_B)).toBe(false);
    expect(await cstore.hasConnection("nobody")).toBe(false);
  });

  it("reads back a recorded invitation, and null when none exists", async () => {
    expect(await cstore.readInvitation(ID_B)).toBeNull();
    await cstore.recordInvitation({
      inviteeId: ID_B,
      inviteeUrn: `urn:li:fsd_profile:${ID_B}`,
      publicIdentifier: "user-b",
      note: "hi",
      invitationUrn: "urn:li:fsd_invitation:7000000000000000001",
      sentAt: "2026-06-01T00:00:00.000Z",
    });
    expect((await cstore.readInvitation(ID_B))?.note).toBe("hi");
  });
});

describe("recordInvitation", () => {
  it("writes an invitation record and a slug symlink", async () => {
    await cstore.recordInvitation({
      inviteeId: ID_A,
      inviteeUrn: `urn:li:fsd_profile:${ID_A}`,
      publicIdentifier: "user-a",
      note: "hello",
      invitationUrn: "urn:li:fsd_invitation:7000000000000000000",
      sentAt: "2026-06-01T00:00:00.000Z",
    });
    const rec = JSON.parse(await readFile(join(accountDir, "invitations", `${ID_A}.json`), "utf8"));
    expect(rec.invitationUrn).toBe("urn:li:fsd_invitation:7000000000000000000");
    expect(rec.note).toBe("hello");
    expect(await readlink(join(accountDir, "invitations", "user-a"))).toBe(`${ID_A}.json`);
  });
});
