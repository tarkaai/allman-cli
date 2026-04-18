/**
 * LinkedIn profile API endpoints.
 *
 * Used to:
 *   - Look up a profile URN from a public LinkedIn identifier (slug)
 *   - Fetch basic profile data during login
 *
 * GraphQL query ID:
 *   voyagerIdentityDashProfiles.b5c27c04968c409fc0ed3546575b9b7a
 *
 * Source: monorepo/lib/services/.../linkedin-api-services.ts
 */

import type { LinkedInApiClient } from "../client.js";

const GRAPHQL_URL = "https://www.linkedin.com/voyager/api/graphql";
const PROFILE_QUERY_ID = "voyagerIdentityDashProfiles.b5c27c04968c409fc0ed3546575b9b7a";

export interface ProfileData {
  urn: string;
  name: string | null;
  headline: string | null;
  profileUrl: string | null;
  imageUrl: string | null;
  userType: "basic" | "sales_nav" | null;
  networkSize: number | null;
}

interface ProfileQueryResponse {
  data?: {
    data?: {
      identityDashProfilesByMemberIdentity?: {
        "*elements"?: string[];
        elements?: Array<{
          entityUrn?: string;
          firstName?: { text?: string };
          lastName?: { text?: string };
          headline?: { text?: string };
          profilePicture?: {
            displayImageReference?: {
              vectorImage?: {
                artifacts?: Array<{ fileIdentifyingUrlPathSegment?: string }>;
                rootUrl?: string;
              };
            };
          };
        }>;
      };
    };
    included?: Array<{ entityUrn?: string; [key: string]: unknown }>;
  };
}

export interface BasicProfileData {
  urn: string;
  firstName: string | null;
  lastName: string | null;
  headline: string | null;
}

/**
 * Look up a LinkedIn profile URN and basic name data from a public profile identifier (slug).
 * Returns null if the profile is not found or accessible.
 */
export async function getProfileDataBySlug(
  client: LinkedInApiClient,
  slug: string
): Promise<BasicProfileData | null> {
  const variables = `(memberIdentity:${slug})`;

  try {
    const response = await client.request<ProfileQueryResponse>({
      method: "GET",
      url: `${GRAPHQL_URL}?variables=${variables}&queryId=${PROFILE_QUERY_ID}`,
    });

    const profileData = response?.data?.data?.identityDashProfilesByMemberIdentity;

    if (!profileData) return null;

    // Try direct elements first (non-normalized response)
    const elements = profileData.elements;
    const el = elements?.[0];
    if (el?.entityUrn) {
      const urn = extractProfileUrn(el.entityUrn);
      if (!urn) return null;
      return {
        urn,
        firstName: el.firstName?.text ?? null,
        lastName: el.lastName?.text ?? null,
        headline: el.headline?.text ?? null,
      };
    }

    // Normalized format: *elements refs + included array
    const refs = (profileData as Record<string, unknown>)["*elements"];
    if (Array.isArray(refs) && refs.length > 0) {
      const ref = String(refs[0]);
      const urn = extractProfileUrn(ref);
      if (!urn) return null;

      // Look up name/headline from included
      const included = response?.data?.included ?? [];
      const item = included.find((i) => i.entityUrn && extractProfileUrn(i.entityUrn) === urn);
      return {
        urn,
        firstName: (item?.firstName as { text?: string } | undefined)?.text ?? null,
        lastName: (item?.lastName as { text?: string } | undefined)?.text ?? null,
        headline: (item?.headline as { text?: string } | undefined)?.text ?? null,
      };
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Look up a LinkedIn profile URN from a public profile identifier (slug).
 * Returns null if the profile is not found or accessible.
 */
export async function getProfileUrnBySlug(
  client: LinkedInApiClient,
  slug: string
): Promise<string | null> {
  const data = await getProfileDataBySlug(client, slug);
  return data?.urn ?? null;
}

const PROFILE_REST_URL = "https://www.linkedin.com/voyager/api/identity/dash/profiles";
const PROFILE_DECORATION = "com.linkedin.voyager.dash.deco.identity.profile.WebTopCardCore-16";

/**
 * Look up a LinkedIn profile's public slug (publicIdentifier) from a profile ID.
 * Uses the REST identity/dash/profiles endpoint which returns publicIdentifier
 * in the included array.
 * Returns the slug (e.g. "alice-smith") or null if not resolvable.
 */
export async function getProfileSlugById(
  client: LinkedInApiClient,
  profileId: string
): Promise<string | null> {
  try {
    const response = await client.request<Record<string, unknown>>({
      method: "GET",
      url: `${PROFILE_REST_URL}?q=memberIdentity&memberIdentity=${profileId}&decorationId=${PROFILE_DECORATION}`,
    });

    // publicIdentifier appears in the included array
    const included = response?.included as Array<Record<string, unknown>> | undefined;
    if (included) {
      for (const item of included) {
        const pubId = item.publicIdentifier;
        if (typeof pubId === "string" && pubId.length > 0) {
          return pubId.toLowerCase();
        }
      }
    }

    return null;
  } catch {
    return null;
  }
}

/** Extract urn:li:fsd_profile:{id} from a string that may be the full URN or contain it. */
function extractProfileUrn(value: string): string | null {
  const match = value.match(/urn:li:fsd_profile:([^,)]+)/);
  if (!match?.[1]) return null;
  return `urn:li:fsd_profile:${match[1]}`;
}
