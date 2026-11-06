/**
 * `allman install-browsers` must install the Chromium revision that the
 * Playwright embedded in this binary launches. An unpinned
 * `npx playwright install chromium` resolves the latest Playwright from npm
 * whenever it isn't run inside a checkout, which installs a different revision.
 */

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { playwrightInstallArgs } from "@/utils/playwright-install.js";

const require = createRequire(import.meta.url);

/** The playwright-core that `playwright` actually loads, i.e. what launches Chromium. */
function embeddedPlaywrightCoreVersion(): string {
  const playwrightDir = dirname(require.resolve("playwright/package.json"));
  const fromPlaywright = createRequire(join(playwrightDir, "package.json"));
  return (fromPlaywright("playwright-core/package.json") as { version: string }).version;
}

describe("playwrightInstallArgs", () => {
  it("pins the install to the Playwright version the binary embeds", () => {
    expect(playwrightInstallArgs()).toEqual([
      `playwright@${embeddedPlaywrightCoreVersion()}`,
      "install",
      "chromium",
    ]);
  });

  it("never produces an unpinned (latest-resolving) package specifier", () => {
    expect(playwrightInstallArgs()[0]).toMatch(/^playwright@\d+\.\d+\.\d+/);
  });

  it("accepts an explicit version", () => {
    expect(playwrightInstallArgs("1.2.3")).toEqual(["playwright@1.2.3", "install", "chromium"]);
  });
});
