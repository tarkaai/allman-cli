/**
 * LinkedIn 1st-degree connections endpoint.
 *
 * Uses the voyager REST `relationships/dash/connections` resource — no GraphQL
 * queryId required, which makes this surface immune to LinkedIn's periodic
 * queryId-hash rotation.
 *
 *   GET /voyager/api/relationships/dash/connections
 *       ?decorationId=com.linkedin.voyager.dash.deco.web.mynetwork.ConnectionListWithProfile-{N}
 *       &q=search&start=N&count=N&sortType=RECENTLY_ADDED
 *
 * Response (normalized JSON):
 *   data.paging         = { count, start, links }
 *   data["*elements"]   = [ "urn:li:fsd_connection:<id>", ... ]  (connection records)
 *   included[]          = mix of fsd_connection and fsd_profile entries
 *
 * Each fsd_connection has a `connectedMember` field pointing at the
 * fsd_profile URN, which is the actual person. The fsd_profile entry holds
 * `publicIdentifier` (the slug), firstName/lastName, and headline.
 */
import type { LinkedInApiClient } from "../client.js";

const REST_URL = "https://www.linkedin.com/voyager/api/relationships/dash/connections";

/**
 * Decoration ID controls which fields the API returns. ConnectionListWithProfile
 * is the My-Network "Connections" page decoration — gives us name + slug in one
 * call. The trailing `-15` is the schema version; bump if LinkedIn 400s.
 */
export const CONNECTIONS_DECORATION_ID =
  "com.linkedin.voyager.dash.deco.web.mynetwork.ConnectionListWithProfile-15";

export type ConnectionsSortType = "RECENTLY_ADDED" | "FIRST_NAME_LAST_NAME";

export interface ConnectionRecord {
  /** `urn:li:fsd_profile:<id>` — the connected person's flagship profile URN. */
  memberUrn: string;
  /** publicIdentifier — the slug in `linkedin.com/in/<slug>`. Lowercased. */
  publicIdentifier: string | null;
  firstName: string | null;
  lastName: string | null;
  headline: string | null;
  /** ms-since-epoch when the connection was created (if reported). */
  connectedAt: number | null;
}

export interface ConnectionsPage {
  records: ConnectionRecord[];
  /** `paging.count` from the response, or records.length if paging is absent. */
  pageSize: number;
  /** True when we received fewer records than requested — end of results. */
  isLastPage: boolean;
}

interface RawResponse {
  data?: {
    paging?: { count?: number; start?: number; total?: number };
    ["*elements"]?: string[];
  };
  included?: Array<Record<string, unknown>>;
}

/**
 * Fetch one page of 1st-degree connections.
 *
 * The endpoint returns a partial page when the result set is exhausted.
 * Callers paginate by incrementing `start` by `count` until `isLastPage`.
 */
export async function listConnectionsPage(
  client: LinkedInApiClient,
  opts: { start: number; count: number; sortType?: ConnectionsSortType }
): Promise<ConnectionsPage> {
  const params = new URLSearchParams({
    decorationId: CONNECTIONS_DECORATION_ID,
    q: "search",
    start: String(opts.start),
    count: String(opts.count),
    sortType: opts.sortType ?? "RECENTLY_ADDED",
  });
  const url = `${REST_URL}?${params.toString()}`;
  const resp = await client.request<RawResponse>({ method: "GET", url });
  return parseConnectionsResponse(resp, opts.count);
}

/**
 * Parse a normalized connections response into structured records.
 * Pure function — exposed for unit testing.
 */
export function parseConnectionsResponse(
  resp: RawResponse,
  requestedCount: number
): ConnectionsPage {
  const data = resp.data ?? {};
  const connUrns = data["*elements"] ?? [];
  const included = resp.included ?? [];

  const byUrn = new Map<string, Record<string, unknown>>();
  for (const item of included) {
    const u = item.entityUrn;
    if (typeof u === "string") byUrn.set(u, item);
  }

  const records: ConnectionRecord[] = [];
  for (const connUrn of connUrns) {
    const conn = byUrn.get(connUrn);
    if (!conn) continue;
    const memberRef = conn.connectedMember;
    if (typeof memberRef !== "string") continue;
    const profile = byUrn.get(memberRef);

    records.push({
      memberUrn: memberRef,
      publicIdentifier: lowerStr(profile?.publicIdentifier),
      firstName: extractText(profile?.firstName),
      lastName: extractText(profile?.lastName),
      headline: extractText(profile?.headline),
      connectedAt: typeof conn.createdAt === "number" ? conn.createdAt : null,
    });
  }

  const pageSize = data.paging?.count ?? requestedCount;
  return { records, pageSize, isLastPage: records.length < requestedCount };
}

function extractText(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (v && typeof v === "object") {
    const t = (v as { text?: unknown }).text;
    if (typeof t === "string") return t;
  }
  return null;
}

function lowerStr(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v.toLowerCase() : null;
}
