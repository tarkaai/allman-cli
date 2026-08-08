/**
 * Unit tests for the full-profile parser (identity/dash/profiles → ProfileDetail).
 *
 * All ids/slugs/names below are synthetic placeholders — they intentionally do
 * not correspond to any real LinkedIn profile.
 */
import { describe, expect, it } from "vitest";
import { parseProfileDetail } from "@/linkedin/api/endpoints/profile-detail.js";

const PROFILE_URN = "urn:li:fsd_profile:ACoSYNTH0000000000000000000000000000001";
const GEO_URN = "urn:li:fsd_geo:100";

const P = "com.linkedin.voyager.dash.identity.profile.";

function profileEntry(extra: Record<string, unknown> = {}) {
  return {
    $type: `${P}Profile`,
    entityUrn: PROFILE_URN,
    publicIdentifier: "Synthetic-User",
    firstName: "Syn",
    lastName: "Thetic",
    headline: "Builder of synthetic things",
    summary: "About me: I test parsers.",
    ...extra,
  };
}

describe("parseProfileDetail", () => {
  it("returns null when there is no Profile record", () => {
    expect(parseProfileDetail({ included: [] })).toBeNull();
    expect(parseProfileDetail({})).toBeNull();
  });

  it("extracts core fields and current title/company from the current position", () => {
    const resp = {
      included: [
        profileEntry({ geoLocationName: "San Francisco Bay Area" }),
        {
          $type: `${P}Position`,
          entityUrn: "urn:li:fsd_position:1",
          title: "Old Role",
          companyName: "Previous Co",
          dateRange: { start: { year: 2018 }, end: { year: 2021 } },
        },
        {
          $type: `${P}Position`,
          entityUrn: "urn:li:fsd_position:2",
          title: "Staff Engineer",
          companyName: "Current Co",
          dateRange: { start: { year: 2021 } }, // no end → current
        },
      ],
    };
    const d = parseProfileDetail(resp);
    expect(d).not.toBeNull();
    expect(d?.urn).toBe(PROFILE_URN);
    expect(d?.publicIdentifier).toBe("synthetic-user"); // lowercased
    expect(d?.firstName).toBe("Syn");
    expect(d?.headline).toBe("Builder of synthetic things");
    expect(d?.about).toBe("About me: I test parsers.");
    expect(d?.location).toBe("San Francisco Bay Area");
    // current role wins over the older one
    expect(d?.title).toBe("Staff Engineer");
    expect(d?.company).toBe("Current Co");
    // core mode does not populate the arrays
    expect(d?.positions).toEqual([]);
    expect(d?.education).toEqual([]);
    expect(d?.skills).toEqual([]);
  });

  it("falls back to the first position when none is marked current", () => {
    const resp = {
      included: [
        profileEntry(),
        {
          $type: `${P}Position`,
          entityUrn: "urn:li:fsd_position:1",
          title: "First Listed",
          companyName: "Co A",
          dateRange: { start: { year: 2019 }, end: { year: 2020 } },
        },
      ],
    };
    const d = parseProfileDetail(resp);
    expect(d?.title).toBe("First Listed");
    expect(d?.company).toBe("Co A");
  });

  it("resolves location from a *geoLocation reference in included", () => {
    const resp = {
      included: [
        profileEntry({ "*geoLocation": GEO_URN }),
        {
          $type: "com.linkedin.voyager.dash.common.Geo",
          entityUrn: GEO_URN,
          defaultLocalizedName: "Berlin, Germany",
        },
      ],
    };
    expect(parseProfileDetail(resp)?.location).toBe("Berlin, Germany");
  });

  it("handles {text}-wrapped fields", () => {
    const resp = {
      included: [
        {
          $type: `${P}Profile`,
          entityUrn: PROFILE_URN,
          firstName: { text: "Wrapped" },
          lastName: { text: "Name" },
          headline: { text: "Wrapped headline" },
        },
      ],
    };
    const d = parseProfileDetail(resp);
    expect(d?.firstName).toBe("Wrapped");
    expect(d?.headline).toBe("Wrapped headline");
  });

  it("populates positions, education, and skills only in deep mode", () => {
    const resp = {
      included: [
        profileEntry(),
        {
          $type: `${P}Position`,
          entityUrn: "urn:li:fsd_position:2",
          title: "Staff Engineer",
          companyName: "Current Co",
          dateRange: { start: { year: 2021 } },
        },
        {
          $type: `${P}Education`,
          entityUrn: "urn:li:fsd_education:1",
          schoolName: "Test University",
          degreeName: "BSc",
        },
        { $type: `${P}Skill`, entityUrn: "urn:li:fsd_skill:1", name: "TypeScript" },
        { $type: `${P}Skill`, entityUrn: "urn:li:fsd_skill:2", name: "Distributed Systems" },
      ],
    };
    const deep = parseProfileDetail(resp, { deep: true });
    expect(deep?.positions).toEqual([
      { title: "Staff Engineer", company: "Current Co", current: true },
    ]);
    expect(deep?.education).toEqual([{ school: "Test University", degree: "BSc" }]);
    expect(deep?.skills).toEqual(["TypeScript", "Distributed Systems"]);

    const core = parseProfileDetail(resp, { deep: false });
    expect(core?.positions).toEqual([]);
    expect(core?.skills).toEqual([]);
  });

  it("does not confuse MiniProfile with the full Profile record", () => {
    const resp = {
      included: [
        { $type: `${P}MiniProfile`, entityUrn: PROFILE_URN, firstName: "Mini" },
        profileEntry({ firstName: "Full" }),
      ],
    };
    expect(parseProfileDetail(resp)?.firstName).toBe("Full");
  });
});
