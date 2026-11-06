/**
 * Arguments for `npx` to install the Chromium that this binary's Playwright
 * launches.
 *
 * Pinned on purpose. Each Playwright release uses a different Chromium
 * revision, and the browser is looked up by the revision of the Playwright
 * embedded in this binary. A bare `npx playwright install chromium` resolves
 * the *latest* Playwright from npm whenever it isn't run inside a checkout
 * (always, for the compiled binary) and installs a revision the binary never
 * looks for, so `allman login` still fails with "Executable doesn't exist".
 *
 * `playwright` depends on `playwright-core` at exactly its own version, so
 * this is also the version that launches the browser.
 */

import playwrightPackage from "playwright/package.json" with { type: "json" };

export function playwrightInstallArgs(version: string = playwrightPackage.version): string[] {
  return [`playwright@${version}`, "install", "chromium"];
}
