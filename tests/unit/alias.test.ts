import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readlink, mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { ensureDir, ensureAlias, forceAlias, resolveAlias } from "../../src/store/alias.js";

describe("alias utilities", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "lilac-alias-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  describe("ensureDir", () => {
    it("creates a directory and returns its path", async () => {
      const result = await ensureDir(dir, "2-abc");
      expect(result).toBe(join(dir, "2-abc"));
      // Verify it exists by writing a file into it
      await writeFile(join(result, "test"), "ok");
    });

    it("is idempotent", async () => {
      await ensureDir(dir, "2-abc");
      const result = await ensureDir(dir, "2-abc");
      expect(result).toBe(join(dir, "2-abc"));
    });
  });

  describe("ensureAlias", () => {
    it("creates a symlink", async () => {
      await ensureAlias(dir, "my-slug", "2-abc");
      const target = await readlink(join(dir, "my-slug"));
      expect(target).toBe("2-abc");
    });

    it("is idempotent when target matches", async () => {
      await ensureAlias(dir, "my-slug", "2-abc");
      await ensureAlias(dir, "my-slug", "2-abc"); // should not throw
      const target = await readlink(join(dir, "my-slug"));
      expect(target).toBe("2-abc");
    });

    it("throws on conflict (different target)", async () => {
      await ensureAlias(dir, "my-slug", "2-abc");
      await expect(ensureAlias(dir, "my-slug", "2-xyz")).rejects.toThrow(
        /Alias conflict/
      );
    });
  });

  describe("forceAlias", () => {
    it("creates a symlink", async () => {
      await forceAlias(dir, "my-slug", "2-abc");
      const target = await readlink(join(dir, "my-slug"));
      expect(target).toBe("2-abc");
    });

    it("overwrites when target changes", async () => {
      await forceAlias(dir, "my-slug", "2-abc");
      await forceAlias(dir, "my-slug", "2-xyz");
      const target = await readlink(join(dir, "my-slug"));
      expect(target).toBe("2-xyz");
    });

    it("is idempotent when target matches", async () => {
      await forceAlias(dir, "my-slug", "2-abc");
      await forceAlias(dir, "my-slug", "2-abc");
      const target = await readlink(join(dir, "my-slug"));
      expect(target).toBe("2-abc");
    });
  });

  describe("resolveAlias", () => {
    it("resolves a symlink to its target", async () => {
      await ensureAlias(dir, "my-slug", "2-abc");
      const result = await resolveAlias(dir, "my-slug");
      expect(result).toBe("2-abc");
    });

    it("resolves a direct convId directory with RECORD.json", async () => {
      await mkdir(join(dir, "2-abc"), { recursive: true });
      await writeFile(join(dir, "2-abc", "RECORD.json"), "{}");
      const result = await resolveAlias(dir, "2-abc");
      expect(result).toBe("2-abc");
    });

    it("returns null for non-existent alias", async () => {
      const result = await resolveAlias(dir, "nonexistent");
      expect(result).toBeNull();
    });

    it("returns null for directory without RECORD.json", async () => {
      await mkdir(join(dir, "some-dir"), { recursive: true });
      const result = await resolveAlias(dir, "some-dir");
      expect(result).toBeNull();
    });
  });
});
