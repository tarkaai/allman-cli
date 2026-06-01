/**
 * LinkedIn Sales Navigator endpoints (REST).
 *
 * The SalesNav "seat" is established in the browser during `allman login` (which
 * visits /sales/ and captures the `li_a` / `li_ep_auth_context` cookies). With
 * those cookies in the jar, every `sales-api/*` REST call works with NO per-call
 * handshake — so this module is pure REST, no browser, no enterprise-auth dance.
 * If the seat cookies are absent the calls 403 and the command tells the user to
 * re-run `allman login`.
 *
 * Endpoints:
 *   GET /sales-api/salesApiProfiles?ids=List((profileId:<flagshipId>,authType:undefined,authToken:undefined))
 *       → resolves a flagship id (ACoXXXX) to a salesnav id (ACwXXXX).
 *   GET /sales-api/salesApiLeadSearch?q=searchQuery&query=(...)&decorationId=...
 *       → people search; CONNECTION_OF + RELATIONSHIP:S yields the 2nd-degree
 *         connections of person X (= X's 1st-degree network visible to us).
 *
 * URN namespaces:
 *   urn:li:fs_salesProfile:(<salesnavId>,<ctx>,<token>)  (salesnav, ACwXXXX)
 *   urn:li:fsd_profile:<flagshipId>                       (flagship, ACoXXXX)
 *   urn:li:member:<numeric>                               (canonical member id)
 */
import type { LinkedInApiClient } from "../client.js";

const SALES_API_BASE = "https://www.linkedin.com/sales-api";

/**
 * Decoration controlling the lead-search response shape. We use the standard
 * desktop search decoration; we only read the IDs (the `*elements`
 * fs_salesProfile URNs + each hit's `objectUrn`) and discard everything else,
 * so we never persist profile data. Confirmed working against the live API.
 */
const LEAD_SEARCH_DECORATION_ID = "com.linkedin.sales.deco.desktop.searchv2.LeadSearchResult-14";

/** Encode a rest.li query string, leaving the structural `(),:` characters raw. */
function restli(s: string): string {
  return encodeURIComponent(s)
    .replace(/%2C/g, ",")
    .replace(/%3A/g, ":")
    .replace(/%28/g, "(")
    .replace(/%29/g, ")");
}

// ---------------------------------------------------------------------------
// Salesnav-id resolution (flagship id -> salesnav id)
// ---------------------------------------------------------------------------

/**
 * Composite salesnav URN: `urn:li:fs_salesProfile:(<salesnavId>,<ctx>,<token>)`.
 * Returns the first segment when the URN matches, else null.
 */
export function extractSalesnavId(salesProfileUrn: string): string | null {
  const m = /urn:li:fs_salesProfile:\(([^,)]+)/.exec(salesProfileUrn);
  return m?.[1] ?? null;
}

interface ProfileResolveInner {
  // `results` maps an id-tuple key to a fs_salesProfile URN STRING.
  results?: Record<string, unknown>;
  elements?: Array<{ entityUrn?: string }>;
}
type ProfileResolveRaw = ProfileResolveInner & {
  data?: ProfileResolveInner;
  included?: Array<{ entityUrn?: string }>;
};

/**
 * Resolve a flagship profile id (`ACo…`) to its salesnav id (`ACw…`) via the
 * salesnav profile resolver. Requires the SalesNav seat cookies (else 403).
 *
 * Response shape (normalized):
 *   data.results["*(authToken:undefined,authType:undefined,profileId:ACo…)"]
 *     = "urn:li:fs_salesProfile:(ACw…,undefined,undefined)"
 *
 * Returns null if salesnav doesn't know the person or the seat is missing.
 */
export async function resolveSalesnavIdFromFlagshipId(
  client: LinkedInApiClient,
  flagshipProfileId: string
): Promise<string | null> {
  const idsTuple = `(profileId:${flagshipProfileId},authType:undefined,authToken:undefined)`;
  const url = `${SALES_API_BASE}/salesApiProfiles?ids=List(${restli(idsTuple)})`;
  let raw: ProfileResolveRaw;
  try {
    raw = await client.request<ProfileResolveRaw>({ method: "GET", url });
  } catch {
    return null;
  }
  const resp: ProfileResolveInner = raw.data ?? raw;

  // results: values are fs_salesProfile URN strings (sometimes objects).
  for (const v of Object.values(resp.results ?? {})) {
    if (typeof v === "string") {
      const id = extractSalesnavId(v);
      if (id) return id;
    } else if (v && typeof v === "object") {
      const eu = (v as { entityUrn?: string }).entityUrn;
      if (eu) {
        const id = extractSalesnavId(eu);
        if (id) return id;
      }
    }
  }
  // Fallbacks: elements[].entityUrn, or any included fs_salesProfile.
  for (const e of resp.elements ?? []) {
    if (e.entityUrn) {
      const id = extractSalesnavId(e.entityUrn);
      if (id) return id;
    }
  }
  for (const i of raw.included ?? []) {
    if (i.entityUrn?.includes("fs_salesProfile")) {
      const id = extractSalesnavId(i.entityUrn);
      if (id) return id;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Lead search: CONNECTION_OF (the 1st-degree connections of person X)
// ---------------------------------------------------------------------------

export interface SalesnavLead {
  /** Salesnav id — first segment of the composite fs_salesProfile URN. */
  salesnavId: string;
  /** Full fs_salesProfile URN (composite). */
  entityUrn: string;
  /** `urn:li:member:<numeric>` — canonical numeric member id (may be ""). */
  memberUrn: string;
  /** Numeric member id alone, extracted from memberUrn (may be ""). */
  memberId: string;
}

export interface LeadSearchPage {
  leads: SalesnavLead[];
  /** Total result count reported by the server (paging.total). */
  total: number | null;
  start: number;
  count: number;
  isLastPage: boolean;
}

interface LeadSearchInner {
  metadata?: { totalDisplayCount?: number | string };
  paging?: { total?: number; count?: number; start?: number };
  // Normalized form: `*elements` is an array of fs_salesProfile URN strings.
  ["*elements"]?: string[];
  // Decorated form (fallback): elements carry entityUrn/objectUrn inline.
  elements?: Array<{ entityUrn?: string; objectUrn?: string }>;
}
type LeadSearchRaw = LeadSearchInner & {
  data?: LeadSearchInner;
  included?: Array<{ entityUrn?: string; objectUrn?: string }>;
};

/**
 * Build the rest.li `query=(filters:List(...))` string for the CONNECTION_OF
 * facet (2nd-degree, i.e. all of person X's 1st-degree connections).
 * `text:` labels are omitted — the server only needs id + selectionType, and
 * omitting them keeps names/ids out of the request beyond the target id.
 */
export function buildConnectionOfQuery(salesnavId: string): string {
  return (
    "(filters:List(" +
    `(type:CONNECTION_OF,values:List((id:${salesnavId},selectionType:INCLUDED))),` +
    "(type:RELATIONSHIP,values:List((id:S,selectionType:INCLUDED)))" +
    "))"
  );
}

/** Issue one page of the CONNECTION_OF search. Pagination is offset+count. */
export async function leadSearchConnectionOf(
  client: LinkedInApiClient,
  opts: { salesnavId: string; start: number; count: number }
): Promise<LeadSearchPage> {
  const query = buildConnectionOfQuery(opts.salesnavId);
  const url =
    `${SALES_API_BASE}/salesApiLeadSearch?q=searchQuery&query=${restli(query)}` +
    `&start=${opts.start}&count=${opts.count}&decorationId=${LEAD_SEARCH_DECORATION_ID}`;
  const resp = await client.request<LeadSearchRaw>({ method: "GET", url });
  return parseLeadSearchResponse(resp, opts.start, opts.count);
}

/**
 * Pure parser — exposed for unit testing.
 *
 * Handles the normalized response (the live shape):
 *   data["*elements"] = [ "urn:li:fs_salesProfile:(ACw…,NAME_SEARCH,xxxx)", ... ]
 *   included[]        = DecoratedPeopleSearchHit entries with objectUrn (member urn)
 * and a decorated fallback where each element carries entityUrn/objectUrn inline.
 */
export function parseLeadSearchResponse(
  raw: LeadSearchRaw,
  start: number,
  count: number
): LeadSearchPage {
  const data: LeadSearchInner = raw.data ?? raw;
  const included = raw.included ?? [];
  const byUrn = new Map<string, { entityUrn?: string; objectUrn?: string }>();
  for (const i of included) {
    if (i.entityUrn) byUrn.set(i.entityUrn, i);
  }

  const leads: SalesnavLead[] = [];
  const seen = new Set<string>();
  const pushLead = (entityUrn: string, inlineObjectUrn?: string) => {
    const salesnavId = extractSalesnavId(entityUrn);
    if (!salesnavId || seen.has(salesnavId)) return;
    seen.add(salesnavId);
    const memberUrn = inlineObjectUrn ?? byUrn.get(entityUrn)?.objectUrn ?? "";
    const memberId = /urn:li:member:(\d+)/.exec(memberUrn)?.[1] ?? "";
    leads.push({ salesnavId, entityUrn, memberUrn, memberId });
  };

  // Normalized form.
  for (const ref of data["*elements"] ?? []) {
    if (typeof ref === "string") pushLead(ref);
  }
  // Decorated fallback.
  if (leads.length === 0) {
    for (const e of data.elements ?? []) {
      if (e.entityUrn) pushLead(e.entityUrn, e.objectUrn);
    }
  }

  const total = coerceTotal(data.paging?.total) ?? coerceTotal(data.metadata?.totalDisplayCount);
  const reachedTotal = total !== null && start + leads.length >= total;
  return { leads, total, start, count, isLastPage: leads.length < count || reachedTotal };
}

/** Coerce a total that may be a number or a string like "167" (not "11M+"). */
function coerceTotal(v: number | string | undefined): number | null {
  if (typeof v === "number") return v;
  if (typeof v === "string" && /^\d+$/.test(v)) return parseInt(v, 10);
  return null;
}
