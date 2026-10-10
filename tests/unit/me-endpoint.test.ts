/**
 * `getMyProfile` parses voyager/api/me defensively: miniProfile shape first,
 * any fsd_profile URN in the body as a fallback, null on garbage or errors.
 * All ids are synthetic.
 */
import { describe, expect, it, vi } from "vitest";
import type { LinkedInApiClient } from "@/linkedin/api/client.js";
import { getMyProfile } from "@/linkedin/api/endpoints/profiles.js";

const ID = "ACoSYNTH00000000000000000000000000000ME";

function clientReturning(body: unknown, reject = false): LinkedInApiClient {
  const request = reject
    ? vi.fn().mockRejectedValue(new Error("403"))
    : vi.fn().mockResolvedValue(body);
  return { request } as unknown as LinkedInApiClient;
}

describe("getMyProfile", () => {
  it("reads the miniProfile shape", async () => {
    const me = await getMyProfile(
      clientReturning({
        plainId: 1,
        miniProfile: {
          entityUrn: `urn:li:fs_miniProfile:${ID}`,
          publicIdentifier: "Synth-Person",
          firstName: "Synth",
          lastName: "Person",
        },
      })
    );
    expect(me).toEqual({
      urn: `urn:li:fsd_profile:${ID}`,
      publicIdentifier: "synth-person",
      firstName: "Synth",
      lastName: "Person",
    });
  });

  it("falls back to any fsd_profile urn in the body", async () => {
    const me = await getMyProfile(
      clientReturning({ included: [{ entityUrn: `urn:li:fsd_profile:${ID}`, other: 1 }] })
    );
    expect(me?.urn).toBe(`urn:li:fsd_profile:${ID}`);
    expect(me?.publicIdentifier).toBeNull();
  });

  it("returns null on an unrecognizable body or a failed request", async () => {
    expect(await getMyProfile(clientReturning({ hello: "world" }))).toBeNull();
    expect(await getMyProfile(clientReturning(null))).toBeNull();
    expect(await getMyProfile(clientReturning({}, true))).toBeNull();
    const request = vi.fn().mockResolvedValue({});
    await getMyProfile({ request } as unknown as LinkedInApiClient);
    expect(request).toHaveBeenCalledWith({
      method: "GET",
      url: "https://www.linkedin.com/voyager/api/me",
    });
  });
});
