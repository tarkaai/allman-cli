/**
 * `allman connections-of <slug>` — list the 1st-degree connections of <slug>.
 *
 * Input is always a flagship slug (or profile URL/URN). We resolve it to a
 * flagship id, then enumerate that person's network via one of two backends:
 *
 *   SalesNav (default): resolve flagship id -> salesnav id, then paginate
 *     salesApiLeadSearch with CONNECTION_OF + RELATIONSHIP:S. Requires the seat
 *     cookies captured by `allman login` (REST-only at call time, no handshake).
 *     Less restricted, returns salesnav id + numeric member id.
 *
 *   Flagship (--flagship): paginate voyagerSearchDashClusters people search with
 *     connectionOf=<flagshipId> + network=[S]. Returns flagship id + slug. Needs
 *     a live queryId hash (ALLMAN_SEARCH_CLUSTERS_QID or a baked default).
 *
 * Either way we fetch only IDs — never the target's or results' profile pages.
 */

import { writeFile } from "node:fs/promises";
import { searchPeopleConnectionOf } from "../linkedin/api/endpoints/people-search.js";
import { getProfileUrnBySlug } from "../linkedin/api/endpoints/profiles.js";
import {
  leadSearchConnectionOf,
  resolveSalesnavIdFromFlagshipId,
} from "../linkedin/api/endpoints/salesnav.js";
import { resolveSearchClustersQueryId } from "../linkedin/api/flagship-queryid.js";
import { loadSession } from "../linkedin/api/session.js";
import { ConnectionsStore, resolveStorePath, Store } from "../store/index.js";
import { csvLines } from "../utils/csv.js";
import * as output from "../utils/output.js";
import {
  DEFAULT_PAGE_DELAY,
  type RandomDelayConfig,
  randomPageSleep,
} from "../utils/random-delay.js";
import { isUrn, profileUrnId } from "../utils/urn.js";

const SALESNAV_PAGE_SIZE = 25;
const FLAGSHIP_PAGE_SIZE = 10;
/** SalesNav caps a search at ~2,500 results; flagship at ~1,000. */
const SALESNAV_SAFETY_MAX = 2_500;
const FLAGSHIP_SAFETY_MAX = 1_000;

export interface ConnectionsOfOptions {
  account?: string;
  store?: string;
  /** Stream NDJSON to stdout (ephemeral — does not write to the store). */
  json?: boolean;
  /** Also export a CSV to this path (in addition to storing). */
  csv?: string;
  /** Skip writing into the git-versioned store. */
  noStore?: boolean;
  limit?: number;
  /** Force the flagship people-search backend (no fallback). */
  flagship?: boolean;
  /** Force the SalesNav backend (no fallback; errors if no seat). */
  salesnav?: boolean;
  /** For tests: skip the inter-page delay. */
  noDelay?: boolean;
  delayConfig?: RandomDelayConfig;
}

/** A normalized result row, backend-agnostic at the output layer. */
interface ResultRow {
  salesnavId: string | null;
  memberId: string | null;
  memberUrn: string | null;
  publicIdentifier: string | null;
}

/** A completed run: the rows plus the server total and which backend produced them. */
interface BackendResult {
  rows: ResultRow[];
  total: number | null;
  backend: "salesnav" | "flagship";
}

/** Returned by the SalesNav runner to signal "no seat — caller should fall back". */
const FALLBACK = Symbol("fallback-to-flagship");
type RunOutput = { rows: ResultRow[]; total: number | null } | null;
type SalesnavRun = RunOutput | typeof FALLBACK;

export async function connectionsOfCommand(
  input: string,
  opts: ConnectionsOfOptions
): Promise<void> {
  const storePath = resolveStorePath(opts.store);
  const store = new Store({ path: storePath });
  await store.init();

  let session: Awaited<ReturnType<typeof loadSession>>;
  try {
    session = await loadSession(store, opts.account);
  } catch (err) {
    output.error(String((err as Error).message), 1);
    return;
  }

  // Resolve the slug to a flagship profile id (one voyager call; not a profile-page hit).
  const slug = normalizeSlugInput(input);
  if (!slug) {
    output.error(
      `Could not interpret "${input}" as a LinkedIn slug. Pass a slug like \`example-user-1\` or a profile URL.`,
      1
    );
    return;
  }
  output.info(`Resolving slug "${slug}"...`);
  const profileUrn = await getProfileUrnBySlug(session.apiClient, slug);
  if (!profileUrn) {
    output.error(`Slug "${slug}" did not resolve to a LinkedIn profile.`, 1);
    return;
  }
  const flagshipProfileId = profileUrnId(profileUrn);

  const delayConfig = opts.delayConfig ?? DEFAULT_PAGE_DELAY;
  const flagship = () => runFlagship(session, store, flagshipProfileId, slug, opts, delayConfig);
  let result: BackendResult | null = null;

  if (opts.flagship) {
    // Forced flagship — never touches SalesNav, never falls back.
    const r = await flagship();
    if (r) result = { ...r, backend: "flagship" };
  } else if (opts.salesnav) {
    // Forced SalesNav — error (no fallback) if the seat is missing.
    const r = await runSalesnav(
      session.apiClient,
      flagshipProfileId,
      slug,
      opts,
      delayConfig,
      false
    );
    if (r && r !== FALLBACK) result = { ...r, backend: "salesnav" };
  } else if (hasSalesNavSeat(session.accountRecord.cookieJar)) {
    // Auto + seat: SalesNav, falling back to flagship if it can't run.
    const r = await runSalesnav(
      session.apiClient,
      flagshipProfileId,
      slug,
      opts,
      delayConfig,
      true
    );
    if (r === FALLBACK) {
      output.info("SalesNav seat unavailable — falling back to flagship.");
      const f = await flagship();
      if (f) result = { ...f, backend: "flagship" };
    } else if (r) {
      result = { ...r, backend: "salesnav" };
    }
  } else {
    // Auto + no seat: flagship.
    output.info("No SalesNav seat in this session — using flagship search.");
    const f = await flagship();
    if (f) result = { ...f, backend: "flagship" };
  }

  if (result === null) return; // a runner already emitted an error + exited

  await emit(
    result,
    { store, profileId: session.profileId, targetUrn: profileUrn, targetSlug: slug },
    opts
  );
}

// ---------------------------------------------------------------------------
// SalesNav backend (default)
// ---------------------------------------------------------------------------

async function runSalesnav(
  client: Parameters<typeof leadSearchConnectionOf>[0],
  flagshipProfileId: string,
  slug: string,
  opts: ConnectionsOfOptions,
  delayConfig: RandomDelayConfig,
  allowFallback: boolean
): Promise<SalesnavRun> {
  output.info("Resolving Sales Navigator id...");
  let salesnavId: string | null;
  try {
    salesnavId = await resolveSalesnavIdFromFlagshipId(client, flagshipProfileId);
  } catch (err) {
    if (allowFallback) return FALLBACK;
    output.error(`Sales Navigator lookup failed: ${(err as Error).message}`, 1);
    return null;
  }
  if (!salesnavId) {
    // No seat (or the person isn't resolvable via SalesNav).
    if (allowFallback) return FALLBACK;
    output.error(
      `Could not resolve "${slug}" to a Sales Navigator id.\n` +
        "  This usually means your session has no SalesNav seat. Re-run `allman login`\n" +
        "  (it captures the seat automatically), or retry with --flagship.",
      1
    );
    return null;
  }

  const limit = Math.min(opts.limit ?? SALESNAV_SAFETY_MAX, SALESNAV_SAFETY_MAX);
  output.info(`Searching SalesNav for connections of "${slug}" (limit ${limit})...`);

  const rows: ResultRow[] = [];
  let start = 0;
  let pageNum = 0;
  let serverTotal: number | null = null;
  while (rows.length < limit) {
    pageNum += 1;
    let page: Awaited<ReturnType<typeof leadSearchConnectionOf>>;
    try {
      page = await leadSearchConnectionOf(client, {
        salesnavId,
        start,
        count: SALESNAV_PAGE_SIZE,
      });
    } catch (err) {
      // A first-page failure (e.g. seat expired) in auto mode → fall back.
      if (allowFallback && pageNum === 1) return FALLBACK;
      output.error(
        `Page ${pageNum} failed: ${(err as Error).message}. ` +
          "If this is a 403, re-run `allman login` to refresh the SalesNav seat.",
        1
      );
      return null;
    }
    if (serverTotal === null) serverTotal = page.total;
    for (const lead of page.leads) {
      rows.push({
        salesnavId: lead.salesnavId,
        memberId: lead.memberId || null,
        memberUrn: lead.memberUrn || null,
        publicIdentifier: null,
      });
    }
    output.info(
      `  page ${pageNum}: +${page.leads.length} (total ${rows.length}${serverTotal !== null ? ` / ${serverTotal}` : ""})${page.isLastPage ? " [last]" : ""}`
    );
    if (pageNum === 1 && page.leads.length === 0) {
      output.error(
        `Search returned 0 results for "${slug}" — they may not be in your network, ` +
          "or you are not connected to them. Aborting before further requests.",
        1
      );
      return null;
    }
    if (page.isLastPage || rows.length >= limit) break;
    start += page.leads.length;
    if (!opts.noDelay) await randomPageSleep(delayConfig);
  }
  return { rows: rows.slice(0, limit), total: serverTotal };
}

// ---------------------------------------------------------------------------
// Flagship backend (--flagship)
// ---------------------------------------------------------------------------

async function runFlagship(
  session: Awaited<ReturnType<typeof loadSession>>,
  store: Store,
  flagshipProfileId: string,
  slug: string,
  opts: ConnectionsOfOptions,
  delayConfig: RandomDelayConfig
): Promise<RunOutput> {
  const client = session.apiClient;
  output.info("Resolving flagship people-search queryId...");
  let queryId = await resolveSearchClustersQueryId({
    accounts: store.accounts,
    profileId: session.profileId,
    cookieJar: session.accountRecord.cookieJar,
    apiClient: client,
  });
  if (!queryId) {
    output.error(
      "Could not determine the flagship people-search queryId (capture failed). " +
        "Re-run `allman login`, set ALLMAN_SEARCH_CLUSTERS_QID, or use the default SalesNav backend.",
      1
    );
    return null;
  }

  const limit = Math.min(opts.limit ?? FLAGSHIP_SAFETY_MAX, FLAGSHIP_SAFETY_MAX);
  output.info(`Searching flagship for connections of "${slug}" (limit ${limit})...`);

  const rows: ResultRow[] = [];
  let start = 0;
  let pageNum = 0;
  let serverTotal: number | null = null;
  let requeried = false;
  while (rows.length < limit) {
    pageNum += 1;
    let page: Awaited<ReturnType<typeof searchPeopleConnectionOf>>;
    try {
      page = await searchPeopleConnectionOf(client, {
        queryId,
        flagshipProfileId,
        start,
        count: FLAGSHIP_PAGE_SIZE,
      });
    } catch (err) {
      // A stale (rotated) queryId returns 400 — force a fresh headless capture
      // once and retry the same page before giving up.
      if (!requeried && isBadRequest(err)) {
        requeried = true;
        pageNum -= 1;
        output.info("queryId looks stale (400) — re-capturing...");
        const fresh = await resolveSearchClustersQueryId({
          accounts: store.accounts,
          profileId: session.profileId,
          cookieJar: session.accountRecord.cookieJar,
          apiClient: client,
          force: true,
        });
        if (fresh) {
          queryId = fresh;
          continue;
        }
      }
      output.error(`Page ${pageNum} failed: ${(err as Error).message}`, 1);
      return null;
    }
    if (serverTotal === null) serverTotal = page.total;
    for (const hit of page.hits) {
      rows.push({
        salesnavId: null,
        memberId: hit.memberId,
        memberUrn: hit.memberUrn,
        publicIdentifier: hit.publicIdentifier,
      });
    }
    output.info(
      `  page ${pageNum}: +${page.hits.length} (total ${rows.length}${serverTotal !== null ? ` / ${serverTotal}` : ""})${page.isLastPage ? " [last]" : ""}`
    );
    if (pageNum === 1 && page.hits.length === 0) {
      output.error(
        `Search returned 0 results for "${slug}" — you may not be a 1st-degree ` +
          "connection of this person, so LinkedIn does not expose their network. Aborting.",
        1
      );
      return null;
    }
    if (page.isLastPage || rows.length >= limit) break;
    start += page.hits.length;
    if (!opts.noDelay) await randomPageSleep(delayConfig);
  }
  return { rows: rows.slice(0, limit), total: serverTotal };
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

interface EmitContext {
  store: Store;
  profileId: string;
  targetUrn: string;
  targetSlug: string;
}

async function emit(
  result: BackendResult,
  ctx: EmitContext,
  opts: ConnectionsOfOptions
): Promise<void> {
  const { rows, total, backend } = result;

  // --json: ephemeral stream to stdout, no store write.
  if (opts.json) {
    for (const r of rows) output.emitEvent({ ...r, backend });
    output.success(`Emitted ${rows.length} results as NDJSON (backend: ${backend}).`);
    return;
  }

  // Default: write into the git-versioned store under connections-of/{target}/.
  if (!opts.noStore) {
    const nowIso = new Date().toISOString();
    const cstore = ctx.store.connectionsFor(ctx.profileId);
    const targetKey = ConnectionsStore.targetKeyFromUrn(ctx.targetUrn);
    await cstore.writeConnectionOfTarget(targetKey, {
      targetSlug: ctx.targetSlug,
      targetUrn: ctx.targetUrn,
      backend,
      total,
      fetched: rows.length,
      capturedAt: nowIso,
    });
    for (const r of rows) {
      await cstore.upsertConnectionOfResult(
        targetKey,
        {
          salesnavId: r.salesnavId,
          memberId: r.memberId,
          memberUrn: r.memberUrn,
          publicIdentifier: r.publicIdentifier,
        },
        nowIso
      );
    }
    cstore.git.scheduleCommit(`connections-of ${ctx.targetSlug}: ${rows.length} (${backend})`);
    await ctx.store.git.flush();
    output.success(
      `Stored ${rows.length} results in ${ctx.store.path}/${ctx.profileId}/connections-of/${targetKey} (backend: ${backend})`
    );
  }

  // --csv: additional CSV export.
  if (opts.csv) {
    const header = ["salesnav_id", "member_id", "member_urn", "public_identifier"];
    const csvRows = [
      header,
      ...rows.map((r) => [r.salesnavId, r.memberId, r.memberUrn, r.publicIdentifier]),
    ];
    await writeFile(opts.csv, `${csvLines(csvRows)}\r\n`, "utf8");
    output.success(`Exported ${rows.length} results to ${opts.csv}`);
  }

  if (opts.noStore && !opts.csv) {
    output.success(`Fetched ${rows.length} results (not stored — pass --csv or drop --no-store).`);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Accept any of these and return a clean slug:
 *   "example-user-1" | "/in/example-user-1" | "https://www.linkedin.com/in/example-user-1/"
 * Returns null for empty or URN-style inputs (this command is slug-only).
 */
export function normalizeSlugInput(raw: string): string | null {
  const v = raw.trim().replace(/\/+$/, "");
  if (!v) return null;
  if (isUrn(v)) return null;
  const m = /linkedin\.com\/in\/([^/?#]+)/i.exec(v);
  if (m?.[1]) return m[1].toLowerCase();
  if (v.startsWith("/in/")) return v.slice(4).toLowerCase();
  if (/^[A-Za-z0-9_-]+$/.test(v)) return v.toLowerCase();
  return null;
}

/**
 * Whether the session carries an active Sales Navigator seat. The seat is the
 * `li_a` cookie that `allman login` captures by visiting /sales/; its absence
 * means SalesNav isn't available, so the auto path uses flagship instead.
 */
export function hasSalesNavSeat(cookieJar: unknown): boolean {
  const cookies =
    (cookieJar as { cookies?: Array<{ key?: string; expires?: string }> } | null)?.cookies ?? [];
  const now = Date.now();
  return cookies.some(
    (c) =>
      c.key === "li_a" &&
      (!c.expires || c.expires === "Infinity" || new Date(c.expires).getTime() > now)
  );
}

/** True when an error looks like an HTTP 400 (e.g. a stale/rotated queryId). */
function isBadRequest(err: unknown): boolean {
  const e = err as { statusCode?: number; message?: string };
  return e?.statusCode === 400 || /\bHTTP 400\b|\b400\b/.test(e?.message ?? "");
}
