/**
 * Voyager member-relationships endpoint — tells us our network distance to a
 * given profile. We use it as a cheap pre-check before doing expensive
 * connections-of searches: only 1st-degree connections of the viewer expose
 * their own 1st-degree network.
 *
 *   GET /voyager/api/relationships/dash/memberRelationships/{urlEncodedFsdProfileUrn}
 *       ?decorationId=com.linkedin.voyager.dash.deco.relationships.MemberRelationshipV2
 *
 * The response is a single resolved record whose `$type` indicates the
 * relationship:
 *   com.linkedin.voyager.dash.relationships.Connection    → 1st-degree
 *   com.linkedin.voyager.dash.relationships.NoConnection  → not connected
 *   …Invitation / NoInvitation                            → pending state
 */
import type { LinkedInApiClient } from "../client.js";

const BASE = "https://www.linkedin.com/voyager/api/relationships/dash/memberRelationships";
const RECIPE = "com.linkedin.voyager.dash.deco.relationships.MemberRelationshipV2";

export type RelationshipKind =
  | "connection"
  | "no_connection"
  | "invitation"
  | "no_invitation"
  | "unknown";

export interface RelationshipResult {
  kind: RelationshipKind;
  /** True iff `kind === "connection"` — convenience for callers. */
  isFirstDegree: boolean;
  /** The raw `$type` from the resolved record, useful for diagnostics. */
  rawType: string | null;
}

interface RelationshipRaw {
  data?: { ["*memberRelationship"]?: string; memberRelationship?: { $type?: string } };
  included?: Array<{ entityUrn?: string; $type?: string }>;
  // Some surfaces return the record directly without normalization.
  $type?: string;
  memberRelationship?: { $type?: string };
}

/** Look up our relationship to a profile (by `urn:li:fsd_profile:<id>`).
 *
 *  We deliberately do NOT URL-encode the colons in the URN path segment —
 *  voyager's router matches the raw rest.li URN form (`urn:li:fsd_profile:<id>`),
 *  not the percent-encoded one. */
export async function getMemberRelationship(
  client: LinkedInApiClient,
  profileUrn: string
): Promise<RelationshipResult> {
  // Try alternate path forms in order. LinkedIn's router has varied over time
  // between requiring the bare id and the full URN; both are observed in the
  // checked-in JS bundles.
  const id = profileUrn.replace(/^urn:li:fsd_profile:/, "");
  const candidates = [
    `${BASE}/${encodeURIComponent(profileUrn)}?recipe=${RECIPE}`,
    `${BASE}/${profileUrn}?recipe=${RECIPE}`,
    `${BASE}/${id}?recipe=${RECIPE}`,
  ];
  let lastErr: unknown = null;
  for (const url of candidates) {
    try {
      const resp = await client.request<RelationshipRaw>({ method: "GET", url });
      return parseRelationship(resp);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export function parseRelationship(resp: RelationshipRaw): RelationshipResult {
  // Try the normalized form: data["*memberRelationship"] -> ref into `included`.
  let rawType: string | null = null;
  const ref = resp.data?.["*memberRelationship"];
  if (typeof ref === "string" && resp.included) {
    const hit = resp.included.find((i) => i.entityUrn === ref);
    if (hit?.$type) rawType = hit.$type;
  }
  // Inline non-normalized form.
  if (!rawType) rawType = resp.data?.memberRelationship?.$type ?? null;
  if (!rawType) rawType = resp.memberRelationship?.$type ?? null;
  if (!rawType) rawType = resp.$type ?? null;
  // As a fallback, scan `included` for any Connection/NoConnection entry.
  if (!rawType && resp.included) {
    const knownRel = resp.included.find(
      (i) =>
        typeof i.$type === "string" &&
        /\.relationships\.(Connection|NoConnection|Invitation|NoInvitation)$/.test(i.$type)
    );
    if (knownRel?.$type) rawType = knownRel.$type;
  }
  return { kind: classify(rawType), isFirstDegree: classify(rawType) === "connection", rawType };
}

function classify(rawType: string | null): RelationshipKind {
  if (!rawType) return "unknown";
  if (rawType.endsWith(".Connection")) return "connection";
  if (rawType.endsWith(".NoConnection")) return "no_connection";
  if (rawType.endsWith(".Invitation")) return "invitation";
  if (rawType.endsWith(".NoInvitation")) return "no_invitation";
  return "unknown";
}
