/**
 * Parser for the Sales Navigator "my 1st-degree connections" sweep
 * (salesApiLeadSearch + RELATIONSHIP:F, decorated hits).
 *
 * Shapes mirror live responses; all ids/names are synthetic.
 */
import { describe, expect, it } from "vitest";
import {
  buildOwnConnectionsQuery,
  parseOwnConnectionsResponse,
  resolveSalesnavIdsFromFlagshipIds,
} from "@/linkedin/api/endpoints/salesnav.js";

const HIT = "com.linkedin.sales.search.DecoratedPeopleSearchHit";

function hit(opts: {
  sn: string;
  member: string;
  first: string;
  last: string;
  title?: string;
  company?: string;
  geo?: string;
  summary?: string;
  pending?: boolean;
}) {
  return {
    $type: HIT,
    entityUrn: `urn:li:fs_salesProfile:(${opts.sn},NAME_SEARCH,abcd)`,
    objectUrn: `urn:li:member:${opts.member}`,
    firstName: opts.first,
    lastName: opts.last,
    fullName: `${opts.first} ${opts.last}`,
    geoRegion: opts.geo,
    degree: 1,
    summary: opts.summary,
    pendingInvitation: opts.pending ?? false,
    currentPositions:
      opts.title || opts.company ? [{ title: opts.title, companyName: opts.company }] : undefined,
  };
}

describe("buildOwnConnectionsQuery", () => {
  it("filters to first-degree relationships", () => {
    expect(buildOwnConnectionsQuery()).toContain("type:RELATIONSHIP");
    expect(buildOwnConnectionsQuery()).toContain("id:F");
  });
});

describe("parseOwnConnectionsResponse", () => {
  it("extracts identity plus the inline profile fields", () => {
    const resp = {
      data: { paging: { total: 8421 } },
      included: [
        { $type: "com.linkedin.sales.company.Company", entityUrn: "urn:li:fs_salesCompany:1" },
        hit({
          sn: "ACwSYNTH01",
          member: "3069246",
          first: "Alpha",
          last: "Tester",
          title: "Chief Strategy Officer",
          company: "Example Co",
          geo: "San Jose, California, United States",
          summary: "About text.",
        }),
      ],
    };
    const page = parseOwnConnectionsResponse(resp, 100);
    expect(page.total).toBe(8421);
    expect(page.isLastPage).toBe(true); // 1 < 100
    expect(page.connections).toEqual([
      {
        salesnavId: "ACwSYNTH01",
        entityUrn: "urn:li:fs_salesProfile:(ACwSYNTH01,NAME_SEARCH,abcd)",
        memberUrn: "urn:li:member:3069246",
        memberId: "3069246",
        firstName: "Alpha",
        lastName: "Tester",
        fullName: "Alpha Tester",
        location: "San Jose, California, United States",
        degree: 1,
        title: "Chief Strategy Officer",
        company: "Example Co",
        companyUrn: null,
        companyIndustry: null,
        companyLocation: null,
        about: "About text.",
        pendingInvitation: false,
        premium: false,
        openLink: false,
        memorialized: false,
        saved: false,
        viewed: false,
        profilePictureUrl: null,
        currentPositions: [
          {
            title: "Chief Strategy Officer",
            company: "Example Co",
            companyUrn: null,
            companyIndustry: null,
            companyLocation: null,
            companyLogoUrl: null,
            startDate: null,
            endDate: null,
            current: true,
            tenureMonths: null,
            companyTenureMonths: null,
          },
        ],
        pastPositions: [],
        spotlights: [],
      },
    ]);
  });

  it("folds the employer's industry, HQ and logo in from the sibling Company entity", () => {
    // SalesNav is the only surface that hands back the employer's industry
    // inline — the flagship position resource carries a bare companyUrn.
    const resp = {
      data: { paging: { total: 1 } },
      included: [
        {
          $type: "com.linkedin.sales.company.Company",
          entityUrn: "urn:li:fs_salesCompany:3602865",
          name: "Example AI",
          industry: "Technology, Information and Internet",
          location: "San Mateo, California, United States",
          companyPictureDisplayImage: {
            rootUrl: "https://media.example/company-logo_",
            artifacts: [
              { width: 100, height: 100, fileIdentifyingUrlPathSegment: "100_100/logo.png" },
              { width: 400, height: 400, fileIdentifyingUrlPathSegment: "400_400/logo.png" },
            ],
          },
        },
        {
          $type: HIT,
          entityUrn: "urn:li:fs_salesProfile:(ACwSYNTH02,NAME_SEARCH,abcd)",
          objectUrn: "urn:li:member:3069247",
          firstName: "Bravo",
          lastName: "Tester",
          fullName: "Bravo Tester",
          degree: 1,
          premium: true,
          openLink: true,
          saved: true,
          viewed: true,
          memorialized: false,
          profilePictureDisplayImage: {
            rootUrl: "https://media.example/photo-",
            artifacts: [
              { width: 200, height: 200, fileIdentifyingUrlPathSegment: "200_200/p.jpg" },
              { width: 800, height: 800, fileIdentifyingUrlPathSegment: "800_800/p.jpg" },
            ],
          },
          spotlightBadges: [
            { id: "SECOND_DEGREE_CONNECTION", displayValue: "23 mutual connections" },
            { id: "POSTED_ON_LINKEDIN", displayValue: "2 recent posts on Linkedin" },
            { displayValue: "no id — dropped" },
          ],
          currentPositions: [
            {
              title: "Chief Strategy Officer",
              companyName: "Example AI",
              companyUrn: "urn:li:fs_salesCompany:3602865",
              current: true,
              startedOn: { year: 2024 },
              tenureAtPosition: { numYears: 2, numMonths: 8 },
              tenureAtCompany: { numYears: 2, numMonths: 8 },
            },
          ],
          pastPositions: [
            {
              title: "VP Sales",
              companyName: "Old Co",
              startedOn: { year: 2018, month: 3 },
              endedOn: { year: 2024, month: 1 },
            },
          ],
        },
      ],
    };
    const [c] = parseOwnConnectionsResponse(resp, 100).connections;
    expect(c?.companyUrn).toBe("urn:li:fs_salesCompany:3602865");
    expect(c?.companyIndustry).toBe("Technology, Information and Internet");
    expect(c?.companyLocation).toBe("San Mateo, California, United States");
    expect(c?.premium).toBe(true);
    expect(c?.openLink).toBe(true);
    expect(c?.saved).toBe(true);
    expect(c?.viewed).toBe(true);
    expect(c?.profilePictureUrl).toBe("https://media.example/photo-800_800/p.jpg");
    expect(c?.currentPositions[0]?.companyLogoUrl).toBe(
      "https://media.example/company-logo_400_400/logo.png"
    );
    // 2y8m -> 32 months.
    expect(c?.currentPositions[0]?.tenureMonths).toBe(32);
    expect(c?.currentPositions[0]?.companyTenureMonths).toBe(32);
    expect(c?.currentPositions[0]?.startDate).toBe("2024");
    expect(c?.pastPositions).toEqual([
      {
        title: "VP Sales",
        company: "Old Co",
        companyUrn: null,
        companyIndustry: null,
        companyLocation: null,
        companyLogoUrl: null,
        startDate: "2018-03",
        endDate: "2024-01",
        current: false,
        tenureMonths: null,
        companyTenureMonths: null,
      },
    ]);
    // Badges without an id carry nothing joinable, so they are dropped.
    expect(c?.spotlights).toEqual([
      { id: "SECOND_DEGREE_CONNECTION", label: "23 mutual connections" },
      { id: "POSTED_ON_LINKEDIN", label: "2 recent posts on Linkedin" },
    ]);
  });

  it("ignores non-hit records and de-duplicates by salesnav id", () => {
    const dup = hit({ sn: "ACwSYNTH02", member: "1", first: "Bravo", last: "Tester" });
    const page = parseOwnConnectionsResponse({ included: [dup, { ...dup }] }, 100);
    expect(page.connections).toHaveLength(1);
  });

  it("tolerates people with no current position or location", () => {
    const page = parseOwnConnectionsResponse(
      { included: [hit({ sn: "ACwSYNTH03", member: "2", first: "Charlie", last: "Tester" })] },
      100
    );
    expect(page.connections[0]).toMatchObject({
      title: null,
      company: null,
      location: null,
      about: null,
    });
  });

  it("surfaces a pending invitation", () => {
    const page = parseOwnConnectionsResponse(
      {
        included: [
          hit({ sn: "ACwSYNTH04", member: "3", first: "Delta", last: "Tester", pending: true }),
        ],
      },
      100
    );
    expect(page.connections[0]?.pendingInvitation).toBe(true);
  });

  it("reports a full page as not-last so pagination continues", () => {
    const included = Array.from({ length: 3 }, (_, i) =>
      hit({ sn: `ACwSYNTH1${i}`, member: String(100 + i), first: "P", last: String(i) })
    );
    expect(parseOwnConnectionsResponse({ included }, 3).isLastPage).toBe(false);
  });
});

describe("resolveSalesnavIdsFromFlagshipIds", () => {
  const FLAG_A = "ACoSYNTH0000000000000000000000000000001";
  const FLAG_B = "ACoSYNTH0000000000000000000000000000002";

  function client(pages: Array<Record<string, unknown>>) {
    const calls: string[] = [];
    let i = 0;
    return {
      calls,
      client: {
        request: async ({ url }: { url: string }) => {
          calls.push(url);
          return pages[i++] ?? { data: { results: {} } };
        },
      } as unknown as Parameters<typeof resolveSalesnavIdsFromFlagshipIds>[0],
    };
  }

  const resultsFor = (pairs: Array<[string, string]>) => ({
    data: {
      results: Object.fromEntries(
        pairs.map(([flag, sn]) => [
          `*(authToken:undefined,authType:undefined,profileId:${flag})`,
          `urn:li:fs_salesProfile:(${sn},undefined,undefined)`,
        ])
      ),
    },
  });

  it("maps flagship ids to salesnav ids", async () => {
    const { client: c } = client([
      resultsFor([
        [FLAG_A, "ACwSYNTH01"],
        [FLAG_B, "ACwSYNTH02"],
      ]),
    ]);
    const map = await resolveSalesnavIdsFromFlagshipIds(c, [FLAG_A, FLAG_B]);
    expect(map.get(FLAG_A)).toBe("ACwSYNTH01");
    expect(map.get(FLAG_B)).toBe("ACwSYNTH02");
  });

  it("chunks at 100 ids per request (150 ids → 2 calls)", async () => {
    const ids = Array.from({ length: 150 }, (_, i) => `ACoSYNTH${String(i).padStart(10, "0")}`);
    const { client: c, calls } = client([resultsFor([]), resultsFor([])]);
    await resolveSalesnavIdsFromFlagshipIds(c, ids);
    expect(calls).toHaveLength(2);
  });

  it("omits people SalesNav doesn't recognise rather than inventing entries", async () => {
    const { client: c } = client([resultsFor([[FLAG_A, "ACwSYNTH01"]])]);
    const map = await resolveSalesnavIdsFromFlagshipIds(c, [FLAG_A, FLAG_B]);
    expect(map.size).toBe(1);
    expect(map.has(FLAG_B)).toBe(false);
  });

  it("survives a failing chunk instead of losing the whole batch", async () => {
    let n = 0;
    const c = {
      request: async () => {
        n += 1;
        if (n === 1) throw new Error("boom");
        return resultsFor([[FLAG_B, "ACwSYNTH02"]]);
      },
    } as unknown as Parameters<typeof resolveSalesnavIdsFromFlagshipIds>[0];
    const ids = Array.from({ length: 150 }, (_, i) => `ACoSYNTH${String(i).padStart(10, "0")}`);
    const map = await resolveSalesnavIdsFromFlagshipIds(c, ids);
    expect(map.get(FLAG_B)).toBe("ACwSYNTH02");
  });
});
