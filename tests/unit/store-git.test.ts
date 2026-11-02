/**
 * StoreGit: stale `.git/index.lock` recovery and the non-throwing flush used
 * after a remote write has already succeeded.
 */

import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STALE_LOCK_MS, StoreGit } from "@/store/git.js";

const gitMock = vi.hoisted(() => ({
  init: vi.fn().mockResolvedValue(undefined),
  add: vi.fn().mockResolvedValue(undefined),
  commit: vi.fn().mockResolvedValue(undefined),
  status: vi.fn().mockResolvedValue({ files: [{ path: "x/RECORD.json" }] }),
  checkIsRepo: vi.fn().mockResolvedValue(true),
}));

vi.mock("simple-git", () => ({ default: vi.fn(() => gitMock) }));

const LOCK_ERROR = new Error(
  "fatal: Unable to create '/store/.git/index.lock': File exists.\n\nAnother git process seems to be running"
);

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false
  );
}

describe("StoreGit", () => {
  let dir: string;
  let lockPath: string;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    gitMock.add.mockResolvedValue(undefined);
    gitMock.commit.mockResolvedValue(undefined);
    gitMock.status.mockResolvedValue({ files: [{ path: "x/RECORD.json" }] });
    dir = await mkdtemp(join(tmpdir(), "allman-git-test-"));
    await mkdir(join(dir, ".git"), { recursive: true });
    lockPath = join(dir, ".git", "index.lock");
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(async () => {
    stderrSpy.mockRestore();
    await rm(dir, { recursive: true, force: true });
  });

  it("removes an index.lock nobody has touched for longer than STALE_LOCK_MS and commits", async () => {
    await writeFile(lockPath, "");
    const old = new Date(Date.now() - STALE_LOCK_MS - 60_000);
    await utimes(lockPath, old, old);
    gitMock.add.mockRejectedValueOnce(LOCK_ERROR);

    await new StoreGit(dir, 0).flush();

    expect(await exists(lockPath)).toBe(false);
    expect(gitMock.add).toHaveBeenCalledTimes(2);
    expect(gitMock.commit).toHaveBeenCalledTimes(1);
  });

  it("leaves a fresh index.lock alone — it belongs to a concurrent allman process", async () => {
    await writeFile(lockPath, "");
    gitMock.add.mockRejectedValueOnce(LOCK_ERROR);

    await new StoreGit(dir, 0).flush();

    expect(await exists(lockPath)).toBe(true);
    expect(gitMock.commit).toHaveBeenCalledTimes(1);
  });

  it("clearStaleLock is a no-op without a lock file", async () => {
    expect(await new StoreGit(dir, 0).clearStaleLock()).toBe(false);
  });

  it("flushOrWarn warns and returns false instead of throwing", async () => {
    gitMock.commit.mockRejectedValueOnce(new Error("fatal: unable to write new index file"));

    const ok = await new StoreGit(dir, 0).flushOrWarn("Message sent");

    expect(ok).toBe(false);
    const warned = stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
    expect(warned).toContain("Message sent, but the store commit failed");
    expect(warned).toContain("allman store commit");
  });

  it("flushOrWarn returns true when the commit succeeds", async () => {
    expect(await new StoreGit(dir, 0).flushOrWarn("Message sent")).toBe(true);
    expect(gitMock.commit).toHaveBeenCalledTimes(1);
  });
});
