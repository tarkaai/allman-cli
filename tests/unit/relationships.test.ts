import { describe, expect, it } from "vitest";
import { parseRelationship } from "../../src/linkedin/api/endpoints/relationships.js";

const TARGET_URN = "urn:li:fsd_profile:ACoAAB0000000000000000000000000000000099";
const REL_URN = "urn:li:fsd_memberRelationship:ACoAAB0000000000000000000000000000000099";

describe("parseRelationship", () => {
  it("treats Connection as 1st-degree", () => {
    const r = parseRelationship({
      data: { ["*memberRelationship"]: REL_URN },
      included: [
        { entityUrn: REL_URN, $type: "com.linkedin.voyager.dash.relationships.Connection" },
      ],
    });
    expect(r.kind).toBe("connection");
    expect(r.isFirstDegree).toBe(true);
    expect(r.rawType).toBe("com.linkedin.voyager.dash.relationships.Connection");
  });

  it("treats NoConnection as not 1st-degree", () => {
    const r = parseRelationship({
      data: { ["*memberRelationship"]: REL_URN },
      included: [
        { entityUrn: REL_URN, $type: "com.linkedin.voyager.dash.relationships.NoConnection" },
      ],
    });
    expect(r.kind).toBe("no_connection");
    expect(r.isFirstDegree).toBe(false);
  });

  it("treats Invitation as a separate kind", () => {
    const r = parseRelationship({
      data: { ["*memberRelationship"]: REL_URN },
      included: [
        {
          entityUrn: REL_URN,
          $type: "com.linkedin.voyager.dash.relationships.invitation.Invitation",
        },
      ],
    });
    expect(r.kind).toBe("invitation");
    expect(r.isFirstDegree).toBe(false);
  });

  it("handles inline non-normalized shape", () => {
    const r = parseRelationship({
      data: { memberRelationship: { $type: "com.linkedin.voyager.dash.relationships.Connection" } },
    });
    expect(r.kind).toBe("connection");
    expect(r.isFirstDegree).toBe(true);
  });

  it("falls back to scanning `included` for a relationship type", () => {
    const r = parseRelationship({
      included: [
        // unrelated entry
        {
          entityUrn: "urn:li:fsd_profile:other",
          $type: "com.linkedin.voyager.dash.identity.profile.Profile",
        },
        // the relationship entry
        { entityUrn: REL_URN, $type: "com.linkedin.voyager.dash.relationships.Connection" },
      ],
    });
    expect(r.kind).toBe("connection");
    expect(r.isFirstDegree).toBe(true);
    expect(TARGET_URN).toBeTruthy(); // touch unused symbol to keep imports tidy
  });

  it("returns 'unknown' when nothing parses", () => {
    const r = parseRelationship({});
    expect(r.kind).toBe("unknown");
    expect(r.isFirstDegree).toBe(false);
    expect(r.rawType).toBeNull();
  });
});
