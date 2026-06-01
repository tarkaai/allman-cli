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

const DEFAULT_PAGE_SIZE = 100;
/** Hard ceiling to prevent runaway pagination. LinkedIn's known practical cap
 *  is somewhere between ~1k and ~3k for this endpoint; we paginate past that
 *  and rely on the server's `isLastPage` signal, with this as a safety net. */
const SAFETY_MAX = 10_000;

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
        },
        nowIso
      );
    }
    cstore.git.scheduleCommit(`connections: export ${all.length}`);
    await store.git.flush();
    output.success(
      `Stored ${all.length} connections in ${storePath}/${session.profileId}/connections`
    );
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
