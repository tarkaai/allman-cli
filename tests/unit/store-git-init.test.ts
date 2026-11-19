/**
 * StoreGit.init() against real git: a store that lives inside another repo
 * must get its own repo, not silently commit into the parent.
 *
 * tests/setup.ts mocks simple-git globally with `checkIsRepo` always true,
 * which is exactly what hides this bug, so this file opts out of the mock and
 * uses real temp directories.
 */

import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StoreGit } from "@/store/git.js";

vi.unmock("simple-git");

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false
  );
}

describe("StoreGit.init (real git)", () => {
  let root: string;
  let parent: string;
  let store: string;

  beforeEach(async () => {
    // Hermetic: ignore the developer's global/system git config (gpgsign, hooks,
    // default branch) and give commits an identity.
    vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
    vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
    vi.stubEnv("GIT_AUTHOR_NAME", "allman test");
    vi.stubEnv("GIT_AUTHOR_EMAIL", "test@example.invalid");
    vi.stubEnv("GIT_COMMITTER_NAME", "allman test");
    vi.stubEnv("GIT_COMMITTER_EMAIL", "test@example.invalid");

    // realpath: macOS tmpdir() is a symlink (/var -> /private/var), and git
    // reports the resolved path.
    root = await realpath(await mkdtemp(join(tmpdir(), "allman-git-init-")));
    parent = join(root, "parent");
    store = join(parent, ".allman");
    await mkdir(store, { recursive: true });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  it("gives a store nested inside another repo its own repo", async () => {
    git(parent, "init", "--quiet");

    await new StoreGit(store).init();

    expect(await exists(join(store, ".git"))).toBe(true);
    expect(await realpath(git(store, "rev-parse", "--show-toplevel"))).toBe(store);
  });

  it("commits store files into the store repo, never the parent repo", async () => {
    git(parent, "init", "--quiet");
    await writeFile(join(parent, "unrelated.txt"), "not part of the store");
    await writeFile(join(store, "RECORD.json"), "{}");

    const storeGit = new StoreGit(store, 0);
    await storeGit.init();
    await storeGit.flush();

    expect(git(store, "rev-list", "--count", "HEAD")).toBe("1");
    expect(git(store, "ls-files")).toBe("RECORD.json");
    // The parent saw nothing: no staged files, no commits.
    expect(git(parent, "ls-files", "--cached")).toBe("");
    expect(git(parent, "rev-list", "--all", "--count")).toBe("0");
  });

  it("still initialises a store that is not inside any repo", async () => {
    const plain = join(root, "plain-store");
    await mkdir(plain);

    await new StoreGit(plain).init();

    expect(await realpath(git(plain, "rev-parse", "--show-toplevel"))).toBe(plain);
  });

  it("leaves an existing store repo alone", async () => {
    const storeGit = new StoreGit(store, 0);
    await storeGit.init();
    await writeFile(join(store, "RECORD.json"), "{}");
    await storeGit.flush();
    const head = git(store, "rev-parse", "HEAD");

    await new StoreGit(store).init();

    expect(git(store, "rev-parse", "HEAD")).toBe(head);
    expect(git(store, "rev-list", "--count", "HEAD")).toBe("1");
  });
});
