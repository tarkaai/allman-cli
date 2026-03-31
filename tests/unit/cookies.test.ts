import { describe, it, expect } from "vitest";
import { CookieJar, Cookie } from "tough-cookie";
import {
  loadCookieJar,
  serializeCookieJar,
  buildCookieHeader,
  getCsrfToken,
  mergeCookies,
  cookiesFromPlaywright,
  isAuthenticated,
  newCookieJar,
} from "@/linkedin/api/cookies.js";
import type { AccountRecord } from "@/store/types.js";

const RECORD_BASE: AccountRecord = {
  urn: null,
  profileSlug: null,
  name: null,
  headline: null,
  profileUrl: null,
  imageUrl: null,
  userType: null,
  networkSize: null,
  status: "authenticated",
  cookieJar: null,
  cookiesUpdatedAt: null,
  lastSyncAt: null,
};

async function makeJarWithJsessionid(value = '"abc123"'): Promise<CookieJar> {
  const jar = newCookieJar();
  const cookie = new Cookie({
    key: "JSESSIONID",
    value,
    domain: ".www.linkedin.com",
    path: "/",
  });
  await jar.setCookie(cookie, "https://www.linkedin.com");
  return jar;
}

describe("loadCookieJar", () => {
  it("returns empty jar when cookieJar is null", () => {
    const jar = loadCookieJar({ ...RECORD_BASE, cookieJar: null });
    expect(jar).toBeInstanceOf(CookieJar);
  });

  it("loads a previously serialized jar", async () => {
    const jar = await makeJarWithJsessionid();
    const serialized = serializeCookieJar(jar);
    const loaded = loadCookieJar({ ...RECORD_BASE, cookieJar: serialized });
    const token = await getCsrfToken(loaded);
    expect(token).toBe("abc123");
  });
});

describe("getCsrfToken", () => {
  it("extracts JSESSIONID value without surrounding quotes", async () => {
    const jar = await makeJarWithJsessionid('"my-csrf-token-123"');
    const token = await getCsrfToken(jar);
    expect(token).toBe("my-csrf-token-123");
  });

  it("works without quotes in JSESSIONID value", async () => {
    const jar = await makeJarWithJsessionid("no-quotes-token");
    const token = await getCsrfToken(jar);
    expect(token).toBe("no-quotes-token");
  });

  it("returns null when JSESSIONID is absent", async () => {
    const jar = new CookieJar();
    const token = await getCsrfToken(jar);
    expect(token).toBeNull();
  });
});

describe("buildCookieHeader", () => {
  it("builds a semicolon-separated cookie string", async () => {
    const jar = newCookieJar();
    await jar.setCookie(
      new Cookie({ key: "li_at", value: "TOKEN1", domain: ".linkedin.com", path: "/" }),
      "https://linkedin.com"
    );
    await jar.setCookie(
      new Cookie({ key: "JSESSIONID", value: '"SESSION1"', domain: ".www.linkedin.com", path: "/" }),
      "https://www.linkedin.com"
    );
    const header = await buildCookieHeader(jar);
    expect(header).toContain("li_at=TOKEN1");
    expect(header).toContain('JSESSIONID="SESSION1"');
  });

  it("returns empty string for empty jar", async () => {
    const jar = newCookieJar();
    const header = await buildCookieHeader(jar);
    expect(header).toBe("");
  });
});

describe("mergeCookies", () => {
  it("adds new cookies from Set-Cookie headers", async () => {
    const jar = newCookieJar();
    await mergeCookies(jar, [
      "JSESSIONID=\"newtoken\"; Path=/; Domain=.www.linkedin.com; Secure; HttpOnly",
    ]);
    const token = await getCsrfToken(jar);
    expect(token).toBe("newtoken");
  });

  it("updates existing cookies on merge", async () => {
    const jar = await makeJarWithJsessionid('"old"');
    await mergeCookies(jar, [
      'JSESSIONID="new"; Path=/; Domain=.www.linkedin.com; Secure; HttpOnly',
    ]);
    const token = await getCsrfToken(jar);
    expect(token).toBe("new");
  });

  it("skips malformed cookie strings", async () => {
    const jar = newCookieJar();
    // Should not throw
    await mergeCookies(jar, ["", "   "]);
    const cookies = await jar.getCookies("https://www.linkedin.com");
    expect(cookies.length).toBe(0);
  });
});

describe("cookiesFromPlaywright", () => {
  it("converts Playwright cookies to a CookieJar", async () => {
    const playwrightCookies = [
      {
        name: "JSESSIONID",
        value: '"playwright-session"',
        domain: ".www.linkedin.com",
        path: "/",
        secure: true,
        httpOnly: true,
        expires: -1,
        sameSite: "None",
      },
      {
        name: "li_at",
        value: "li_at_value",
        domain: ".linkedin.com",
        path: "/",
        secure: true,
        httpOnly: false,
        expires: -1,
        sameSite: "None",
      },
    ];

    const jar = await cookiesFromPlaywright(playwrightCookies);
    const token = await getCsrfToken(jar);
    expect(token).toBe("playwright-session");
    const header = await buildCookieHeader(jar);
    expect(header).toContain("li_at=li_at_value");
  });

  it("ignores non-LinkedIn cookies", async () => {
    const jar = await cookiesFromPlaywright([
      { name: "tracking", value: "xyz", domain: ".google.com", path: "/" },
    ]);
    const cookies = await jar.getCookies("https://www.linkedin.com");
    expect(cookies.length).toBe(0);
  });
});

describe("isAuthenticated", () => {
  it("returns true when JSESSIONID present", async () => {
    const jar = await makeJarWithJsessionid('"valid"');
    expect(await isAuthenticated(jar)).toBe(true);
  });

  it("returns false when JSESSIONID absent", async () => {
    const jar = new CookieJar();
    expect(await isAuthenticated(jar)).toBe(false);
  });
});
