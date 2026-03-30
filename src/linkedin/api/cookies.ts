/**
 * Cookie management for the LinkedIn API client.
 *
 * LinkedIn uses cookies for authentication. The flow:
 *   1. After login via Playwright, cookies are extracted from the browser context
 *      and stored in accounts/{slug}/RECORD.json as a CookieJar JSON object.
 *   2. Before every API request, we load the CookieJar, build the Cookie header,
 *      and extract the CSRF token (= JSESSIONID value, quotes stripped).
 *   3. After every API response, we parse any Set-Cookie headers and merge them
 *      into the CookieJar, then persist back to the store.
 *
 * All cookie handling is RFC 6265-compliant via tough-cookie.
 *
 * Reference: monorepo/lib/services/.../linkedin-api-services.ts
 *            lilac/api/src/services/session/cookie-set.ts
 */

import { CookieJar, Cookie } from "tough-cookie";
import type { AccountRecord } from "../../store/types.js";

export const LINKEDIN_DOMAIN = ".www.linkedin.com";
export const CSRF_COOKIE_NAME = "JSESSIONID";

/**
 * CookieJar options for LinkedIn.
 * rejectPublicSuffixes: false — required in tough-cookie v6 for .linkedin.com domain
 * to be matched by getCookies("https://www.linkedin.com").
 */
const JAR_OPTIONS = { rejectPublicSuffixes: false };

/** Load a CookieJar from a stored account record. Returns an empty jar if none stored. */
export function loadCookieJar(record: AccountRecord): CookieJar {
  if (!record.cookieJar) {
    return new CookieJar(undefined, JAR_OPTIONS);
  }
  try {
    const jar = CookieJar.fromJSON(JSON.stringify(record.cookieJar));
    // Re-apply options since fromJSON doesn't preserve them
    return jar;
  } catch {
    return new CookieJar(undefined, JAR_OPTIONS);
  }
}

/** Create a new empty CookieJar with the correct options for LinkedIn. */
export function newCookieJar(): CookieJar {
  return new CookieJar(undefined, JAR_OPTIONS);
}

/** Serialize a CookieJar to a plain object for storage in RECORD.json. */
export function serializeCookieJar(jar: CookieJar): object {
  return JSON.parse(JSON.stringify(jar.toJSON())) as object;
}

/**
 * Build the Cookie header string for a LinkedIn API request.
 *
 * Uses store.getAllCookies() instead of getCookies(url) to avoid tough-cookie v6's
 * strict PSL domain matching, which can drop legitimate cookies set on .linkedin.com.
 * We manually filter for linkedin.com domains, with www-specific cookies winning
 * on name collisions.
 */
export async function buildCookieHeader(jar: CookieJar): Promise<string> {
  const all = await jar.store.getAllCookies();
  const byName = new Map<string, string>();

  // Sort: broader domains first (.linkedin.com before .www.linkedin.com),
  // so more specific cookies overwrite on collision
  const linkedinCookies = all.filter(
    (c) => c.domain && (c.domain.includes("linkedin.com"))
  );
  linkedinCookies.sort((a, b) => (a.domain ?? "").length - (b.domain ?? "").length);

  for (const c of linkedinCookies) {
    const expires = c.expires;
    if (expires && expires !== "Infinity" && expires < new Date()) continue; // skip expired
    byName.set(c.key, c.value);
  }

  return Array.from(byName.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

/**
 * Extract the CSRF token from the CookieJar.
 * The CSRF token is the value of the JSESSIONID cookie, with surrounding quotes stripped.
 * Returns null if JSESSIONID is not present (not authenticated).
 *
 * Uses getAllCookies() scan to avoid tough-cookie v6 PSL domain matching issues.
 */
export async function getCsrfToken(jar: CookieJar): Promise<string | null> {
  const all = await jar.store.getAllCookies();
  const cookie = all.find(
    (c) => c.key === CSRF_COOKIE_NAME && c.domain && c.domain.includes("linkedin.com")
  );
  if (!cookie) return null;
  return cookie.value.replace(/"/g, "");
}

/**
 * Merge Set-Cookie response headers into the CookieJar.
 * Handles LinkedIn's domain normalization quirk: tough-cookie strips leading dots,
 * but LinkedIn sends "domain=.linkedin.com" — we restore the dot.
 *
 * Returns the updated jar (same instance).
 */
export async function mergeCookies(jar: CookieJar, setCookieHeaders: string[]): Promise<CookieJar> {
  for (const cookieStr of setCookieHeaders) {
    const cookie = Cookie.parse(cookieStr);
    if (!cookie) continue;

    // Restore the leading dot that tough-cookie strips from domain
    if (
      cookieStr.toLowerCase().includes("; domain=.") &&
      cookie.domain &&
      !cookie.domain.startsWith(".")
    ) {
      cookie.domain = `.${cookie.domain}`;
    }

    const url = `http${cookie.secure ? "s" : ""}://${cookie.domain ?? "www.linkedin.com"}`;
    try {
      await jar.setCookie(cookie, url);
    } catch {
      // Ignore cookies that can't be set (e.g. invalid domain)
    }
  }
  return jar;
}

/**
 * Extract cookies from Playwright's browser context format and load them into a CookieJar.
 * Playwright returns cookies as an array of objects with `name`, `value`, `domain`, etc.
 */
export async function cookiesFromPlaywright(
  playwrightCookies: PlaywrightCookie[]
): Promise<CookieJar> {
  const jar = new CookieJar(undefined, JAR_OPTIONS);
  for (const pc of playwrightCookies) {
    if (!pc.domain.includes("linkedin.com")) continue;

    const cookie = new Cookie({
      key: pc.name,
      value: pc.value,
      domain: pc.domain.startsWith(".") ? pc.domain : `.${pc.domain}`,
      path: pc.path ?? "/",
      secure: pc.secure ?? false,
      httpOnly: pc.httpOnly ?? false,
      expires: pc.expires && pc.expires !== -1 ? new Date(pc.expires * 1000) : "Infinity",
      sameSite: normalizeSameSite(pc.sameSite),
    });

    const url = `http${pc.secure ? "s" : ""}://${pc.domain.replace(/^\./, "")}`;
    try {
      await jar.setCookie(cookie, url);
    } catch {
      // Skip invalid cookies
    }
  }
  return jar;
}

/** Playwright cookie shape (from page.context().cookies()). */
export interface PlaywrightCookie {
  name: string;
  value: string;
  domain: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
}

function normalizeSameSite(
  value: string | undefined
): "Strict" | "Lax" | "None" | "no_restriction" | undefined {
  if (!value) return undefined;
  const lower = value.toLowerCase();
  if (lower === "strict") return "Strict";
  if (lower === "lax") return "Lax";
  if (lower === "none" || lower === "no_restriction") return "None";
  return undefined;
}

/** Check if a CookieJar has a valid JSESSIONID (i.e. appears authenticated). */
export async function isAuthenticated(jar: CookieJar): Promise<boolean> {
  const token = await getCsrfToken(jar);
  return token !== null && token.length > 0;
}
