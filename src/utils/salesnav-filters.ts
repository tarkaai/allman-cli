/**
 * Sales Navigator lead-search facets used by `connections-of`.
 *
 * A single `salesApiLeadSearch` query returns at most 1,000 results — pages
 * past `start=1000` come back empty even when the server reports a larger
 * total. The only way past the cap is to partition the search with extra
 * facet clauses appended inside the same `(filters:List(...))` and merge the
 * slices. Two facets carry the load:
 *
 *   REGION           — LinkedIn geo ids (90000084 = SF Bay Area, 90000091 =
 *                      Greater Seattle, 103644278 = United States)
 *   SENIORITY_LEVEL  — 300 = VP, 310 = CXO, 320 = Owner/Partner
 *
 * `selectionType:EXCLUDED` gives a clause's complement, and several values in
 * one clause are OR'd — so [US INCLUDED, Bay EXCLUDED, Seattle EXCLUDED] is
 * "the rest of the US" and [US EXCLUDED] is "outside the US".
 *
 * This module is pure: alias tables, flag parsing, and the slice plans. The
 * network side lives in `linkedin/api/endpoints/salesnav.ts`.
 */

/** One facet value: a LinkedIn id plus whether to include or exclude it. */
export interface FilterValue {
  id: string;
  include: boolean;
}

/** The facets `connections-of` can add to a CONNECTION_OF search. */
export interface LeadSearchFilters {
  regions?: FilterValue[];
  seniorities?: FilterValue[];
}

const BAY = "90000084";
const SEATTLE = "90000091";
const US = "103644278";
const EXEC = ["300", "310", "320"];

export const REGION_ALIASES: Readonly<Record<string, string[]>> = {
  bay: [BAY],
  seattle: [SEATTLE],
  us: [US],
};

export const SENIORITY_ALIASES: Readonly<Record<string, string[]>> = {
  vp: ["300"],
  cxo: ["310"],
  owner: ["320"],
  exec: EXEC,
};

/**
 * Parse one comma-separated flag value into facet values. Each item is a
 * numeric LinkedIn id or an alias from the table; anything else throws.
 */
export function parseFilterIds(
  raw: string | undefined,
  aliases: Readonly<Record<string, string[]>>,
  include: boolean,
  facetLabel: string
): FilterValue[] {
  if (!raw) return [];
  const out: FilterValue[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(",")) {
    const token = part.trim();
    if (!token) continue;
    const ids = /^\d+$/.test(token) ? [token] : aliases[token.toLowerCase()];
    if (!ids) {
      const known = Object.keys(aliases).join(", ");
      throw new Error(
        `Unknown ${facetLabel} "${token}". Pass a numeric LinkedIn id or one of: ${known}.`
      );
    }
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ id, include });
    }
  }
  return out;
}

/** The raw string flags as commander hands them over. */
export interface FilterFlagInput {
  region?: string;
  excludeRegion?: string;
  seniority?: string;
  excludeSeniority?: string;
}

/** Turn the four CLI flags into `LeadSearchFilters` (or null when none are set). */
export function parseFilterFlags(flags: FilterFlagInput): LeadSearchFilters | null {
  const regions = [
    ...parseFilterIds(flags.region, REGION_ALIASES, true, "region"),
    ...parseFilterIds(flags.excludeRegion, REGION_ALIASES, false, "region"),
  ];
  const seniorities = [
    ...parseFilterIds(flags.seniority, SENIORITY_ALIASES, true, "seniority"),
    ...parseFilterIds(flags.excludeSeniority, SENIORITY_ALIASES, false, "seniority"),
  ];
  if (regions.length === 0 && seniorities.length === 0) return null;
  return {
    ...(regions.length > 0 ? { regions } : {}),
    ...(seniorities.length > 0 ? { seniorities } : {}),
  };
}

/** True when the filters carry at least one facet value. */
export function hasFilters(filters: LeadSearchFilters | null | undefined): boolean {
  return Boolean(
    filters && ((filters.regions?.length ?? 0) > 0 || (filters.seniorities?.length ?? 0) > 0)
  );
}

/** Concatenate two filter sets (base first, then the slice's own clauses). */
export function mergeFilters(
  base: LeadSearchFilters | null | undefined,
  extra: LeadSearchFilters
): LeadSearchFilters {
  const regions = [...(base?.regions ?? []), ...(extra.regions ?? [])];
  const seniorities = [...(base?.seniorities ?? []), ...(extra.seniorities ?? [])];
  return {
    ...(regions.length > 0 ? { regions } : {}),
    ...(seniorities.length > 0 ? { seniorities } : {}),
  };
}

/** The facet a partition plan splits on. */
export type SliceFacet = "regions" | "seniorities";

/** The facet a plan's entries all carry (every plan splits exactly one facet). */
export function planFacet(plan: readonly SlicePlanEntry[]): SliceFacet {
  return plan[0]?.filters.seniorities ? "seniorities" : "regions";
}

/**
 * True when `filters` already pins `facet` to an included value. Values in one
 * clause are OR'd, so adding a plan's own INCLUDED ids to such a clause would
 * widen the search instead of partitioning it — `--slice` must skip that plan.
 * Exclusions are fine: they narrow, and a plan's slices still partition them.
 */
export function constrainsInclusively(
  filters: LeadSearchFilters | null | undefined,
  facet: SliceFacet
): boolean {
  return (filters?.[facet] ?? []).some((v) => v.include);
}

/**
 * The index of the first plan at or after `from` that `filters` leave open to
 * split on, or -1 when every remaining facet is already constrained.
 */
export function nextSliceLevel(
  filters: LeadSearchFilters | null | undefined,
  from: number
): number {
  for (let i = from; i < SLICE_PLANS.length; i++) {
    const plan = SLICE_PLANS[i];
    if (plan && !constrainsInclusively(filters, planFacet(plan))) return i;
  }
  return -1;
}

/** One slice of a partition plan: a label for the log line plus its clauses. */
export interface SlicePlanEntry {
  label: string;
  filters: LeadSearchFilters;
}

/**
 * The partition plans `--slice` walks, outermost first. Each plan splits a
 * search into disjoint slices; a slice still over the cap descends into the
 * next plan. Verified live: these four regions plus the exec/non-exec split
 * brought 3,600- and 2,000-person networks fully under the cap.
 */
export const SLICE_PLANS: readonly (readonly SlicePlanEntry[])[] = [
  [
    { label: "bay", filters: { regions: [{ id: BAY, include: true }] } },
    { label: "seattle", filters: { regions: [{ id: SEATTLE, include: true }] } },
    {
      label: "us-rest",
      filters: {
        regions: [
          { id: US, include: true },
          { id: BAY, include: false },
          { id: SEATTLE, include: false },
        ],
      },
    },
    { label: "non-us", filters: { regions: [{ id: US, include: false }] } },
  ],
  [
    { label: "exec", filters: { seniorities: EXEC.map((id) => ({ id, include: true })) } },
    { label: "non-exec", filters: { seniorities: EXEC.map((id) => ({ id, include: false })) } },
  ],
];
