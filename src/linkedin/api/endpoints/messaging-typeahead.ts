/**
 * Messaging compose typeahead — the lookup behind linkedin.com's "New message"
 * recipient box. Returns people the viewer can message (connections,
 * coworkers), with name, degree, headline and picture. No slug: callers map
 * the profile URN to a slug via the local store or `getProfileSlugById`.
 *
 *   GET /voyager/api/voyagerMessagingDashMessagingTypeahead
 *       ?q=typeaheadKeyword&keyword=<text>&types=List(CONNECTIONS,COWORKERS)
 *
 * Response: data.elements[].targetEntityViewModel{ entityUnion.profile,
 *   title.text ("Jane Roe • 1st"), subtitle.text (headline), image… }
 */
import type { LinkedInApiClient } from "../client.js";
import { bestImageUrl } from "./profile-detail.js";

const TYPEAHEAD_URL = "https://www.linkedin.com/voyager/api/voyagerMessagingDashMessagingTypeahead";

export type TypeaheadType = "CONNECTIONS" | "COWORKERS" | "GROUP_THREADS";

export interface TypeaheadHit {
  /** urn:li:fsd_profile:<id> */
  profileUrn: string;
  profileId: string;
  name: string;
  /** DISTANCE_1 … from the "• 1st" suffix, or null. */
  distance: string | null;
  headline: string | null;
  imageUrl: string | null;
}

interface RawText {
  text?: string;
}
interface RawElement {
  targetEntityViewModel?: {
    entityUnion?: { profile?: string; conversation?: string };
    title?: RawText;
    subtitle?: RawText;
    image?: {
      attributes?: Array<{
        detailDataUnion?: { nonEntityProfilePicture?: { vectorImage?: unknown } };
      }>;
    };
  };
}
interface RawResponse {
  data?: { elements?: RawElement[] };
  elements?: RawElement[];
}

export async function searchMessagingTypeahead(
  client: LinkedInApiClient,
  keyword: string,
  types: TypeaheadType[] = ["CONNECTIONS", "COWORKERS"]
): Promise<TypeaheadHit[]> {
  const url =
    `${TYPEAHEAD_URL}?q=typeaheadKeyword&keyword=${encodeURIComponent(keyword)}` +
    `&types=List(${types.join(",")})`;
  const raw = await client.request<RawResponse>({ method: "GET", url });
  return parseMessagingTypeahead(raw);
}

/** Pure parser — exposed for unit tests. Skips group threads (no profile). */
export function parseMessagingTypeahead(raw: RawResponse): TypeaheadHit[] {
  const elements = raw.data?.elements ?? raw.elements ?? [];
  const hits: TypeaheadHit[] = [];
  for (const el of elements) {
    const t = el.targetEntityViewModel;
    const profileUrn = t?.entityUnion?.profile;
    if (!profileUrn) continue;
    const titleText = t?.title?.text ?? "";
    const { name, distance } = splitTitle(titleText);
    if (!name) continue;
    const vector = t?.image?.attributes?.[0]?.detailDataUnion?.nonEntityProfilePicture?.vectorImage;
    hits.push({
      profileUrn,
      profileId: profileUrn.replace("urn:li:fsd_profile:", ""),
      name,
      distance,
      headline: t?.subtitle?.text?.trim() || null,
      imageUrl: vector ? bestImageUrl(vector) : null,
    });
  }
  return hits;
}

/** "Jane Roe • 1st" → { name: "Jane Roe", distance: "DISTANCE_1" }. */
export function splitTitle(text: string): { name: string; distance: string | null } {
  const m = /^(.*?)\s*[•·]\s*([123])(?:st|nd|rd)\s*$/.exec(text);
  if (m) return { name: (m[1] ?? "").trim(), distance: `DISTANCE_${m[2]}` };
  return { name: text.trim(), distance: null };
}
