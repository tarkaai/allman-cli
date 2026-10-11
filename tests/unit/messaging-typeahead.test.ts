/**
 * Parser for the messaging compose typeahead. Shape mirrors a live
 * `voyagerMessagingDashMessagingTypeahead` response with synthetic ids.
 */
import { describe, expect, it } from "vitest";
import {
  parseMessagingTypeahead,
  splitTitle,
} from "@/linkedin/api/endpoints/messaging-typeahead.js";

const PROFILE = "urn:li:fsd_profile:ACoSYNTHHIT000000000000000000000001";

function element(title: string, subtitle: string, withImage = true) {
  return {
    targetEntityViewModel: {
      entityUnion: { profile: PROFILE },
      title: { text: title },
      subtitle: { text: subtitle },
      image: withImage
        ? {
            attributes: [
              {
                detailDataUnion: {
                  nonEntityProfilePicture: {
                    profileUrn: PROFILE,
                    vectorImage: {
                      rootUrl:
                        "https://media.example/dms/image/v2/SYNTH/profile-displayphoto-shrink_",
                      artifacts: [
                        { width: 100, height: 100, fileIdentifyingUrlPathSegment: "100_100/x?e=1" },
                        { width: 400, height: 400, fileIdentifyingUrlPathSegment: "400_400/x?e=1" },
                      ],
                    },
                  },
                },
              },
            ],
          }
        : undefined,
    },
  };
}

describe("parseMessagingTypeahead", () => {
  it("extracts profile, name, degree, headline and picture", () => {
    const hits = parseMessagingTypeahead({
      data: { elements: [element("Jane Roe • 1st", "Robotics Lab Manager")] },
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      profileUrn: PROFILE,
      profileId: "ACoSYNTHHIT000000000000000000000001",
      name: "Jane Roe",
      distance: "DISTANCE_1",
      headline: "Robotics Lab Manager",
    });
    expect(hits[0]?.imageUrl).toContain("https://media.example/");
  });

  it("skips group threads and tolerates missing fields", () => {
    const hits = parseMessagingTypeahead({
      data: {
        elements: [
          {
            targetEntityViewModel: {
              entityUnion: { conversation: "urn:li:msg_conversation:x" },
              title: { text: "Team chat" },
            },
          },
          element("Solo Person", "", false),
        ],
      },
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.name).toBe("Solo Person");
    expect(hits[0]?.distance).toBeNull();
    expect(hits[0]?.headline).toBeNull();
    expect(hits[0]?.imageUrl).toBeNull();
  });
});

describe("splitTitle", () => {
  it("handles each degree marker and plain names", () => {
    expect(splitTitle("A B • 2nd")).toEqual({ name: "A B", distance: "DISTANCE_2" });
    expect(splitTitle("A B · 3rd")).toEqual({ name: "A B", distance: "DISTANCE_3" });
    expect(splitTitle("Plain Name")).toEqual({ name: "Plain Name", distance: null });
  });
});
