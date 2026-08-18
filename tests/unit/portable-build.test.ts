import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { rewritePlaywrightPackageLookups } from "../../scripts/build-rewrites.ts";

const root = resolve(import.meta.dirname, "../..");

describe("rewritePlaywrightPackageLookups", () => {
  test("removes build-machine package metadata resolution", () => {
    const source = `const coreDir = path.dirname(require.resolve("../../../package.json"));`;

    expect(rewritePlaywrightPackageLookups(source)).toEqual({
      contents: `const coreDir = path.dirname(process.execPath);`,
      replacements: 1,
    });
  });

  test("leaves ordinary package imports unchanged", () => {
    const source = `const packageJson = require("../../../package.json");`;

    expect(rewritePlaywrightPackageLookups(source)).toEqual({
      contents: source,
      replacements: 0,
    });
  });

  test.runIf(process.platform === "darwin" || process.platform === "linux")(
    "compiled executable runs after its Playwright source tree is removed",
    () => {
      const temp = mkdtempSync(join(tmpdir(), "allman-portable-build-"));
      const sourceDir = join(temp, "source");
      const moduleDir = join(sourceDir, "node_modules/playwright-core/lib/server/utils");
      const entrypoint = join(sourceDir, "entry.ts");
      const outfile = join(temp, "portable-smoke");
      mkdirSync(moduleDir, { recursive: true });
      writeFileSync(
        join(sourceDir, "node_modules/playwright-core/package.json"),
        JSON.stringify({ name: "playwright-core", version: "test" })
      );
      writeFileSync(
        join(moduleDir, "nodePlatform.js"),
        `const path = require("node:path");\nexports.coreDir = path.dirname(require.resolve("../../../package.json"));\n`
      );
      writeFileSync(
        entrypoint,
        `import { coreDir } from "./node_modules/playwright-core/lib/server/utils/nodePlatform.js";\nconsole.log(coreDir);\n`
      );

      try {
        const build = spawnSync("bun", ["scripts/build.ts"], {
          cwd: root,
          encoding: "utf8",
          env: { ...process.env, ENTRYPOINT: entrypoint, OUTFILE: outfile },
        });
        expect(build.status, build.stderr).toBe(0);

        rmSync(sourceDir, { recursive: true, force: true });
        const run = spawnSync(outfile, { encoding: "utf8" });

        expect(run.status, run.stderr).toBe(0);
        expect(realpathSync(run.stdout.trim())).toBe(realpathSync(dirname(outfile)));
      } finally {
        rmSync(temp, { recursive: true, force: true });
      }
    }
  );
});
