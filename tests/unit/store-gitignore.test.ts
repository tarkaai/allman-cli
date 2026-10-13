import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureGitignore } from "@/store/git.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "allman-gitignore-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("ensureGitignore", () => {
  it("writes the full template into a new store", async () => {
    await ensureGitignore(dir);
    const text = await readFile(join(dir, ".gitignore"), "utf8");
    expect(text).toContain("COOKIES.json\n");
    expect(text).toContain("COOKIES.json.*.tmp\n");
    expect(text).toContain("media/\n");
  });

  it("appends entries an older store's .gitignore lacks, keeping what is there", async () => {
    await writeFile(join(dir, ".gitignore"), "COOKIES.json\ncustom-thing\n", "utf8");
    await ensureGitignore(dir);
    const text = await readFile(join(dir, ".gitignore"), "utf8");
    expect(text.startsWith("COOKIES.json\ncustom-thing\n")).toBe(true);
    expect(text).toContain("COOKIES.json.*.tmp\n");
    expect(text.split("\n").filter((l) => l === "COOKIES.json").length).toBe(1);
  });

  it("leaves a complete .gitignore untouched", async () => {
    await ensureGitignore(dir);
    const before = await readFile(join(dir, ".gitignore"), "utf8");
    await ensureGitignore(dir);
    expect(await readFile(join(dir, ".gitignore"), "utf8")).toBe(before);
  });
});
