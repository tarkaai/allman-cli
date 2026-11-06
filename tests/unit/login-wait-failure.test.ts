/**
 * runLogin: what the user is told when the wait for login fails.
 *
 * `page.waitForURL` rejects for several reasons. Only a real timeout may be
 * reported as one; closing the window rejects immediately and used to be
 * reported as "Login timed out after 300s".
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const page = {
    on: vi.fn(),
    goto: vi.fn(),
    waitForURL: vi.fn(),
    isClosed: vi.fn(),
  };
  const context = {
    newPage: vi.fn(),
    addCookies: vi.fn(),
  };
  const browser = {
    newContext: vi.fn(),
    close: vi.fn(),
    isConnected: vi.fn(),
  };
  return { page, context, browser, launch: vi.fn() };
});

vi.mock("playwright", () => ({ chromium: { launch: h.launch } }));

import { runLogin } from "@/linkedin/auth/playwright-auth.js";

const CLOSED_MESSAGE = "page.waitForURL: Target page, context or browser has been closed";

function playwrightTimeout(): Error {
  const err = new Error("page.waitForURL: Timeout 300000ms exceeded.");
  err.name = "TimeoutError";
  return err;
}

describe("runLogin when the wait for login fails", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.launch.mockResolvedValue(h.browser);
    h.browser.newContext.mockResolvedValue(h.context);
    h.browser.close.mockResolvedValue(undefined);
    h.browser.isConnected.mockReturnValue(true);
    h.context.newPage.mockResolvedValue(h.page);
    h.page.goto.mockResolvedValue(undefined);
    h.page.isClosed.mockReturnValue(false);
  });

  it("reports a real Playwright timeout as a timeout", async () => {
    h.page.waitForURL.mockRejectedValue(playwrightTimeout());

    const result = await runLogin();

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/timed out after \d+s/);
    expect(h.browser.close).toHaveBeenCalledTimes(1);
  });

  it("says the window was closed when the page is gone, not that it timed out", async () => {
    h.page.waitForURL.mockRejectedValue(new Error(CLOSED_MESSAGE));
    h.page.isClosed.mockReturnValue(true);

    const result = await runLogin();

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/window was closed/i);
    expect(result.error).not.toMatch(/timed out/i);
  });

  it("says the window was closed when the whole browser has disconnected", async () => {
    h.page.waitForURL.mockRejectedValue(new Error(CLOSED_MESSAGE));
    h.browser.isConnected.mockReturnValue(false);

    const result = await runLogin();

    expect(result.error).toMatch(/window was closed/i);
    expect(result.error).not.toMatch(/timed out/i);
  });

  it("surfaces any other error instead of swallowing it", async () => {
    h.page.waitForURL.mockRejectedValue(new Error("net::ERR_INTERNET_DISCONNECTED\n  at stack"));

    const result = await runLogin();

    expect(result.success).toBe(false);
    expect(result.error).toContain("net::ERR_INTERNET_DISCONNECTED");
    expect(result.error).not.toMatch(/timed out/i);
    expect(result.error).not.toContain("at stack");
  });

  it("still cleans up when closing an already-dead browser throws", async () => {
    h.page.waitForURL.mockRejectedValue(new Error(CLOSED_MESSAGE));
    h.page.isClosed.mockReturnValue(true);
    h.browser.close.mockRejectedValue(new Error("Browser has been closed"));

    const result = await runLogin();

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/window was closed/i);
  });
});
