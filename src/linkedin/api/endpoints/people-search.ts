/**
 * Flagship people search (SRP) via the `voyagerSearchDashClusters` GraphQL.
 *
 * Why this surface (vs Sales Navigator):
 *   - No multi-step seat handshake required.
 *   - Works for accounts without a SalesNav seat.
 *   - Returns flagship ids + public-identifier slugs in one call.
 *
 * The catch: `voyagerSearchDashClusters` is a GraphQL queryId with a content
 * hash that LinkedIn rotates with new web bundles. The live hash is resolved by
 * `flagship-queryid.ts` (cache + headless capture) and passed in here as
 * `opts.queryId` — this module just builds and parses the request.
 *
 *   GET /voyager/api/graphql
 *       ?queryId=voyagerSearchDashClusters.<hash>
 *       &variables=(start:N,origin:FACETED_SEARCH,query:(
 *           keywords:,
 *           flagshipSearchIntent:SEARCH_SRP,
 *           queryParameters:List(
 *             (key:resultType,value:List(PEOPLE)),
 *             (key:network,value:List(S)),                     // 2nd-degree (from viewer)
 *             (key:connectionOf,value:List(<flagship-id-of-X>)) // X = the person whose connections we want
 *           ),
 *           includeFiltersInResponse:false
 *       ),count:N)
 *
 * Response path:
 *   data.searchDashClustersByAll.elements[].items[].item.entityResult
 *     .target.profile.{entityUrn, publicIdentifier}
 */
import type { LinkedInApiClient } from "../client.js";

const GRAPHQL_URL = "https://www.linkedin.com/voyager/api/graphql";

// ---------------------------------------------------------------------------
// Search request + parsing
// ---------------------------------------------------------------------------

export interface PeopleSearchHit {
  /** `urn:li:fsd_profile:<id>` — flagship profile URN. */
  memberUrn: string;
  /** Numeric member id (from the result's `trackingUrn`), or null. */
  memberId: string | null;
  /** Slug — the `linkedin.com/in/<slug>` form (from `navigationUrl`), or null. */
  publicIdentifier: string | null;
}

export interface PeopleSearchPage {
  hits: PeopleSearchHit[];
  /** Total reported by the server (`metadata.totalResultCount`). */
  total: number | null;
  start: number;
  count: number;
  isLastPage: boolean;
}

/**
 * Build the GraphQL `variables` string for a people-SRP CONNECTION_OF search.
 *
 * The exact structure is mirrored from the live web app's `getDashSrpPrefetchConfig`
 * builder (reverse-engineered from the current bundle): `includeFiltersInResponse`
 * lives INSIDE `query`, and `keywords` is OMITTED when empty (an empty `keywords:`
 * is a parse error → 400).
 *
 *   variables=(start:N,origin:FACETED_SEARCH,query:(
 *     queryParameters:List(
 *       (key:resultType,value:List(PEOPLE)),
 *       (key:network,value:List(S)),                       // 2nd-degree from viewer
 *       (key:connectionOf,value:List(<flagshipId-of-X>))   // X's network
 *     ),
 *     flagshipSearchIntent:SEARCH_SRP,
 *     includeFiltersInResponse:false
 *   ))
 */
export function buildConnectionOfVariables(opts: {
  flagshipProfileId: string;
  start: number;
  count: number;
}): string {
  return (
    `(start:${opts.start},origin:FACETED_SEARCH,query:(queryParameters:List(` +
    "(key:resultType,value:List(PEOPLE))," +
    "(key:network,value:List(S))," +
    `(key:connectionOf,value:List(${opts.flagshipProfileId}))` +
    "),flagshipSearchIntent:SEARCH_SRP,includeFiltersInResponse:false)" +
    // count only when not the default 10, mirroring the web app
    `${opts.count !== 10 ? `,count:${opts.count}` : ""})`
  );
}

/**
 * Probe whether a `voyagerSearchDashClusters.<hash>` queryId is the PEOPLE-SRP
 * variant. There are several SearchDashClusters queries (people, jobs, cluster
 * expansion, right-rail); only the people one returns a populated
 * `searchDashClustersByAll` root for a PEOPLE keyword search. Used to pick the
 * right hash among the candidates extracted from the bundle.
 */
export async function isPeopleSearchClustersQueryId(
  client: LinkedInApiClient,
  queryId: string
): Promise<boolean> {
  const vars =
    "(start:0,origin:FACETED_SEARCH,query:(queryParameters:List((key:resultType,value:List(PEOPLE)))," +
    "flagshipSearchIntent:SEARCH_SRP,keywords:a,includeFiltersInResponse:false))";
  try {
    const r = await client.request<SearchClustersRaw>({
      method: "GET",
      url: `${GRAPHQL_URL}?variables=${vars}&queryId=${queryId}`,
    });
    const root = r.data?.data?.searchDashClustersByAll ?? r.data?.searchDashClustersByAll;
    return Boolean(root);
  } catch {
    return false;
  }
}

/** One page of the flagship people SRP for `connectionOf=<X>` + 2nd-degree. */
export async function searchPeopleConnectionOf(
  client: LinkedInApiClient,
  opts: { queryId: string; flagshipProfileId: string; start: number; count: number }
): Promise<PeopleSearchPage> {
  const variables = buildConnectionOfVariables(opts);
  const url = `${GRAPHQL_URL}?variables=${variables}&queryId=${opts.queryId}`;
  const resp = await client.request<SearchClustersRaw>({ method: "GET", url });
  return parseSearchClustersResponse(resp, opts.start, opts.count);
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

interface IncludedEntity {
  $type?: string;
  entityUrn?: string;
  trackingUrn?: string;
  navigationUrl?: string;
}
type SearchClustersRaw = {
  data?: {
    data?: { searchDashClustersByAll?: { metadata?: { totalResultCount?: number } } };
    searchDashClustersByAll?: { metadata?: { totalResultCount?: number } };
    included?: IncludedEntity[];
  };
  included?: IncludedEntity[];
};

/**
 * Pure parser — exposed for unit testing.
 *
 * The live people-SRP response is normalized: results live in `included` as
 * `EntityResultViewModel` entries (one per person), each carrying everything we
 * need WITHOUT touching a profile page:
 *   entityUrn    → `urn:li:fsd_entityResultViewModel:(urn:li:fsd_profile:ACo…,SEARCH_SRP,DEFAULT)`  (flagship id)
 *   trackingUrn  → `urn:li:member:<numeric>`                                                       (numeric member id)
 *   navigationUrl→ `https://www.linkedin.com/in/<slug>`                                            (public slug)
 */
export function parseSearchClustersResponse(
  raw: SearchClustersRaw,
  start: number,
  count: number
): PeopleSearchPage {
  const root = raw.data?.data?.searchDashClustersByAll ?? raw.data?.searchDashClustersByAll;
  const total = root?.metadata?.totalResultCount ?? null;
  const included = raw.included ?? raw.data?.included ?? [];

  const hits: PeopleSearchHit[] = [];
  const seen = new Set<string>();
  for (const e of included) {
    if (!(e.$type ?? "").endsWith(".EntityResultViewModel")) continue;
    const flagshipId = /urn:li:fsd_profile:([^,)]+)/.exec(e.entityUrn ?? "")?.[1];
    if (!flagshipId || seen.has(flagshipId)) continue;
    seen.add(flagshipId);
    const memberId = /urn:li:member:(\d+)/.exec(e.trackingUrn ?? "")?.[1] ?? null;
    const slug = /linkedin\.com\/in\/([^/?#]+)/.exec(e.navigationUrl ?? "")?.[1] ?? null;
    hits.push({
      memberUrn: `urn:li:fsd_profile:${flagshipId}`,
      memberId,
      publicIdentifier: slug ? slug.toLowerCase() : null,
    });
  }

  // The page size we asked for vs. what came back tells us if more remain.
  const reachedTotal = total !== null && start + hits.length >= total;
  return { hits, total, start, count, isLastPage: hits.length < count || reachedTotal };
}
