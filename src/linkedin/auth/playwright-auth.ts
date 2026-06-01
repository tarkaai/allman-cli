/**
 * LinkedIn authentication via headed Playwright browser.
 *
 * Because LinkedIn's login flow is highly interactive (2FA app notifications,
 * TOTP codes, email codes, captcha, device verification), we always use a
 * headed browser and let the human complete login manually.
 *
 * The CLI:
 *   1. Opens a Chromium window (headed)
 *   2. Injects existing cookies if any (may skip login form entirely)
 *   3. Navigates to linkedin.com/login
 *   4. Waits for the user to complete login (URL becomes /feed or /in/)
 *   5. Intercepts voyagerIdentityDashProfiles API response to extract the profile URN
 *   6. Extracts all cookies from the browser context
 *   7. Saves everything to the account RECORD.json
 *
 * Re-auth flow (cookies exist but expired):
 *   Same as above — inject existing cookies first. LinkedIn may skip the login
 *   form if they're still valid.
 *
 * Timeout: 5 minutes (configurable via LOGIN_TIMEOUT_MS env var).
 */

import { type BrowserContext, chromium, type Page } from "playwright";
import * as output from "../../utils/output.js";
import { cookiesFromPlaywright, isAuthenticated, type PlaywrightCookie } from "../api/cookies.js";

const LOGIN_URL = "https://www.linkedin.com/login";
const FEED_URL_PATTERN = /linkedin\.com\/(feed|in\/|messaging)/;
const PROFILE_URN_REGEX = /urn:li:fsd_profile:([^,)"]+)/;

const LOGIN_TIMEOUT_MS = parseInt(process.env.LOGIN_TIMEOUT_MS ?? "300000", 10); // 5 minutes

export interface AuthResult {
  success: boolean;
  profileUrn: string | null;
  name: string | null;
  headline: string | null;
  profileUrl: string | null;
  imageUrl: string | null;
  cookieJar: object;
  error?: string;
}

export interface AuthOptions {
  /** Existing cookies to inject before navigating (for re-auth). */
  existingCookieJar?: object | null;
  /** Override executable path for Chromium. */
  executablePath?: string;
  /** Visit Sales Navigator to capture the seat cookie (optional; default true). */
  salesnav?: boolean;
}

/**
 * Run the interactive login flow.
 * Opens a headed Chromium window and waits for the user to authenticate.
 */
export async function runLogin(options: AuthOptions = {}): Promise<AuthResult> {
  const executablePath = options.executablePath ?? process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;

  output.info("Opening LinkedIn in browser — please complete login in the browser window.");
  output.info(`Waiting up to ${Math.round(LOGIN_TIMEOUT_MS / 60000)} minutes...`);

  const browser = await chromium.launch({
    headless: false,
    ...(executablePath ? { executablePath } : {}),
    args: ["--no-sandbox", "--disable-blink-features=AutomationControlled", "--disable-infobars"],
  });

  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 800 },
  });

  // Inject existing cookies if provided (may let us skip login entirely)
  if (options.existingCookieJar) {
    try {
      const cookieData = options.existingCookieJar as { cookies?: PlaywrightCookie[] };
      if (cookieData.cookies && Array.isArray(cookieData.cookies)) {
        const playwrightCookies = cookieData.cookies
          .map((c) => toughCookieToPlaywright(c as unknown as Record<string, unknown>))
          .filter(Boolean) as Array<{
          name: string;
          value: string;
          domain: string;
          path: string;
          expires?: number;
          httpOnly?: boolean;
          secure?: boolean;
          sameSite?: "Strict" | "Lax" | "None";
        }>;
        if (playwrightCookies.length > 0) {
          await context.addCookies(playwrightCookies);
          output.debug(`Injected ${playwrightCookies.length} existing cookies`);
        }
      }
    } catch (err) {
      output.debug(`Failed to inject existing cookies: ${String(err)}`);
    }
  }

  let profileUrn: string | null = null;
  let interceptedProfileData: ProfileApiData | null = null;

  const page = await context.newPage();

  // Listen for profile URN in API responses (works better than route interception
  // because it doesn't block/modify the request, just observes it)
  page.on("response", async (response) => {
    if (!profileUrn && response.url().includes("voyagerIdentityDashProfiles")) {
      try {
        if (response.request().method() === "OPTIONS" || response.status() !== 200) return;
        const body = (await response.json()) as unknown;
        const urnMatch = JSON.stringify(body).match(PROFILE_URN_REGEX);
        if (urnMatch?.[1]) {
          profileUrn = `urn:li:fsd_profile:${urnMatch[1]}`;
          interceptedProfileData = extractProfileFromApiResponse(body);
          output.debug(`Captured profile URN from response: ${profileUrn}`);
        }
      } catch {
        // Non-JSON or inaccessible response
      }
    }
  });

  try {
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
  } catch {
    // Timeout on initial navigation is OK — LinkedIn can be slow
  }

  // Wait for successful authentication (URL changes to /feed, /in/, or /messaging)
  output.info("Waiting for you to complete login...");
  try {
    await page.waitForURL(FEED_URL_PATTERN, { timeout: LOGIN_TIMEOUT_MS });
  } catch {
    await browser.close();
    return {
      success: false,
      profileUrn: null,
      name: null,
      headline: null,
      profileUrl: null,
      imageUrl: null,
      cookieJar: {},
      error: `Login timed out after ${LOGIN_TIMEOUT_MS / 1000}s. Please try again.`,
    };
  }

  output.success("Login detected — extracting session...");

  // If we haven't captured the profile URN via response listener yet,
  // navigate to the profile page to trigger the voyagerIdentityDashProfiles API call.
  // The response listener on `page` will set profileUrn if the call succeeds.
  if (!profileUrn) {
    await extractProfileUrnFromPage(page, context);
    // profileUrn may now be set by the response listener — don't overwrite it
  }

  // Warm the Sales Navigator seat (best-effort, optional). Visiting the SalesNav
  // app lets the SPA run its enterprise-auth handshake in-browser, which sets the
  // seat cookies. Capturing those here means later `sales-api/*` REST calls work
  // with no per-call handshake. Accounts without a SalesNav seat just fall
  // through; skipped entirely when salesnav === false.
  if (options.salesnav !== false) {
    await warmSalesNavSeat(page);
  }

  // Extract all cookies from the browser context
  const rawCookies = await context.cookies();
  const jar = await cookiesFromPlaywright(
    rawCookies.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      expires: c.expires,
      httpOnly: c.httpOnly,
      secure: c.secure,
      sameSite: c.sameSite,
    }))
  );

  const isAuth = await isAuthenticated(jar);
  if (!isAuth) {
    await browser.close();
    return {
      success: false,
      profileUrn: null,
      name: null,
      headline: null,
      profileUrl: null,
      imageUrl: null,
      cookieJar: {},
      error: "Authentication appeared to succeed but session cookies are missing.",
    };
  }

  // Extract profile data from page DOM if not captured via interception
  const domProfile = (await extractProfileFromDom(page)) as DomProfileData;
  const name = (interceptedProfileData as ProfileApiData | null)?.name ?? domProfile.name;
  const headline =
    (interceptedProfileData as ProfileApiData | null)?.headline ?? domProfile.headline;
  const profileUrl = domProfile.profileUrl;
  const imageUrl = domProfile.imageUrl;

  await browser.close();

  const { serializeCookieJar } = await import("../api/cookies.js");
  const cookieJar = serializeCookieJar(jar);

  output.success(`Authenticated as: ${name ?? "unknown"}`);

  return {
    success: true,
    profileUrn,
    name,
    headline,
    profileUrl,
    imageUrl,
    cookieJar,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ProfileApiData {
  name: string | null;
  headline: string | null;
}

interface DomProfileData {
  name: string | null;
  headline: string | null;
  profileUrl: string | null;
  imageUrl: string | null;
}

function extractProfileFromApiResponse(body: unknown): ProfileApiData {
  try {
    const str = JSON.stringify(body);
    // Try to find firstName/lastName in the response
    const firstMatch = str.match(/"firstName":"([^"]+)"/);
    const lastMatch = str.match(/"lastName":"([^"]+)"/);
    const headlineMatch = str.match(/"headline":"([^"]+)"/);
    const name = firstMatch && lastMatch ? `${firstMatch[1]} ${lastMatch[1]}`.trim() : null;
    return { name, headline: headlineMatch ? (headlineMatch[1] ?? null) : null };
  } catch {
    return { name: null, headline: null };
  }
}

/**
 * The cookie that carries the Sales Navigator seat. Set by the SPA only after
 * the full enterprise-auth handshake completes (i.e. once the app lands on
 * /sales/home — NOT at the intermediate /sales/contract-chooser step). Once
 * present in the saved jar, all `sales-api/*` REST calls work with no per-call
 * handshake. ~30-day expiry, refreshed on each login.
 */
const SALESNAV_SEAT_COOKIE = "li_a";

/**
 * Visit Sales Navigator so the SPA runs its enterprise-auth handshake and sets
 * the seat cookies (`li_a`, `li_ep_auth_context`) in the browser context, which
 * the caller then captures into the saved jar.
 *
 * Strictly best-effort and OPTIONAL — login never depends on SalesNav:
 *   - Accounts without a seat never get `li_a`; we time out and skip quietly.
 *   - Any navigation error is swallowed.
 * We poll the context for `li_a` (the definitive "seat is live" signal) rather
 * than racing on a URL match, because the URL hits /sales/contract-chooser
 * before `li_a` is set.
 */
async function warmSalesNavSeat(page: Page): Promise<void> {
  output.info("Checking for a Sales Navigator seat (optional)...");
  const context = page.context();
  const deadline = Date.now() + 30_000;
  try {
    await page.goto("https://www.linkedin.com/sales/?trk=d_flagship3_nav", {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    while (Date.now() < deadline) {
      const cookies = await context.cookies();
      if (cookies.some((c) => c.name === SALESNAV_SEAT_COOKIE)) {
        output.success("Sales Navigator seat captured.");
        return;
      }
      // Bail fast if LinkedIn bounced us off the SalesNav app (no seat).
      const url = page.url();
      if (/\/(feed|premium|checkpoint)\b/.test(url) && !/\/sales\//.test(url)) break;
      await page.waitForTimeout(1500);
    }
    output.info(
      "No Sales Navigator seat detected — skipping (connections-of will need --salesnav off)."
    );
  } catch {
    output.debug("Sales Navigator warm-up skipped (navigation failed).");
  }
}

async function extractProfileUrnFromPage(
  page: Page,
  _context: BrowserContext
): Promise<string | null> {
  // Navigate to /in/ — LinkedIn redirects to the user's own profile page,
  // and the page load triggers a voyagerIdentityDashProfiles API call
  // that the page-level response listener will capture.
  try {
    await page.goto("https://www.linkedin.com/in/", {
      waitUntil: "domcontentloaded",
      timeout: 15_000,
    });

    // Wait a moment for XHR responses to land (the API call is async)
    await page.waitForTimeout(3000);

    // Return the profile slug from the redirected URL as a fallback identifier
    const url = page.url();
    const urlMatch = url.match(/linkedin\.com\/in\/([^/?]+)/);
    if (urlMatch?.[1]) {
      output.debug(`Profile slug from redirect: ${urlMatch[1]}`);
      return urlMatch[1]; // Return slug, not a full URN — caller handles lookup
    }
  } catch {
    // Navigation timeout is OK
  }

  return null;
}

async function extractProfileFromDom(page: Page): Promise<DomProfileData> {
  try {
    // page.evaluate runs in browser context — cast to bypass Node TS lib restrictions
    return await (page.evaluate as (fn: () => DomProfileData) => Promise<DomProfileData>)(() => {
      // biome-ignore lint/suspicious/noExplicitAny: browser globals not typed in Node lib
      const doc = (globalThis as any).document as {
        querySelector: (s: string) => { textContent?: string; src?: string } | null;
      };
      // biome-ignore lint/suspicious/noExplicitAny: browser globals not typed in Node lib
      const win = (globalThis as any).window as { location: { href: string } };
      const nameEl = doc.querySelector(
        ".artdeco-entity-lockup__title, .profile-nav-item__title, .t-24.t-bold"
      );
      const headlineEl = doc.querySelector(".profile-nav-item__text, .t-14.t-normal");
      const imageEl = doc.querySelector("img.global-nav__me-photo, img.profile-picture");
      const currentUrl = win.location.href;

      return {
        name: nameEl?.textContent?.trim() ?? null,
        headline: headlineEl?.textContent?.trim() ?? null,
        profileUrl: currentUrl.includes("/in/") ? currentUrl : null,
        imageUrl: imageEl?.src ?? null,
      };
    });
  } catch {
    return { name: null, headline: null, profileUrl: null, imageUrl: null };
  }
}

/** Convert a tough-cookie JSON object to Playwright's cookie format. */
function toughCookieToPlaywright(c: Record<string, unknown>): object | null {
  const domain = (c.domain as string | undefined) ?? "";
  if (!domain.includes("linkedin.com")) return null;

  const expiresRaw = c.expires;
  let expires: number | undefined;
  if (expiresRaw && expiresRaw !== "Infinity") {
    expires = Math.floor(new Date(expiresRaw as string).getTime() / 1000);
  }

  const sameSiteRaw = (c.sameSite as string | undefined)?.toLowerCase();
  const sameSite =
    sameSiteRaw === "strict"
      ? "Strict"
      : sameSiteRaw === "lax"
        ? "Lax"
        : sameSiteRaw === "none" || sameSiteRaw === "no_restriction"
          ? "None"
          : undefined;

  return {
    name: (c.key as string) ?? "",
    value: (c.value as string) ?? "",
    domain: domain.startsWith(".") ? domain : `.${domain}`,
    path: (c.path as string | undefined) ?? "/",
    ...(expires !== undefined ? { expires } : {}),
    httpOnly: (c.httpOnly as boolean | undefined) ?? false,
    secure: (c.secure as boolean | undefined) ?? false,
    ...(sameSite ? { sameSite } : {}),
  };
}
