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

  it("captures the numeric member id from objectUrn", () => {
    // objectUrn is the only place the flagship profile surface exposes
    // `urn:li:member:<n>` — the id Sales Navigator keys on, and therefore the
    // only join between the two backends.
    const d = parseProfileCore({
      included: [profileEntry({ objectUrn: "urn:li:member:375843124" })],
    });
    expect(d?.objectUrn).toBe("urn:li:member:375843124");
    expect(d?.memberId).toBe("375843124");
  });

  it("leaves member ids null when objectUrn is absent", () => {
    const d = parseProfileCore({ included: [profileEntry()] });
    expect(d?.objectUrn).toBeNull();
    expect(d?.memberId).toBeNull();
  });

  it("resolves the industry label through the *industry reference", () => {
    const d = parseProfileCore({
      included: [
        profileEntry({ "*industry": "urn:li:fsd_industry:11" }),
        {
          $type: "com.linkedin.voyager.dash.common.Industry",
          entityUrn: "urn:li:fsd_industry:11",
          name: "Management Consulting",
        },
      ],
    });
    expect(d?.industry).toBe("Management Consulting");
    expect(d?.industryUrn).toBe("urn:li:fsd_industry:11");
  });

  it("does not mistake an unrelated named entity for the industry", () => {
    const d = parseProfileCore({
      included: [
        profileEntry({ "*industry": "urn:li:fsd_industry:11" }),
        // Same URN, wrong type — must not be picked up.
        {
          $type: "com.linkedin.voyager.dash.common.Geo",
          entityUrn: "urn:li:fsd_industry:11",
          name: "Nope",
        },
      ],
    });
    expect(d?.industry).toBeNull();
    expect(d?.industryUrn).toBe("urn:li:fsd_industry:11");
  });

  it("keeps the geo URN alongside the location label", () => {
    const d = parseProfileCore({
      included: [
        profileEntry({ geoLocation: { "*geo": GEO_METRO } }),
        geo(GEO_COUNTRY, "United States"),
        geo(GEO_METRO, "Austin, Texas Metropolitan Area"),
      ],
    });
    expect(d?.location).toBe("Austin, Texas Metropolitan Area");
    expect(d?.geoUrn).toBe(GEO_METRO);
  });

  it("keeps the country code, premium/memorialized flags, pronoun and locale", () => {
    const d = parseProfileCore({
      included: [
        profileEntry({
          location: { countryCode: "DE" },
          premium: true,
          memorialized: true,
          pronounUnion: { standardizedPronoun: "SHE_HER" },
          primaryLocale: { language: "en", country: "US" },
          versionTag: "3240452913",
          address: "https://cal.example/15-minute-meeting",
        }),
      ],
    });
    expect(d?.country).toBe("DE");
    expect(d?.premium).toBe(true);
    expect(d?.memorialized).toBe(true);
    expect(d?.pronoun).toBe("SHE_HER");
    expect(d?.primaryLocale).toBe("en_US");
    expect(d?.versionTag).toBe("3240452913");
    // Members routinely put a booking or site link in the address field.
    expect(d?.address).toBe("https://cal.example/15-minute-meeting");
  });

  it("defaults the flags to false and the rest to null when absent", () => {
    const d = parseProfileCore({ included: [profileEntry()] });
    expect(d?.premium).toBe(false);
    expect(d?.memorialized).toBe(false);
    expect(d?.pronoun).toBeNull();
    expect(d?.country).toBeNull();
    expect(d?.industry).toBeNull();
    expect(d?.profilePictureUrl).toBeNull();
    expect(d?.versionTag).toBeNull();
  });

  it("composes the largest profile photo URL from rootUrl + artifact segment", () => {
    const d = parseProfileCore({
      included: [
        profileEntry({
          profilePicture: {
            displayImageReference: {
              vectorImage: {
                rootUrl: "https://media.example/photo-shrink_",
                artifacts: [
                  { width: 100, height: 100, fileIdentifyingUrlPathSegment: "100_100/a.jpg" },
                  { width: 800, height: 800, fileIdentifyingUrlPathSegment: "800_800/b.jpg" },
                  { width: 200, height: 200, fileIdentifyingUrlPathSegment: "200_200/c.jpg" },
                ],
              },
            },
          },
        }),
      ],
    });
    expect(d?.profilePictureUrl).toBe("https://media.example/photo-shrink_800_800/b.jpg");
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
      {
        title: "Staff Engineer",
        company: "Current Co",
        current: true,
        companyUrn: null,
        startDate: "2020-01",
        endDate: null,
        location: null,
        description: null,
        positionUrn: "urn:li:fsd_position:Staff Engineer",
        employmentTypeUrn: null,
        geoUrn: null,
      },
      {
        title: "Intern",
        company: "Old Co",
        current: false,
        companyUrn: null,
        startDate: "2020-01",
        endDate: "2019-05",
        location: null,
        description: null,
        positionUrn: "urn:li:fsd_position:Intern",
        employmentTypeUrn: null,
        geoUrn: null,
      },
    ]);
  });

  it("keeps the company URN, dates, location and description", () => {
    const [pos] = parsePositions({
      included: [
        {
          $type: "com.linkedin.voyager.dash.identity.profile.Position",
          title: "Principal",
          companyName: "MarketBridge",
          companyUrn: "urn:li:fsd_company:11850",
          locationName: "Washington, DC, USA",
          description: "Led GTM strategy engagements.",
          dateRange: { start: { month: 3, year: 2009 }, end: { month: 6, year: 2011 } },
        },
      ],
    });
    expect(pos?.companyUrn).toBe("urn:li:fsd_company:11850");
    expect(pos?.startDate).toBe("2009-03");
    expect(pos?.endDate).toBe("2011-06");
    expect(pos?.location).toBe("Washington, DC, USA");
    expect(pos?.description).toBe("Led GTM strategy engagements.");
    expect(pos?.current).toBe(false);
  });

  it("falls back to a bare year when LinkedIn omits the month", () => {
    const [pos] = parsePositions({
      included: [
        {
          $type: "com.linkedin.voyager.dash.identity.profile.Position",
          title: "Founder",
          companyName: "Solo Co",
          dateRange: { start: { year: 2018 } },
        },
      ],
    });
    expect(pos?.startDate).toBe("2018");
    expect(pos?.endDate).toBeNull();
    expect(pos?.current).toBe(true);
  });

  it("keeps the position URN, employment type and geo URN", () => {
    const [pos] = parsePositions({
      included: [
        {
          $type: `${P}Position`,
          entityUrn: "urn:li:fsd_profilePosition:(ACoSYNTH,2401416182)",
          title: "Gesellschafter",
          companyName: "Seibert Solutions GmbH",
          companyUrn: "urn:li:fsd_company:92762681",
          employmentTypeUrn: "urn:li:fsd_employmentType:3",
          geoUrn: "urn:li:fsd_geo:102473731",
          geoLocationName: "Stuttgart, Baden-Württemberg, Deutschland",
          dateRange: { start: { month: 12, year: 2023 } },
        },
      ],
    });
    expect(pos?.positionUrn).toBe("urn:li:fsd_profilePosition:(ACoSYNTH,2401416182)");
    expect(pos?.employmentTypeUrn).toBe("urn:li:fsd_employmentType:3");
    expect(pos?.geoUrn).toBe("urn:li:fsd_geo:102473731");
    // locationName is absent, so the geo-derived label is used.
    expect(pos?.location).toBe("Stuttgart, Baden-Württemberg, Deutschland");
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
  const p = (title: string, current: boolean) => ({
    title,
    company: "Co",
    current,
    companyUrn: null,
    startDate: null,
    endDate: null,
    location: null,
    description: null,
    positionUrn: null,
    employmentTypeUrn: null,
    geoUrn: null,
  });

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
            fieldOfStudy: "Computer Science",
            schoolUrn: "urn:li:fsd_school:18158",
            companyUrn: "urn:li:fsd_company:3558",
          },
        ],
      })
    ).toEqual([
      {
        school: "Test University",
        degree: "Bachelor of Science - BS",
        fieldOfStudy: "Computer Science",
        schoolUrn: "urn:li:fsd_school:18158",
        companyUrn: "urn:li:fsd_company:3558",
        startDate: null,
        endDate: null,
        activities: null,
        description: null,
        grade: null,
        degreeUrn: null,
        fieldOfStudyUrn: null,
        educationUrn: "urn:li:fsd_education:1",
      },
    ]);
  });

  it("keeps education dates, activities, grade and the standardized URNs", () => {
    const [edu] = parseEducations({
      included: [
        {
          $type: `${P}Education`,
          entityUrn: "urn:li:fsd_profileEducation:(ACoSYNTH,1887176)",
          schoolName: "University of Oregon",
          degreeName: "BA",
          fieldOfStudy: "Business Administration",
          schoolUrn: "urn:li:fsd_school:19207",
          companyUrn: "urn:li:fsd_company:5827",
          degreeUrn: "urn:li:fsd_degree:7",
          standardizedFieldOfStudyUrn: "urn:li:fsd_fieldOfStudy:100",
          activities: "Gamma Phi Beta, Nu Chapter",
          description: "Studied abroad in Lyon.",
          grade: "3.8",
          dateRange: { start: { year: 1992 }, end: { year: 1996 } },
        },
      ],
    });
    expect(edu?.startDate).toBe("1992");
    expect(edu?.endDate).toBe("1996");
    expect(edu?.activities).toBe("Gamma Phi Beta, Nu Chapter");
    expect(edu?.description).toBe("Studied abroad in Lyon.");
    expect(edu?.grade).toBe("3.8");
    expect(edu?.degreeUrn).toBe("urn:li:fsd_degree:7");
    // Falls back to the standardized URN when the plain one is absent.
    expect(edu?.fieldOfStudyUrn).toBe("urn:li:fsd_fieldOfStudy:100");
    expect(edu?.educationUrn).toBe("urn:li:fsd_profileEducation:(ACoSYNTH,1887176)");
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
