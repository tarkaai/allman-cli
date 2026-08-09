/**
 * Unit tests for the profile parsers (core + positions/education/skills).
 *
 * Shapes here mirror real responses recorded from the live API (via ALLMAN_VCR),
 * but all ids/slugs/names are synthetic placeholders — they intentionally do not
 * correspond to any real LinkedIn profile.
 */
import { describe, expect, it } from "vitest";
import {
  parseEducations,
  parsePositions,
  parseProfileCore,
  parseSkills,
  pickPrimaryPosition,
} from "@/linkedin/api/endpoints/profile-detail.js";

const PROFILE_URN = "urn:li:fsd_profile:ACoSYNTH0000000000000000000000000000001";
const GEO_COUNTRY = "urn:li:fsd_geo:103644278";
const GEO_METRO = "urn:li:fsd_geo:90000064";

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

const geo = (urn: string, name: string) => ({
  $type: "com.linkedin.voyager.dash.common.Geo",
  entityUrn: urn,
  defaultLocalizedName: name,
});

describe("parseProfileCore", () => {
  it("returns null when there is no Profile record", () => {
    expect(parseProfileCore({ included: [] })).toBeNull();
    expect(parseProfileCore({})).toBeNull();
  });

  it("extracts the core fields", () => {
    const d = parseProfileCore({ included: [profileEntry()] });
    expect(d?.urn).toBe(PROFILE_URN);
    expect(d?.publicIdentifier).toBe("synthetic-user"); // lowercased
    expect(d?.firstName).toBe("Syn");
    expect(d?.headline).toBe("Builder of synthetic things");
    expect(d?.about).toBe("About me: I test parsers.");
  });

  it("resolves location through geoLocation['*geo'] and NOT the country Geo", () => {
    // Regression: the live graph carries both a country-level and a metro-level
    // Geo. Falling back to "first Geo in the graph" silently downgraded the
    // location to "United States".
    const d = parseProfileCore({
      included: [
        profileEntry({ geoLocation: { "*geo": GEO_METRO }, location: { countryCode: "US" } }),
        geo(GEO_COUNTRY, "United States"),
        geo(GEO_METRO, "Austin, Texas Metropolitan Area"),
      ],
    });
    expect(d?.location).toBe("Austin, Texas Metropolitan Area");
  });

  it("does not guess a location when there is no geo reference", () => {
    const d = parseProfileCore({
      included: [
        profileEntry({ location: { countryCode: "US" } }),
        geo(GEO_COUNTRY, "United States"),
      ],
    });
    expect(d?.location).toBeNull();
  });

  it("prefers a plain geoLocationName when present", () => {
    const d = parseProfileCore({
      included: [profileEntry({ geoLocationName: "Berlin, Germany" }), geo(GEO_COUNTRY, "Germany")],
    });
    expect(d?.location).toBe("Berlin, Germany");
  });

  it("handles {text}-wrapped fields", () => {
    const d = parseProfileCore({
      included: [
        {
          $type: `${P}Profile`,
          entityUrn: PROFILE_URN,
          firstName: { text: "Wrapped" },
          headline: { text: "Wrapped headline" },
        },
      ],
    });
    expect(d?.firstName).toBe("Wrapped");
    expect(d?.headline).toBe("Wrapped headline");
  });

  it("does not confuse MiniProfile with the full Profile record", () => {
    const d = parseProfileCore({
      included: [
        { $type: `${P}MiniProfile`, entityUrn: PROFILE_URN, firstName: "Mini" },
        profileEntry({ firstName: "Full" }),
      ],
    });
    expect(d?.firstName).toBe("Full");
  });
});

describe("parsePositions", () => {
  const position = (title: string, company: string, end?: Record<string, number>) => ({
    $type: `${P}Position`,
    entityUrn: `urn:li:fsd_position:${title}`,
    title,
    companyName: company,
    dateRange: { start: { month: 1, year: 2020 }, ...(end ? { end } : {}) },
  });

  it("parses title/company and marks an open-ended role current", () => {
    const positions = parsePositions({
      included: [
        position("Staff Engineer", "Current Co"),
        position("Intern", "Old Co", { month: 5, year: 2019 }),
      ],
    });
    expect(positions).toEqual([
      { title: "Staff Engineer", company: "Current Co", current: true },
      { title: "Intern", company: "Old Co", current: false },
    ]);
  });

  it("returns [] when the response carries no positions", () => {
    expect(parsePositions({ included: [] })).toEqual([]);
    expect(parsePositions({})).toEqual([]);
  });

  it("honors data['*elements'] display order over included[] order", () => {
    // Regression: `included[]` is unordered. A person with several concurrent
    // roles (CTO at one company, venture partner at another) reported the wrong
    // "current" role when we trusted included[] order.
    const cto = position("CTO", "Main Co");
    const partner = position("Venture Partner", "Side Co");
    const resp = {
      // included lists the side role first...
      included: [partner, cto],
      // ...but the profile displays the CTO role first.
      data: { "*elements": [cto.entityUrn, partner.entityUrn] },
    };
    const positions = parsePositions(resp);
    expect(positions.map((p) => p.company)).toEqual(["Main Co", "Side Co"]);
    expect(pickPrimaryPosition(positions)?.company).toBe("Main Co");
  });

  it("falls back to included[] order when refs are missing or unresolvable", () => {
    const a = position("First", "A Co");
    expect(parsePositions({ included: [a] }).map((p) => p.company)).toEqual(["A Co"]);
    expect(
      parsePositions({ included: [a], data: { "*elements": ["urn:li:fsd_position:nope"] } }).map(
        (p) => p.company
      )
    ).toEqual(["A Co"]);
  });
});

describe("pickPrimaryPosition", () => {
  const p = (title: string, current: boolean) => ({ title, company: "Co", current });

  it("prefers a current role over an earlier one", () => {
    expect(pickPrimaryPosition([p("Old", false), p("Now", true)])?.title).toBe("Now");
  });

  it("falls back to the first listed when none is current", () => {
    expect(pickPrimaryPosition([p("Most recent", false), p("Older", false)])?.title).toBe(
      "Most recent"
    );
  });

  it("returns null for an empty history", () => {
    expect(pickPrimaryPosition([])).toBeNull();
  });
});

describe("parseEducations / parseSkills", () => {
  it("parses education entries", () => {
    expect(
      parseEducations({
        included: [
          {
            $type: `${P}Education`,
            entityUrn: "urn:li:fsd_education:1",
            schoolName: "Test University",
            degreeName: "Bachelor of Science - BS",
          },
        ],
      })
    ).toEqual([{ school: "Test University", degree: "Bachelor of Science - BS" }]);
  });

  it("parses skill names and drops unnamed entries", () => {
    expect(
      parseSkills({
        included: [
          { $type: `${P}Skill`, entityUrn: "urn:li:fsd_skill:1", name: "TypeScript" },
          { $type: `${P}Skill`, entityUrn: "urn:li:fsd_skill:2" },
          { $type: `${P}Skill`, entityUrn: "urn:li:fsd_skill:3", name: "AWS Lambda" },
        ],
      })
    ).toEqual(["TypeScript", "AWS Lambda"]);
  });
});
