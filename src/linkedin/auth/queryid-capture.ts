/**
 * Headless discovery of the flagship people-SRP `voyagerSearchDashClusters.<hash>`
 * queryId — fully reverse-engineered from the live bundle, no manual hash.
 *
 * Why a browser at all: the queryId literals live in a large, lazily-loaded
 * webpack chunk (~24MB, an extensionless `static.licdn.com/aero-v1/sc/h/<id>`
 * asset) whose URL rotates per deploy and is NOT referenced in the static HTML —
 * only the running app pulls it. So we:
 *   1. Load people-search in headless Chromium with the session cookies and note
 *      the large CDN chunk URLs it fetches.
 *   2. Fetch the biggest chunk(s) directly (public CDN, no auth) and grep for
 *      `voyagerSearchDashClusters.<hash>` — the bundle ships SEVERAL variants
 *      (people, jobs, cluster-expansion, right-rail), so this yields candidates.
 *   3. Probe each candidate against the API (caller does this via
 *      `isPeopleSearchClustersQueryId`) and keep the one that returns people
 *      results.
 *
 * Flagship-only; unrelated to the Sales Navigator seat.
 */

import * as output from "../../utils/output.js";
import type { LinkedInApiClient } from "../api/client.js";
import { isPeopleSearchClustersQueryId } from "../api/endpoints/people-search.js";

const HASH_RX = /voyagerSearchDashClusters\.[a-f0-9]{32}/g;
const SEARCH_URL = "https://www.linkedin.com/search/results/people/?keywords=a";
const CAPTURE_TIMEOUT_MS = parseInt(process.env.ALLMAN_QID_TIMEOUT_MS ?? "30000", 10);
/** Only fetch chunks at least this large (compressed) — the query manifest is by
 *  far the biggest asset; this keeps us from fetching dozens of small chunks. */
const MIN_CHUNK_BYTES = 1_000_000;
const MAX_CHUNK_FETCHES = 5;

interface StoredCookie {
  key: string;
  value: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  expires?: string;
  sameSite?: string;
}

function jarToPlaywrightCookies(cookieJar: unknown): Array<Record<string, unknown>> {
  const cookies = (cookieJar as { cookies?: StoredCookie[] } | null)?.cookies ?? [];
  const ssMap: Record<string, "Lax" | "None" | "Strict"> = {
    lax: "Lax",
    none: "None",
    strict: "Strict",
  };
  const now = Date.now();
  return cookies
    .filter((c) => c.domain?.includes("linkedin.com"))
    .filter((c) => !c.expires || c.expires === "Infinity" || new Date(c.expires).getTime() > now)
    .map((c) => ({
      name: c.key,
      value: c.value,
      domain: c.domain?.startsWith(".") ? c.domain : `.${c.domain}`,
      path: c.path ?? "/",
      secure: c.secure ?? false,
      httpOnly: c.httpOnly ?? false,
      expires:
        c.expires && c.expires !== "Infinity"
          ? Math.floor(new Date(c.expires).getTime() / 1000)
          : -1,
      sameSite: c.sameSite ? (ssMap[c.sameSite.toLowerCase()] ?? "Lax") : "Lax",
    }));
}

/**
 * Discover the candidate `voyagerSearchDashClusters.<hash>` queryIds by loading
 * people-search headlessly and grepping the large query-manifest chunk(s).
 */
async function discoverCandidates(cookieJar: unknown): Promise<string[]> {
  const { chromium } = await import("playwright");
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  const browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
    args: ["--no-sandbox", "--disable-blink-features=AutomationControlled"],
  });
  const chunks = new Map<string, number>(); // url -> content-length
  try {
    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      viewport: { width: 1366, height: 900 },
    });
    await context.addCookies(
      jarToPlaywrightCookies(cookieJar) as unknown as Parameters<typeof context.addCookies>[0]
    );
    const page = await context.newPage();
    page.on("response", (res) => {
      const u = res.url();
      if (/static\.licdn\.com\/aero-v1\//.test(u)) {
        const len = parseInt(res.headers()["content-length"] ?? "0", 10);
        if (!chunks.has(u) || len > (chunks.get(u) ?? 0)) chunks.set(u, len);
      }
    });
    try {
      await page.goto(SEARCH_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
    } catch {
      /* initial nav timeout is fine — chunks may still have loaded */
    }
    const deadline = Date.now() + CAPTURE_TIMEOUT_MS;
    while (
      Date.now() < deadline &&
      [...chunks.values()].filter((s) => s >= MIN_CHUNK_BYTES).length === 0
    ) {
      await page.waitForTimeout(1000);
    }
  } finally {
    await browser.close().catch(() => {});
  }

  // Fetch the biggest chunks (public CDN, no auth) and grep for candidates.
  const bySizeDesc = [...chunks.entries()].sort((a, b) => b[1] - a[1]).map(([u]) => u);
  const candidates = new Set<string>();
  let fetches = 0;
  for (const url of bySizeDesc) {
    if (fetches >= MAX_CHUNK_FETCHES) break;
    fetches += 1;
    try {
      const text = await (await fetch(url)).text();
      for (const m of text.matchAll(HASH_RX)) candidates.add(m[0]);
    } catch {
      /* skip unreachable chunk */
    }
    if (candidates.size > 0) break; // found the manifest
  }
  return [...candidates];
}

/**
 * Capture the live people-SRP queryId: discover candidates from the bundle, then
 * probe each against the API and return the people variant. Returns null if it
 * can't be determined (e.g. cookies expired, bundle layout changed).
 */
export async function captureSearchClustersQueryId(
  cookieJar: unknown,
  apiClient: LinkedInApiClient
): Promise<string | null> {
  output.info("Discovering flagship people-search queryId (headless, one-time)...");
  let candidates: string[];
  try {
    candidates = await discoverCandidates(cookieJar);
  } catch (err) {
    output.debug(`queryId discovery failed: ${String((err as Error).message)}`);
    return null;
  }
  if (candidates.length === 0) {
    output.info("Could not find any SearchDashClusters queryId in the bundle.");
    return null;
  }
  output.debug(`queryId candidates: ${candidates.join(", ")}`);
  for (const candidate of candidates) {
    if (await isPeopleSearchClustersQueryId(apiClient, candidate)) {
      output.success(`Resolved people-search queryId: ${candidate}`);
      return candidate;
    }
  }
  output.info("None of the candidate queryIds matched the people-search shape.");
  return null;
}
