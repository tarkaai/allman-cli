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

/**
 * Look up a LinkedIn profile URN from a public profile identifier (slug).
 * Returns null if the profile is not found or accessible.
 */
export async function getProfileUrnBySlug(
  client: LinkedInApiClient,
  slug: string
): Promise<string | null> {
  // Variables passed raw — only URN values inside are encoded.
  // Format matches monorepo: variables=(memberIdentity:slug)&queryId=...
  const variables = `(memberIdentity:${slug})`;

  try {
    const response = await client.request<ProfileQueryResponse>({
      method: "GET",
      url: `${GRAPHQL_URL}?variables=${variables}&queryId=${PROFILE_QUERY_ID}`,
    });

    // The URN is often in the '*elements' array as a reference string
    const profileData =
      response?.data?.data?.identityDashProfilesByMemberIdentity;

    if (!profileData) return null;

    // Try direct element URN first
    const elements = profileData.elements;
    if (elements && elements.length > 0 && elements[0]?.entityUrn) {
      return extractProfileUrn(elements[0].entityUrn);
    }

    // Fall back to '*elements' reference array
    const refs = (profileData as Record<string, unknown>)["*elements"];
    if (Array.isArray(refs) && refs.length > 0) {
      const ref = String(refs[0]);
      return extractProfileUrn(ref);
    }

    return null;
  } catch {
    return null;
  }
}

const PROFILE_REST_URL =
  "https://www.linkedin.com/voyager/api/identity/dash/profiles";
const PROFILE_DECORATION =
  "com.linkedin.voyager.dash.deco.identity.profile.WebTopCardCore-16";

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
    const included = response?.["included"] as Array<Record<string, unknown>> | undefined;
    if (included) {
      for (const item of included) {
        const pubId = item["publicIdentifier"];
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
  if (!match || !match[1]) return null;
  return `urn:li:fsd_profile:${match[1]}`;
}
