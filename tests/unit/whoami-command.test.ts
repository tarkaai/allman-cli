/**
 * `allman whoami` — own profile via the dash profiles endpoint, folded into the
 * AUTH.json field names.
 */
import { describe, expect, it, vi } from "vitest";
import { fetchOwnProfile } from "@/commands/whoami.js";
import type { LinkedInApiClient } from "@/linkedin/api/client.js";

const ID = "ACoSYNTHME000000000000000000000000001";

function profileResponse(overrides: Record<string, unknown> = {}) {
  return {
    included: [
      {
        $type: "com.linkedin.voyager.dash.identity.profile.Profile",
        entityUrn: `urn:li:fsd_profile:${ID}`,
        publicIdentifier: "Jamie-Rivera",
        firstName: "Jamie",
        lastName: "Rivera",
        headline: "Builder of things",
        profilePicture: {
          displayImageReference: {
            vectorImage: {
              rootUrl: "https://media.licdn.com/dms/image/x/",
              artifacts: [
                { width: 100, fileIdentifyingUrlPathSegment: "100.jpg" },
                { width: 400, fileIdentifyingUrlPathSegment: "400.jpg" },
              ],
            },
          },
        },
        ...overrides,
      },
    ],
  };
}

describe("fetchOwnProfile", () => {
  it("maps the dash profile onto AUTH.json fields, largest photo wins", async () => {
    const request = vi
      .fn()
      .mockImplementation(async ({ url }: { url: string }) =>
        url.includes("/profiles?") ? profileResponse() : {}
      );
    const own = await fetchOwnProfile({ request } as unknown as LinkedInApiClient, ID);
    expect(own).toEqual({
      profileSlug: "jamie-rivera",
      name: "Jamie Rivera",
      headline: "Builder of things",
      profileUrl: "https://www.linkedin.com/in/jamie-rivera/",
      imageUrl: "https://media.licdn.com/dms/image/x/400.jpg",
    });
    expect(request.mock.calls[0]?.[0].url).toContain(`memberIdentity=${ID}`);
  });

  it("tolerates a profile without photo or slug", async () => {
    const request = vi
      .fn()
      .mockImplementation(async ({ url }: { url: string }) =>
        url.includes("/profiles?")
          ? profileResponse({ profilePicture: undefined, publicIdentifier: undefined })
          : {}
      );
    const own = await fetchOwnProfile({ request } as unknown as LinkedInApiClient, ID);
    expect(own?.name).toBe("Jamie Rivera");
    expect(own?.profileSlug).toBeNull();
    expect(own?.profileUrl).toBeNull();
    expect(own?.imageUrl).toBeNull();
  });

  it("returns null when LinkedIn has no profile record", async () => {
    const request = vi.fn().mockResolvedValue({ included: [] });
    expect(await fetchOwnProfile({ request } as unknown as LinkedInApiClient, ID)).toBeNull();
  });
});
