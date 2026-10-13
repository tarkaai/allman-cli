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
import {
  hasFilters,
  type LeadSearchFilters,
  mergeFilters,
  nextSliceLevel,
  SLICE_PLANS,
} from "../utils/salesnav-filters.js";
import { isUrn, profileUrnId } from "../utils/urn.js";

const SALESNAV_PAGE_SIZE = 25;
const FLAGSHIP_PAGE_SIZE = 10;
/**
 * A single SalesNav search returns at most 1,000 results: pages past
 * start=1000 come back empty even when `paging.total` is larger (verified
 * live against a 3,611-connection network). `--slice` partitions the search
 * by region and seniority to get past it. Flagship caps at ~1,000 too.
 */
const SALESNAV_SAFETY_MAX = 1_000;
const FLAGSHIP_SAFETY_MAX = 1_000;
/** A count=1 request is a cheap way to read a slice's `paging.total`. */
const PROBE_COUNT = 1;

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
  /**
   * Extra SalesNav facets (REGION / SENIORITY_LEVEL) applied to every page.
   * SalesNav-only: the flagship backend has no such facets.
   */
  filters?: LeadSearchFilters | null;
  /**
   * Partition the search by region, then seniority, so that every slice fits
   * under the 1,000-result cap, and merge the slices. SalesNav-only.
   */
  slice?: boolean;
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
  // Populated by the SalesNav backend, whose search hits arrive decorated.
  // The flagship backend leaves these null.
  firstName?: string | null;
  lastName?: string | null;
  fullName?: string | null;
  location?: string | null;
  degree?: number | null;
  headline?: string | null;
  title?: string | null;
  company?: string | null;
  companyUrn?: string | null;
  companyIndustry?: string | null;
  profilePictureUrl?: string | null;
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

  // Facets and slicing exist only on the SalesNav lead search; the flagship
  // people search has no REGION/SENIORITY facets, so refuse rather than
  // silently return an unfiltered list.
  const salesnavOnly = hasFilters(opts.filters) || opts.slice === true;
  const salesnavOnlyWhy = hasFilters(opts.filters)
    ? "--region/--seniority/--relationship filters"
    : "--slice";
  const refuseFlagship = (why: string) =>
    output.error(
      `${salesnavOnlyWhy} need the Sales Navigator backend (${why}). ` +
        "Re-run `allman login` to capture a seat, or drop the flags.",
      1
    );

  if (opts.flagship) {
    // Forced flagship — never touches SalesNav, never falls back.
    if (salesnavOnly) {
      refuseFlagship("--flagship was given");
      return;
    }
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
      !salesnavOnly
    );
    if (r === FALLBACK) {
      output.info("SalesNav seat unavailable — falling back to flagship.");
      const f = await flagship();
      if (f) result = { ...f, backend: "flagship" };
    } else if (r) {
      result = { ...r, backend: "salesnav" };
    }
  } else if (salesnavOnly) {
    refuseFlagship("this session has no SalesNav seat");
    return;
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
  const base = hasFilters(opts.filters) ? (opts.filters as LeadSearchFilters) : undefined;
  const search: SalesnavSearch = { client, salesnavId, slug, opts, delayConfig };

  // A limit at or under the cap never needs slicing — one search covers it.
  if (opts.slice && (opts.limit === undefined || opts.limit > SALESNAV_SAFETY_MAX)) {
    return runSalesnavSliced(search, base, allowFallback);
  }

  output.info(
    `Searching SalesNav for connections of "${slug}" (limit ${limit}${base ? ", filtered" : ""})...`
  );
  const r = await pullSalesnavPages(search, {
    filters: base,
    limit,
    allowFallback,
    abortOnEmptyFirstPage: true,
    label: null,
  });
  if (r === FALLBACK || r === null) return r;
  if (r.total !== null && r.total > r.rows.length && r.rows.length >= SALESNAV_SAFETY_MAX) {
    output.warn(
      `Sales Navigator reports ${r.total} results but a single search returns at most ` +
        `${SALESNAV_SAFETY_MAX}. Re-run with --slice to fetch the rest.`
    );
  }
  return r;
}

/** Everything a SalesNav page or probe request needs, bundled once per run. */
interface SalesnavSearch {
  client: Parameters<typeof leadSearchConnectionOf>[0];
  salesnavId: string;
  slug: string;
  opts: ConnectionsOfOptions;
  delayConfig: RandomDelayConfig;
}

interface PullOptions {
  filters: LeadSearchFilters | undefined;
  limit: number;
  /** Only the very first request of a run may trigger the flagship fallback. */
  allowFallback: boolean;
  /** Treat an empty first page as "network not visible" and abort. Off for slices. */
  abortOnEmptyFirstPage: boolean;
  /** Slice name for log lines, or null for an unsliced run. */
  label: string | null;
}

/** Paginate one CONNECTION_OF search (optionally filtered) up to `limit` rows. */
async function pullSalesnavPages(search: SalesnavSearch, pull: PullOptions): Promise<SalesnavRun> {
  const { client, salesnavId, slug, opts, delayConfig } = search;
  const prefix = pull.label ? `  [${pull.label}]` : " ";
  const rows: ResultRow[] = [];
  let start = 0;
  let pageNum = 0;
  let serverTotal: number | null = null;
  while (rows.length < pull.limit) {
    pageNum += 1;
    let page: Awaited<ReturnType<typeof leadSearchConnectionOf>>;
    try {
      page = await leadSearchConnectionOf(client, {
        salesnavId,
        start,
        count: SALESNAV_PAGE_SIZE,
        ...(pull.filters ? { filters: pull.filters } : {}),
      });
    } catch (err) {
      // A first-page failure (e.g. seat expired) in auto mode → fall back.
      if (pull.allowFallback && pageNum === 1) return FALLBACK;
      output.error(
        `Page ${pageNum} failed: ${(err as Error).message}. ` +
          "If this is a 403, re-run `allman login` to refresh the SalesNav seat.",
        1
      );
      return null;
    }
    if (serverTotal === null) serverTotal = page.total;
    for (const lead of page.leads) rows.push(leadToRow(lead));
    output.info(
      `${prefix} page ${pageNum}: +${page.leads.length} (total ${rows.length}${serverTotal !== null ? ` / ${serverTotal}` : ""})${page.isLastPage ? " [last]" : ""}`
    );
    if (pull.abortOnEmptyFirstPage && pageNum === 1 && page.leads.length === 0) {
      output.error(
        `Search returned 0 results for "${slug}" — they may not be in your network, ` +
          "or you are not connected to them. Aborting before further requests.",
        1
      );
      return null;
    }
    if (page.isLastPage || page.leads.length === 0 || rows.length >= pull.limit) break;
    start += page.leads.length;
    if (!opts.noDelay) await randomPageSleep(delayConfig);
  }
  return { rows: rows.slice(0, pull.limit), total: serverTotal };
}

function leadToRow(
  lead: Awaited<ReturnType<typeof leadSearchConnectionOf>>["leads"][number]
): ResultRow {
  return {
    salesnavId: lead.salesnavId,
    memberId: lead.memberId || null,
    memberUrn: lead.memberUrn || null,
    publicIdentifier: null,
    firstName: lead.firstName,
    lastName: lead.lastName,
    fullName: lead.fullName,
    location: lead.location,
    degree: lead.degree,
    title: lead.title,
    company: lead.company,
    companyUrn: lead.companyUrn,
    companyIndustry: lead.companyIndustry,
    profilePictureUrl: lead.profilePictureUrl,
  };
}

/**
 * Read a (filtered) search's server total with a count=1 request.
 * Returns FALLBACK only when `allowFallback` is set and the request fails.
 */
async function probeSalesnavTotal(
  search: SalesnavSearch,
  filters: LeadSearchFilters | undefined,
  allowFallback: boolean
): Promise<number | null | typeof FALLBACK> {
  try {
    const page = await leadSearchConnectionOf(search.client, {
      salesnavId: search.salesnavId,
      start: 0,
      count: PROBE_COUNT,
      ...(filters ? { filters } : {}),
    });
    // A server that omits `total` still tells us something: no leads means 0.
    return page.total ?? (page.leads.length === 0 ? 0 : null);
  } catch (err) {
    if (allowFallback) return FALLBACK;
    output.error(
      `Probe failed: ${(err as Error).message}. ` +
        "If this is a 403, re-run `allman login` to refresh the SalesNav seat.",
      1
    );
    return null;
  }
}

/** Probes are tiny requests; pace them at half the page delay. */
function probeDelay(delayConfig: RandomDelayConfig): RandomDelayConfig {
  return { minMs: Math.floor(delayConfig.minMs / 2), maxMs: Math.floor(delayConfig.maxMs / 2) };
}

/**
 * `--slice`: probe the unfiltered total; when it exceeds the cap, walk
 * SLICE_PLANS (region, then seniority) so every pulled slice fits under it,
 * and merge the slices by salesnavId. Explicit filters form the base of every
 * slice, and a plan whose facet the base already includes is skipped (its
 * INCLUDED ids would OR with the base and widen the search instead of
 * partitioning it). Slices overlap a little on LinkedIn's side and the
 * unfiltered total undercounts, so the merged count can exceed the reported
 * total.
 */
async function runSalesnavSliced(
  search: SalesnavSearch,
  base: LeadSearchFilters | undefined,
  allowFallback: boolean
): Promise<SalesnavRun> {
  const { slug, opts, delayConfig } = search;
  output.info(`Probing SalesNav total for connections of "${slug}"${base ? " (filtered)" : ""}...`);
  const total = await probeSalesnavTotal(search, base, allowFallback);
  if (total === FALLBACK) return FALLBACK;
  if (total === null) {
    output.warn("Sales Navigator did not report a total — running a single unsliced search.");
  } else if (total <= SALESNAV_SAFETY_MAX) {
    output.info(
      `${total} results fit under the ${SALESNAV_SAFETY_MAX}-result cap — no slicing needed.`
    );
  }
  if (total === null || total <= SALESNAV_SAFETY_MAX) {
    if (!opts.noDelay) await randomPageSleep(probeDelay(delayConfig));
    return pullSalesnavPages(search, {
      filters: base,
      limit: SALESNAV_SAFETY_MAX,
      allowFallback: false,
      abortOnEmptyFirstPage: true,
      label: null,
    });
  }

  output.info(
    `${total} results exceed the ${SALESNAV_SAFETY_MAX}-result cap — slicing by region, then seniority.`
  );
  const merged = new Map<string, ResultRow>();

  /** Pull one slice up to the cap and fold it into `merged`. */
  const pullSlice = async (
    sliceFilters: LeadSearchFilters | undefined,
    label: string,
    t: number
  ): Promise<boolean> => {
    if (t > SALESNAV_SAFETY_MAX) {
      output.warn(
        `  slice ${label}: ${t} exceeds the ${SALESNAV_SAFETY_MAX}-result cap at the deepest ` +
          `split — only the first ${SALESNAV_SAFETY_MAX} will be fetched.`
      );
    }
    if (!opts.noDelay) await randomPageSleep(probeDelay(delayConfig));
    const r = await pullSalesnavPages(search, {
      filters: sliceFilters,
      limit: SALESNAV_SAFETY_MAX,
      allowFallback: false,
      abortOnEmptyFirstPage: false,
      label,
    });
    if (r === FALLBACK || r === null) return false;
    for (const row of r.rows) {
      if (row.salesnavId && !merged.has(row.salesnavId)) merged.set(row.salesnavId, row);
    }
    output.info(`  slice ${label}: ${r.rows.length} / ${t} (merged ${merged.size})`);
    return true;
  };

  const walk = async (
    filters: LeadSearchFilters | undefined,
    level: number,
    parentLabel: string | null,
    knownTotal: number
  ): Promise<boolean> => {
    const lvl = nextSliceLevel(filters, level);
    const plan = lvl >= 0 ? SLICE_PLANS[lvl] : undefined;
    if (!plan) {
      // Every facet is already pinned by the filters: nothing left to split on.
      return pullSlice(filters, parentLabel ?? "base", knownTotal);
    }
    for (const entry of plan) {
      const label = parentLabel ? `${parentLabel}/${entry.label}` : entry.label;
      const sliceFilters = mergeFilters(filters, entry.filters);
      if (!opts.noDelay) await randomPageSleep(probeDelay(delayConfig));
      const probed = await probeSalesnavTotal(search, sliceFilters, false);
      if (probed === FALLBACK) return false;
      // An unreported total is treated as "fits": pull up to the cap and move on.
      const t = probed ?? 0;
      if (probed === null)
        output.warn(`  slice ${label}: total not reported — pulling up to the cap`);
      else if (t === 0) {
        output.info(`  slice ${label}: 0 — skipped`);
        continue;
      }
      if (t > SALESNAV_SAFETY_MAX && nextSliceLevel(sliceFilters, lvl + 1) >= 0) {
        output.info(`  slice ${label}: ${t} — over the cap, splitting`);
        if (!(await walk(sliceFilters, lvl + 1, label, t))) return false;
        continue;
      }
      if (!(await pullSlice(sliceFilters, label, t))) return false;
    }
    return true;
  };

  if (!(await walk(base, 0, null, total))) return null;

  const rows = [...merged.values()];
  output.info(`Merged ${rows.length} unique results across slices (server total ${total}).`);
  const limit = opts.limit ?? rows.length;
  return { rows: rows.slice(0, limit), total };
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
        fullName: hit.name,
        headline: hit.headline,
        location: hit.location,
        profilePictureUrl: hit.profilePictureUrl,
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
          firstName: r.firstName ?? null,
          headline: r.headline ?? null,
          lastName: r.lastName ?? null,
          fullName: r.fullName ?? null,
          location: r.location ?? null,
          degree: r.degree ?? null,
          title: r.title ?? null,
          company: r.company ?? null,
          companyUrn: r.companyUrn ?? null,
          companyIndustry: r.companyIndustry ?? null,
          profilePictureUrl: r.profilePictureUrl ?? null,
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
