/**
 * `allman enrich` — turn stored 1st-degree connections into full profiles.
 *
 * `allman connections` deliberately stores IDs + name + headline only. This
 * command does the per-profile fetch (title, company, location, About; plus
 * work history / education / skills with --deep) and writes the results back
 * onto each connection record with `enrichedAt` provenance.
 *
 *   allman enrich                 enrich every stored connection missing data
 *   allman enrich --deep          include work history, education, skills
 *   allman enrich --limit 200     cap how many profiles to fetch this run
 *   allman enrich --force         re-fetch even already-enriched records
 *   allman enrich <slug>          enrich a single person (adds them if new)
 *
 * Fetches are paced with the same random 2–8s delay as `connections` paging to
 * stay well under LinkedIn's thresholds.
 */

import type { LinkedInApiClient } from "../linkedin/api/client.js";
import {
  fetchProfileDetail,
  type ProfileDetail,
} from "../linkedin/api/endpoints/profile-detail.js";
import { loadSession } from "../linkedin/api/session.js";
import type { ConnectionEnrichment, ConnectionsStore } from "../store/connections-store.js";
import { resolveStorePath, Store } from "../store/index.js";
import * as output from "../utils/output.js";
import {
  DEFAULT_PAGE_DELAY,
  type RandomDelayConfig,
  randomPageSleep,
} from "../utils/random-delay.js";
import { slugFromUrl } from "../utils/slug.js";
import { isUrn, profileUrnId } from "../utils/urn.js";

export interface EnrichOptions {
  account?: string;
  store?: string;
  json?: boolean;
  /** Fetch full work history, education, and skills. */
  deep?: boolean;
  /** Re-fetch even connections that already have enrichment data. */
  force?: boolean;
  /** Max profiles to fetch this run (default: all). */
  limit?: number;
  /** For tests: skip the inter-fetch delay. */
  noDelay?: boolean;
  delayConfig?: RandomDelayConfig;
}

export async function enrichCommand(
  target: string | undefined,
  opts: EnrichOptions
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

  const cstore = store.connectionsFor(session.profileId);
  const depth = opts.deep ? "deep" : "core";

  // Single-target mode: `allman enrich <slug|url|urn>`.
  if (target) {
    const identity = resolveIdentity(target);
    if (!identity) {
      output.error(
        `Cannot resolve "${target}". Use a LinkedIn URL, profile slug, or profile id.`,
        1
      );
      return;
    }
    output.info(`Fetching profile "${identity}"…`);
    let detail: ProfileDetail | null;
    try {
      detail = await fetchProfileDetail(session.apiClient, identity, { deep: opts.deep });
    } catch (err) {
      output.error(`Profile fetch failed: ${(err as Error).message}`, 1);
      return;
    }
    if (!detail?.urn) {
      output.error(`Profile "${identity}" not found or not accessible.`, 1);
      return;
    }
    const nowIso = new Date().toISOString();
    const flagshipId = profileUrnId(detail.urn);
    // Ensure a base record exists so we have somewhere to attach enrichment.
    await cstore.upsertConnection(
      {
        memberUrn: detail.urn,
        flagshipId,
        publicIdentifier: detail.publicIdentifier,
        firstName: detail.firstName,
        lastName: detail.lastName,
        headline: detail.headline,
        connectedAt: null,
      },
      nowIso
    );
    await cstore.enrichConnection(flagshipId, toEnrichment(detail, depth), depth, nowIso);
    cstore.git.scheduleCommit(`enrich: ${detail.publicIdentifier ?? flagshipId}`);
    await store.git.flush();

    if (opts.json) {
      output.printData({ flagshipId, ...toEnrichment(detail, depth), enrichDepth: depth });
    } else {
      output.success(`Enriched ${displayName(detail)} (${depth}).`);
    }
    return;
  }

  // Bulk mode: enrich stored connections.
  const ids = await cstore.listConnectionIds();
  if (ids.length === 0) {
    output.error("No stored connections. Run `allman connections` first.", 1);
    return;
  }

  const delayConfig = opts.delayConfig ?? DEFAULT_PAGE_DELAY;
  const result = await enrichConnections({
    apiClient: session.apiClient,
    cstore,
    ids,
    depth,
    force: opts.force === true,
    limit: opts.limit,
    json: opts.json === true,
    noDelay: opts.noDelay === true,
    delayConfig,
  });

  cstore.git.scheduleCommit(`enrich: ${result.enriched} profiles (${depth})`);
  await store.git.flush();

  output.success(
    `Enriched ${result.enriched}, skipped ${result.skipped} (already done), ${result.failed} failed.`
  );
}

// ---------------------------------------------------------------------------
// Reusable enrichment pass (also used by `connections --enrich`)
// ---------------------------------------------------------------------------

export interface EnrichPassParams {
  apiClient: LinkedInApiClient;
  cstore: ConnectionsStore;
  ids: string[];
  depth: "core" | "deep";
  force: boolean;
  /** Max profiles to actually fetch this run. */
  limit?: number;
  json: boolean;
  noDelay: boolean;
  delayConfig: RandomDelayConfig;
}

export interface EnrichPassResult {
  enriched: number;
  skipped: number;
  failed: number;
}

/**
 * Enrich a set of connections by flagship id. Skips records that already have
 * enrichment at the requested depth (unless `force`), stops after `limit`
 * successful fetches, and paces fetches with a random delay. Does not commit —
 * the caller owns the git commit + flush.
 */
export async function enrichConnections(params: EnrichPassParams): Promise<EnrichPassResult> {
  const { apiClient, cstore, ids, depth, force, limit, json, noDelay, delayConfig } = params;
  const cap = limit && limit > 0 ? limit : Number.POSITIVE_INFINITY;

  let enriched = 0;
  let skipped = 0;
  let failed = 0;
  let firstFetch = true;

  for (const id of ids) {
    if (enriched >= cap) break;

    const record = await cstore.readConnection(id);
    if (!record) {
      failed += 1;
      continue;
    }
    if (!force && !needsEnrichment(record.enrichedAt ?? null, record.enrichDepth ?? null, depth)) {
      skipped += 1;
      continue;
    }

    // Pace between actual network fetches (not on skips).
    if (!firstFetch && !noDelay) await randomPageSleep(delayConfig);
    firstFetch = false;

    const identity = record.publicIdentifier ?? id;
    let detail: ProfileDetail | null;
    try {
      detail = await fetchProfileDetail(apiClient, identity, { deep: depth === "deep" });
    } catch (err) {
      output.warn(`  ${identity}: fetch failed (${(err as Error).message})`);
      failed += 1;
      continue;
    }
    if (!detail) {
      output.warn(`  ${identity}: not found / not accessible`);
      failed += 1;
      continue;
    }

    const nowIso = new Date().toISOString();
    await cstore.enrichConnection(id, toEnrichment(detail, depth), depth, nowIso);
    enriched += 1;

    if (json) {
      output.emitEvent({ flagshipId: id, ...toEnrichment(detail, depth), enrichDepth: depth });
    } else {
      output.info(
        `  ${enriched}. ${displayName(detail)}${detail.company ? ` — ${detail.company}` : ""}`
      );
    }
  }

  return { enriched, skipped, failed };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Whether a record needs (re-)enrichment given the requested depth. */
function needsEnrichment(
  enrichedAt: string | null,
  currentDepth: "core" | "deep" | null,
  requestedDepth: "core" | "deep"
): boolean {
  if (!enrichedAt) return true;
  // A core record still needs work when a deep pass is requested (an upgrade).
  if (requestedDepth === "deep" && currentDepth !== "deep") return true;
  return false;
}

/**
 * Map a fetched profile onto the stored connection fields.
 *
 * Positions are always *fetched* (they're the source of title/company) but only
 * *stored* in deep mode — a core record stays a compact summary.
 */
function toEnrichment(d: ProfileDetail, depth: "core" | "deep"): ConnectionEnrichment {
  const base: ConnectionEnrichment = {
    firstName: d.firstName,
    lastName: d.lastName,
    headline: d.headline,
    title: d.title,
    company: d.company,
    location: d.location,
    about: d.about,
  };
  if (depth !== "deep") return base;
  return {
    ...base,
    positions: d.positions.length > 0 ? d.positions : null,
    education: d.education.length > 0 ? d.education : null,
    skills: d.skills.length > 0 ? d.skills : null,
  };
}

function displayName(d: ProfileDetail): string {
  const name = [d.firstName, d.lastName].filter(Boolean).join(" ");
  return name || d.publicIdentifier || d.urn;
}

/** Normalize a target into a memberIdentity (slug or profile id) for the API. */
function resolveIdentity(target: string): string | null {
  if (isUrn(target) && target.includes("fsd_profile")) {
    try {
      return profileUrnId(target);
    } catch {
      return null;
    }
  }
  try {
    return slugFromUrl(target);
  } catch {
    return null;
  }
}
