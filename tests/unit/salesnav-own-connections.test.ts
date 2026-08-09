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
        about: "About text.",
        pendingInvitation: false,
      },
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
