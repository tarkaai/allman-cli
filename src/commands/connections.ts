/**
 * `allman connections` — export the user's 1st-degree LinkedIn connections.
 *
 * Default output: per-connection records + slug symlinks written into the
 * git-versioned store (idempotent). `--csv <path>` also exports a CSV; `--json`
 * streams NDJSON to stdout without storing; `--no-save` skips the store. We keep
 * the export minimal (ids + slug + name); `--include-headline` adds the headline.
 */

import { writeFile } from "node:fs/promises";
import {
  type ConnectionRecord,
  listConnectionsPage,
} from "../linkedin/api/endpoints/connections.js";
import {
  leadSearchOwnConnections,
  type OwnConnectionsPage,
  type SalesnavConnection,
} from "../linkedin/api/endpoints/salesnav.js";
import { loadSession } from "../linkedin/api/session.js";
import { resolveStorePath, Store } from "../store/index.js";
import { csvLines } from "../utils/csv.js";
import * as output from "../utils/output.js";
import {
  DEFAULT_PAGE_DELAY,
  type RandomDelayConfig,
  randomPageSleep,
} from "../utils/random-delay.js";
import { profileUrnId } from "../utils/urn.js";
import { hasSalesNavSeat } from "./connections-of.js";
import { enrichConnections } from "./enrich.js";

const DEFAULT_PAGE_SIZE = 100;
/**
 * Runaway-pagination backstop, not a LinkedIn limit. The flagship connections
 * resource has no depth cap — verified live at `start=8400` on an 8.4k network,
 * where it still returned full pages — so we paginate until the server sets
 * `isLastPage` and keep this only as a safety net. (Contrast Sales Navigator,
 * which hard-refuses `start >= 2500`.) LinkedIn caps accounts at 30k
 * connections, so this ceiling sits comfortably above any real network.
 */
const SAFETY_MAX = 35_000;

export interface ConnectionsOptions {
  account?: string;
  store?: string;
  /** Stream NDJSON to stdout (ephemeral — does not write to the store). */
  json?: boolean;
  /** Also export a CSV to this path (in addition to storing). */
  csv?: string;
  /** Skip writing into the git-versioned store (use with --csv for a pure export). */
  noStore?: boolean;
  limit?: number;
  pageSize?: number;
  includeHeadline?: boolean;
  /** After storing the list, fetch each connection's full profile. */
  enrich?: boolean;
  /** With --enrich: include work history, education, and skills. */
  deep?: boolean;
  /** Force the Sales Navigator backend (errors without a seat). */
  salesnav?: boolean;
  /** Force the flagship backend. */
  flagship?: boolean;
  /** For tests: skip the inter-page delay. */
  noDelay?: boolean;
  delayConfig?: RandomDelayConfig;
}

export async function connectionsCommand(opts: ConnectionsOptions): Promise<void> {
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

  const pageSize = clamp(opts.pageSize ?? DEFAULT_PAGE_SIZE, 1, 500);
  const limit = Math.min(opts.limit ?? SAFETY_MAX, SAFETY_MAX);
  const delayConfig = opts.delayConfig ?? DEFAULT_PAGE_DELAY;

  // Backend selection. Flagship is the default even when a Sales Navigator seat
  // exists, because SalesNav lead search refuses `start >= 2500` (verified: 2400
  // OK, 2500 → HTTP 400). For a network larger than that, defaulting to SalesNav
  // would silently return a fraction of your connections — and it never returns
  // public slugs either. `--salesnav` opts into the richer-but-capped sweep.
  const seat = hasSalesNavSeat(session.accountRecord.cookieJar);
  if (opts.salesnav && !seat) {
    output.error("--salesnav requires a Sales Navigator seat. Re-run `allman login`.", 1);
    return;
  }
  const useSalesnav = opts.salesnav === true;

  if (useSalesnav) {
    await salesnavConnections({
      store,
      session,
      limit,
      pageSize: clamp(opts.pageSize ?? SALESNAV_PAGE_SIZE, 1, 100),
      json: opts.json === true,
      noStore: opts.noStore === true,
      csv: opts.csv,
      noDelay: opts.noDelay === true,
      delayConfig,
    });
    return;
  }

  output.info(`Fetching connections (page size ${pageSize}, limit ${limit})…`);

  const all: ConnectionRecord[] = [];
  let start = 0;
  let pageNum = 0;
  while (all.length < limit) {
    pageNum += 1;
    const want = Math.min(pageSize, limit - all.length);
    let page: Awaited<ReturnType<typeof listConnectionsPage>>;
    try {
      page = await listConnectionsPage(session.apiClient, {
        start,
        count: want,
      });
    } catch (err) {
      output.error(`Page ${pageNum} failed: ${(err as Error).message}`, 1);
      return;
    }
    all.push(...page.records);
    output.info(
      `  page ${pageNum}: +${page.records.length} (running total ${all.length})${page.isLastPage ? " [last]" : ""}`
    );
    if (page.isLastPage || all.length >= limit) break;
    start += page.records.length;
    if (!opts.noDelay) await randomPageSleep(delayConfig);
  }

  if (all.length >= SAFETY_MAX) {
    output.warn(
      `Hit safety cap of ${SAFETY_MAX} connections. If you expected more, raise --limit and re-run.`
    );
  }

  // --json: ephemeral stream to stdout, no store write.
  if (opts.json) {
    for (const r of all) output.emitEvent(serializeRecord(r, opts.includeHeadline === true));
    output.success(`Emitted ${all.length} connections as NDJSON.`);
    return;
  }

  // Default: write into the git-versioned store (per-connection files + slug symlinks).
  if (!opts.noStore) {
    const nowIso = new Date().toISOString();
    const cstore = store.connectionsFor(session.profileId);
    for (const r of all) {
      await cstore.upsertConnection(
        {
          memberUrn: r.memberUrn,
          flagshipId: safeProfileId(r.memberUrn),
          publicIdentifier: r.publicIdentifier,
          firstName: r.firstName,
          lastName: r.lastName,
          headline: opts.includeHeadline ? r.headline : null,
          connectedAt: r.connectedAt !== null ? new Date(r.connectedAt).toISOString() : null,
          profilePictureUrl: r.profilePictureUrl,
          memorialized: r.memorialized,
          source: "connections",
        },
        nowIso
      );
    }
    cstore.git.scheduleCommit(`connections: export ${all.length}`);
    await store.git.flush();
    output.success(
      `Stored ${all.length} connections in ${storePath}/${session.profileId}/connections`
    );

    // --enrich: fetch each connection's full profile in the same pass.
    if (opts.enrich) {
      const depth = opts.deep ? "deep" : "core";
      const ids = all.map((r) => safeProfileId(r.memberUrn)).filter((id) => id.length > 0);
      output.info(`Enriching ${ids.length} profiles (${depth})…`);
      const res = await enrichConnections({
        apiClient: session.apiClient,
        cstore,
        ids,
        depth,
        force: false,
        limit: opts.limit,
        json: false,
        noDelay: opts.noDelay === true,
        delayConfig,
      });
      cstore.git.scheduleCommit(`enrich: ${res.enriched} profiles (${depth})`);
      await store.git.flush();
      output.success(`Enriched ${res.enriched}, skipped ${res.skipped}, ${res.failed} failed.`);
    }
  } else if (opts.enrich) {
    output.warn("--enrich requires storing; ignoring because --no-save/--json was set.");
  }

  // --csv: additional CSV export.
  if (opts.csv) {
    const header = baseColumns.concat(opts.includeHeadline ? ["headline"] : []);
    const rows = [header, ...all.map((r) => recordToRow(r, opts.includeHeadline === true))];
    await writeFile(opts.csv, `${csvLines(rows)}\r\n`, "utf8");
    output.success(`Exported ${all.length} connections to ${opts.csv}`);
  }

  if (opts.noStore && !opts.csv) {
    output.success(
      `Fetched ${all.length} connections (not stored — pass --csv or drop --no-store).`
    );
  }
}

// ---------------------------------------------------------------------------
// Sales Navigator backend
// ---------------------------------------------------------------------------

/** SalesNav lead search caps a page at 100. */
const SALESNAV_PAGE_SIZE = 100;
/**
 * Hard pagination wall: SalesNav rejects `start >= 2500` with HTTP 400
 * (verified live — start=2400 returns a full page, start=2500 errors). This is
 * a ceiling on the *result set*, not a page count, so a bigger page size buys
 * nothing past it. Networks larger than this cannot be fully enumerated here —
 * that's what the flagship backend is for.
 */
const SALESNAV_MAX = 2500;

interface SalesnavSweepParams {
  store: Store;
  session: Awaited<ReturnType<typeof loadSession>>;
  limit: number;
  pageSize: number;
  json: boolean;
  noStore: boolean;
  csv?: string;
  noDelay: boolean;
  delayConfig: RandomDelayConfig;
}

/**
 * Pull your 1st-degree connections through Sales Navigator.
 *
 * One sweep yields name, location, current title/company and about — the same
 * fields the flagship path needs a separate 2-request enrichment for — so there
 * is no `--enrich` step here; the records land already enriched.
 */
async function salesnavConnections(p: SalesnavSweepParams): Promise<void> {
  const { store, session, json, noStore, delayConfig } = p;
  const cap = Math.min(p.limit, SALESNAV_MAX);
  output.info(`Fetching connections via Sales Navigator (page size ${p.pageSize}, limit ${cap})…`);

  const all: SalesnavConnection[] = [];
  let start = 0;
  let pageNum = 0;
  let reportedTotal: number | null = null;

  while (all.length < cap) {
    pageNum += 1;
    const want = Math.min(p.pageSize, cap - all.length);
    let page: OwnConnectionsPage;
    try {
      page = await leadSearchOwnConnections(session.apiClient, { start, count: want });
    } catch (err) {
      output.error(`Page ${pageNum} failed: ${(err as Error).message}`, 1);
      return;
    }
    reportedTotal = page.total ?? reportedTotal;
    all.push(...page.connections);
    output.info(
      `  page ${pageNum}: +${page.connections.length} (running total ${all.length}${
        reportedTotal !== null ? ` of ${reportedTotal}` : ""
      })${page.isLastPage ? " [last]" : ""}`
    );
    if (page.isLastPage || all.length >= cap) break;
    start += page.connections.length;
    if (!p.noDelay) await randomPageSleep(delayConfig);
  }

  if (reportedTotal !== null && reportedTotal > SALESNAV_MAX) {
    output.warn(
      `Sales Navigator reports ${reportedTotal} connections but refuses to paginate past ${SALESNAV_MAX}, ` +
        `so ${reportedTotal - SALESNAV_MAX} of them are unreachable here. ` +
        "Run `allman connections` (flagship) for the complete list."
    );
  }

  if (json) {
    for (const c of all) output.emitEvent({ ...c });
    output.success(`Emitted ${all.length} connections as NDJSON.`);
    return;
  }

  if (!noStore) {
    const nowIso = new Date().toISOString();
    const cstore = store.connectionsFor(session.profileId);
    for (const c of all) {
      await cstore.upsertSalesnavConnection(
        {
          salesnavId: c.salesnavId,
          memberId: c.memberId,
          memberUrn: c.memberUrn,
          firstName: c.firstName,
          lastName: c.lastName,
          fullName: c.fullName,
          location: c.location,
          degree: c.degree,
          title: c.title,
          company: c.company,
          companyUrn: c.companyUrn,
          companyIndustry: c.companyIndustry,
          companyLocation: c.companyLocation,
          about: c.about,
          pendingInvitation: c.pendingInvitation,
          premium: c.premium,
          openLink: c.openLink,
          memorialized: c.memorialized,
          saved: c.saved,
          viewed: c.viewed,
          profilePictureUrl: c.profilePictureUrl,
          currentPositions: c.currentPositions,
          pastPositions: c.pastPositions,
          spotlights: c.spotlights,
        },
        nowIso
      );
    }
    cstore.git.scheduleCommit(`connections: salesnav export ${all.length}`);
    await store.git.flush();
    output.success(
      `Stored ${all.length} connections in ${store.path}/${session.profileId}/connections-salesnav`
    );
    output.info(
      "These records already include title, company, location and about — no `enrich` needed."
    );
  }

  if (p.csv) {
    const header = [
      "member_id",
      "salesnav_id",
      "first_name",
      "last_name",
      "title",
      "company",
      "location",
      "degree",
      "pending_invitation",
    ];
    const rows = [
      header,
      ...all.map((c) => [
        c.memberId,
        c.salesnavId,
        c.firstName,
        c.lastName,
        c.title,
        c.company,
        c.location,
        c.degree,
        String(c.pendingInvitation),
      ]),
    ];
    await writeFile(p.csv, `${csvLines(rows)}\r\n`, "utf8");
    output.success(`Exported ${all.length} connections to ${p.csv}`);
  }
}

const baseColumns = [
  "member_id",
  "member_urn",
  "public_identifier",
  "first_name",
  "last_name",
  "connected_at_iso",
];

function recordToRow(r: ConnectionRecord, includeHeadline: boolean): Array<string | number | null> {
  const memberId = safeProfileId(r.memberUrn);
  const base = [
    memberId,
    r.memberUrn,
    r.publicIdentifier,
    r.firstName,
    r.lastName,
    r.connectedAt !== null ? new Date(r.connectedAt).toISOString() : null,
  ];
  return includeHeadline ? [...base, r.headline] : base;
}

function serializeRecord(r: ConnectionRecord, includeHeadline: boolean) {
  const memberId = safeProfileId(r.memberUrn);
  return {
    memberId,
    memberUrn: r.memberUrn,
    publicIdentifier: r.publicIdentifier,
    firstName: r.firstName,
    lastName: r.lastName,
    connectedAtMs: r.connectedAt,
    ...(includeHeadline ? { headline: r.headline } : {}),
  };
}

function safeProfileId(urn: string): string {
  try {
    return profileUrnId(urn);
  } catch {
    return "";
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
