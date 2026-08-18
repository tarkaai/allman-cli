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
import { bestImageUrl } from "./profile-detail.js";

const SALES_API_BASE = "https://www.linkedin.com/sales-api";

/**
 * Decoration controlling the lead-search response shape. We use the standard
 * desktop search decoration. It returns fully decorated hits — name, location,
 * current/past roles, and a sibling `sales.company.Company` entity carrying the
 * employer's industry and HQ — so the parsers below read the whole hit rather
 * than only its ids. Confirmed working against the live API.
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

/**
 * Maximum flagship ids per `salesApiProfiles` call. 100 resolves cleanly
 * (~9.2 KB of URL); 150 returns HTTP 400.
 */
export const SALESNAV_RESOLVE_BATCH = 100;

/**
 * Batch-resolve flagship ids (`ACo…`) to salesnav ids (`ACw…`).
 *
 * This is the bridge between the two backends. SalesNav search results carry no
 * flagship id or slug, but `salesApiProfiles` accepts *flagship* ids as input
 * and hands back the matching salesnav URNs — 100 per request — so a flagship
 * connection list can be mapped onto SalesNav's rich data without a per-person
 * round trip.
 *
 * Unresolvable people are simply absent from the returned map (SalesNav doesn't
 * know everyone). Chunks that fail are skipped rather than failing the batch.
 */
export async function resolveSalesnavIdsFromFlagshipIds(
  client: LinkedInApiClient,
  flagshipIds: string[],
  opts: { onChunk?: (done: number, total: number) => void | Promise<void> } = {}
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let i = 0; i < flagshipIds.length; i += SALESNAV_RESOLVE_BATCH) {
    const chunk = flagshipIds.slice(i, i + SALESNAV_RESOLVE_BATCH);
    const idsTuple = chunk
      .map((id) => `(profileId:${id},authType:undefined,authToken:undefined)`)
      .join(",");
    try {
      const raw = await client.request<ProfileResolveRaw>({
        method: "GET",
        url: `${SALES_API_BASE}/salesApiProfiles?ids=List(${restli(idsTuple)})`,
      });
      for (const [key, value] of Object.entries(mergeResults(raw))) {
        // key looks like `*(authToken:undefined,authType:undefined,profileId:ACo…)`
        const flagshipId = /profileId:([^),]+)/.exec(key)?.[1];
        const salesnavId = typeof value === "string" ? extractSalesnavId(value) : null;
        if (flagshipId && salesnavId) out.set(flagshipId, salesnavId);
      }
    } catch {
      // A bad chunk shouldn't sink the whole resolution pass.
    }
    await opts.onChunk?.(Math.min(i + chunk.length, flagshipIds.length), flagshipIds.length);
  }
  return out;
}

function mergeResults(raw: ProfileResolveRaw): Record<string, unknown> {
  return { ...(raw.results ?? {}), ...(raw.data?.results ?? {}) };
}

// ---------------------------------------------------------------------------
// Lead search: CONNECTION_OF (the 1st-degree connections of person X)
// ---------------------------------------------------------------------------

/**
 * One role from a Sales Navigator search hit.
 *
 * SalesNav is the only surface that hands back the employer's industry and HQ
 * location inline (via a sibling `sales.company.Company` entity) and that
 * pre-computes tenure — the flagship profile resource gives you neither.
 */
export interface SalesnavPosition {
  title: string | null;
  company: string | null;
  /** `urn:li:fs_salesCompany:<id>` — SalesNav's company namespace. */
  companyUrn: string | null;
  /** Standardized industry of the employer, e.g. "Technology, Information and Internet". */
  companyIndustry: string | null;
  /** Employer HQ location, e.g. "San Mateo, California, United States". */
  companyLocation: string | null;
  /** Employer logo URL. Signed and expiring — a cache, not a permalink. */
  companyLogoUrl: string | null;
  /** `YYYY-MM`, or `YYYY` when SalesNav omits the month. */
  startDate: string | null;
  endDate: string | null;
  current: boolean;
  /** Months in this role, as SalesNav computes it. */
  tenureMonths: number | null;
  /** Months at this employer across all roles. */
  companyTenureMonths: number | null;
}

/**
 * A SalesNav "spotlight" — the badges the UI puts on a search hit, e.g.
 * "23 mutual connections", "2 recent posts on Linkedin", "changed jobs".
 * `id` is the stable enum; `label` is the rendered string that carries the count.
 */
export interface SalesnavSpotlight {
  id: string;
  label: string | null;
}

export interface SalesnavLead {
  /** Salesnav id — first segment of the composite fs_salesProfile URN. */
  salesnavId: string;
  /** Full fs_salesProfile URN (composite). */
  entityUrn: string;
  /** `urn:li:member:<numeric>` — canonical numeric member id (may be ""). */
  memberUrn: string;
  /** Numeric member id alone, extracted from memberUrn (may be ""). */
  memberId: string;
  // The lead-search decoration returns fully decorated hits, so a
  // CONNECTION_OF sweep already carries the person — not just their id.
  firstName: string | null;
  lastName: string | null;
  fullName: string | null;
  /** e.g. "Austin, Texas Metropolitan Area" */
  location: string | null;
  /** Network distance; 2 for a 2nd-degree result. */
  degree: number | null;
  title: string | null;
  company: string | null;
  /** `urn:li:fs_salesCompany:<id>` of the current employer. */
  companyUrn: string | null;
  companyIndustry: string | null;
  profilePictureUrl: string | null;
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
  included?: Array<DecoratedHit & RawSalesCompany>;
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
  const companies = companyIndex(included);
  const byUrn = new Map<string, DecoratedHit>();
  for (const i of included) {
    if (i.entityUrn) byUrn.set(i.entityUrn, i);
  }

  const leads: SalesnavLead[] = [];
  const seen = new Set<string>();
  const pushLead = (entityUrn: string, inlineObjectUrn?: string) => {
    const salesnavId = extractSalesnavId(entityUrn);
    if (!salesnavId || seen.has(salesnavId)) return;
    seen.add(salesnavId);
    // The lead-search decoration returns the whole person alongside the id.
    // Reading it here is free — the bytes already crossed the wire.
    const hit = byUrn.get(entityUrn);
    const memberUrn = inlineObjectUrn ?? hit?.objectUrn ?? "";
    const memberId = /urn:li:member:(\d+)/.exec(memberUrn)?.[1] ?? "";
    const primary = hit?.currentPositions?.[0];
    const company = primary?.companyUrn ? companies.get(primary.companyUrn) : undefined;
    leads.push({
      salesnavId,
      entityUrn,
      memberUrn,
      memberId,
      firstName: nonEmpty(hit?.firstName),
      lastName: nonEmpty(hit?.lastName),
      fullName: nonEmpty(hit?.fullName),
      location: nonEmpty(hit?.geoRegion),
      degree: typeof hit?.degree === "number" ? hit.degree : null,
      title: nonEmpty(primary?.title),
      company: nonEmpty(primary?.companyName) ?? nonEmpty(company?.name),
      companyUrn: nonEmpty(primary?.companyUrn),
      companyIndustry: nonEmpty(company?.industry),
      profilePictureUrl: bestImageUrl(hit?.profilePictureDisplayImage),
    });
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

// ---------------------------------------------------------------------------
// Lead search: RELATIONSHIP:F (the viewer's OWN 1st-degree connections)
// ---------------------------------------------------------------------------

/**
 * Your own connections, decorated.
 *
 * This is the big win of the SalesNav backend: the search hits already carry
 * name, location, current role, and summary, so one paginated sweep at 100/page
 * yields what the flagship path needs 2 extra requests *per person* to gather.
 *
 * The cost is identity: SalesNav returns a salesnav id + numeric member id but
 * **no flagship id and no public slug**, and the flagship connections list
 * carries no member id — so the two sources cannot be joined in bulk. That's
 * why these records live in their own store namespace rather than merging.
 */
export interface SalesnavConnection {
  salesnavId: string;
  entityUrn: string;
  /** `urn:li:member:<numeric>` */
  memberUrn: string;
  memberId: string;
  firstName: string | null;
  lastName: string | null;
  fullName: string | null;
  /** e.g. "Austin, Texas Metropolitan Area" */
  location: string | null;
  /** Network distance; 1 for a 1st-degree connection. */
  degree: number | null;
  title: string | null;
  company: string | null;
  /** `urn:li:fs_salesCompany:<id>` of the current employer. */
  companyUrn: string | null;
  /** Standardized industry of the current employer. */
  companyIndustry: string | null;
  /** Current employer's HQ location. */
  companyLocation: string | null;
  /** The profile's About text, when SalesNav exposes it. */
  about: string | null;
  /** True when an invitation between you and this person is outstanding. */
  pendingInvitation: boolean;
  /** True when the member holds a Premium subscription. */
  premium: boolean;
  /** True when the member accepts InMail from outside their network. */
  openLink: boolean;
  /** True for a memorialized (deceased) member — exclude from outreach. */
  memorialized: boolean;
  /** Whether you have saved this lead in Sales Navigator. */
  saved: boolean;
  /** Whether you have already viewed this lead's profile. */
  viewed: boolean;
  /** Largest profile photo URL. Signed and expiring — a cache, not a permalink. */
  profilePictureUrl: string | null;
  /** Every ongoing role, not just the one the UI shows. */
  currentPositions: SalesnavPosition[];
  /** Work history SalesNav already resolved — no per-profile fetch needed. */
  pastPositions: SalesnavPosition[];
  /** Search-hit badges: mutual connections, recent posts, job changes. */
  spotlights: SalesnavSpotlight[];
}

export interface OwnConnectionsPage {
  connections: SalesnavConnection[];
  total: number | null;
  isLastPage: boolean;
}

/** Filter for "people I'm directly connected to". */
export function buildOwnConnectionsQuery(): string {
  return "(filters:List((type:RELATIONSHIP,values:List((id:F,selectionType:INCLUDED)))))";
}

/** Fetch one page of your own 1st-degree connections, decorated. */
export async function leadSearchOwnConnections(
  client: LinkedInApiClient,
  opts: { start: number; count: number }
): Promise<OwnConnectionsPage> {
  const url =
    `${SALES_API_BASE}/salesApiLeadSearch?q=searchQuery&query=${restli(buildOwnConnectionsQuery())}` +
    `&start=${opts.start}&count=${opts.count}&decorationId=${LEAD_SEARCH_DECORATION_ID}`;
  const resp = await client.request<DecoratedSearchRaw>({ method: "GET", url });
  return parseOwnConnectionsResponse(resp, opts.count);
}

/** SalesNav's `Duration` — `{ numYears, numMonths }`, both optional. */
interface RawDuration {
  numYears?: number;
  numMonths?: number;
}
/** SalesNav's `sales.profile.Position`, as it appears inside a decorated hit. */
interface RawSalesPosition {
  title?: string;
  companyName?: string;
  companyUrn?: string;
  current?: boolean;
  startedOn?: { year?: number; month?: number };
  endedOn?: { year?: number; month?: number };
  tenureAtPosition?: RawDuration;
  tenureAtCompany?: RawDuration;
}
interface RawSpotlight {
  id?: string;
  displayValue?: string;
}
interface DecoratedHit {
  $type?: string;
  entityUrn?: string;
  objectUrn?: string;
  firstName?: string;
  lastName?: string;
  fullName?: string;
  geoRegion?: string;
  degree?: number;
  summary?: string;
  pendingInvitation?: boolean;
  premium?: boolean;
  openLink?: boolean;
  memorialized?: boolean;
  saved?: boolean;
  viewed?: boolean;
  profilePictureDisplayImage?: unknown;
  spotlightBadges?: RawSpotlight[];
  currentPositions?: RawSalesPosition[];
  pastPositions?: RawSalesPosition[];
}
/** `sales.company.Company` — the sibling entity holding industry + HQ + logo. */
interface RawSalesCompany {
  $type?: string;
  entityUrn?: string;
  name?: string;
  industry?: string;
  location?: string;
  companyPictureDisplayImage?: unknown;
}
interface DecoratedSearchRaw {
  data?: LeadSearchInner;
  included?: Array<DecoratedHit & RawSalesCompany>;
  paging?: { total?: number };
  metadata?: { totalDisplayCount?: number | string };
}

/**
 * Parse a decorated lead-search response into connection records.
 * Pure — exposed for unit testing.
 */
export function parseOwnConnectionsResponse(
  raw: DecoratedSearchRaw,
  requestedCount: number
): OwnConnectionsPage {
  const data: LeadSearchInner = raw.data ?? {};
  const included = raw.included ?? [];
  const companies = companyIndex(included);
  const hits = included.filter((i) =>
    typeof i.$type === "string" ? i.$type.includes("DecoratedPeopleSearchHit") : false
  );

  const connections: SalesnavConnection[] = [];
  const seen = new Set<string>();
  for (const h of hits) {
    const entityUrn = h.entityUrn ?? "";
    const salesnavId = extractSalesnavId(entityUrn);
    if (!salesnavId || seen.has(salesnavId)) continue;
    seen.add(salesnavId);
    const currentPositions = (h.currentPositions ?? []).map((p) =>
      salesPosition(p, companies, true)
    );
    const pastPositions = (h.pastPositions ?? []).map((p) => salesPosition(p, companies, false));
    // Current role: SalesNav already filters to ongoing positions, so the
    // first entry is the one the UI shows.
    const primary = currentPositions[0];
    const memberUrn = h.objectUrn ?? "";
    connections.push({
      salesnavId,
      entityUrn,
      memberUrn,
      memberId: /urn:li:member:(\d+)/.exec(memberUrn)?.[1] ?? "",
      firstName: nonEmpty(h.firstName),
      lastName: nonEmpty(h.lastName),
      fullName: nonEmpty(h.fullName),
      location: nonEmpty(h.geoRegion),
      degree: typeof h.degree === "number" ? h.degree : null,
      title: primary?.title ?? null,
      company: primary?.company ?? null,
      companyUrn: primary?.companyUrn ?? null,
      companyIndustry: primary?.companyIndustry ?? null,
      companyLocation: primary?.companyLocation ?? null,
      about: nonEmpty(h.summary),
      pendingInvitation: h.pendingInvitation === true,
      premium: h.premium === true,
      openLink: h.openLink === true,
      memorialized: h.memorialized === true,
      saved: h.saved === true,
      viewed: h.viewed === true,
      profilePictureUrl: bestImageUrl(h.profilePictureDisplayImage),
      currentPositions,
      pastPositions,
      spotlights: (h.spotlightBadges ?? []).flatMap((b) =>
        b.id ? [{ id: b.id, label: nonEmpty(b.displayValue) }] : []
      ),
    });
  }

  const total =
    coerceTotal(data.paging?.total) ??
    coerceTotal(raw.paging?.total) ??
    coerceTotal(data.metadata?.totalDisplayCount) ??
    coerceTotal(raw.metadata?.totalDisplayCount);
  return {
    connections,
    total,
    isLastPage: connections.length < requestedCount,
  };
}

/** Index the `sales.company.Company` entities a decorated response ships alongside its hits. */
function companyIndex(
  included: Array<DecoratedHit & RawSalesCompany>
): Map<string, RawSalesCompany> {
  const out = new Map<string, RawSalesCompany>();
  for (const i of included) {
    if (typeof i.$type === "string" && i.$type.endsWith(".company.Company") && i.entityUrn) {
      out.set(i.entityUrn, i);
    }
  }
  return out;
}

/**
 * Normalize one SalesNav position, folding in the employer's industry, HQ and
 * logo from the sibling Company entity `companyUrn` points at.
 */
function salesPosition(
  p: RawSalesPosition,
  companies: Map<string, RawSalesCompany>,
  defaultCurrent: boolean
): SalesnavPosition {
  const company = p.companyUrn ? companies.get(p.companyUrn) : undefined;
  return {
    title: nonEmpty(p.title),
    company: nonEmpty(p.companyName) ?? nonEmpty(company?.name),
    companyUrn: nonEmpty(p.companyUrn),
    companyIndustry: nonEmpty(company?.industry),
    companyLocation: nonEmpty(company?.location),
    companyLogoUrl: bestImageUrl(company?.companyPictureDisplayImage),
    startDate: salesDate(p.startedOn),
    endDate: salesDate(p.endedOn),
    current: typeof p.current === "boolean" ? p.current : defaultCurrent,
    tenureMonths: durationMonths(p.tenureAtPosition),
    companyTenureMonths: durationMonths(p.tenureAtCompany),
  };
}

/** `{year, month?}` -> `YYYY-MM`, or `YYYY` when the month is absent. */
function salesDate(d: { year?: number; month?: number } | undefined): string | null {
  if (!d || typeof d.year !== "number") return null;
  return typeof d.month === "number"
    ? `${d.year}-${String(d.month).padStart(2, "0")}`
    : String(d.year);
}

/** `{numYears, numMonths}` -> total months. */
function durationMonths(d: RawDuration | undefined): number | null {
  if (!d) return null;
  const y = typeof d.numYears === "number" ? d.numYears : 0;
  const m = typeof d.numMonths === "number" ? d.numMonths : 0;
  return y === 0 && m === 0 && d.numYears === undefined && d.numMonths === undefined
    ? null
    : y * 12 + m;
}

function nonEmpty(v: string | undefined): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
