/**
 * Unit tests for the flagship people-search builder + parser.
 * Structure mirrors the live (reverse-engineered) request/response. Synthetic ids.
 */
import { describe, expect, it } from "vitest";
import { normalizeSlugInput } from "../../src/commands/connections-of.js";
import {
  buildConnectionOfVariables,
  parseSearchClustersResponse,
} from "../../src/linkedin/api/endpoints/people-search.js";

const FLAGSHIP_X = "ACoAAB0000000000000000000000000000000099";

describe("buildConnectionOfVariables", () => {
  it("puts includeFiltersInResponse inside query, omits empty keywords, omits count at 10", () => {
    expect(buildConnectionOfVariables({ flagshipProfileId: FLAGSHIP_X, start: 0, count: 10 })).toBe(
      `(start:0,origin:FACETED_SEARCH,query:(queryParameters:List((key:resultType,value:List(PEOPLE)),(key:network,value:List(S)),(key:connectionOf,value:List(${FLAGSHIP_X}))),flagshipSearchIntent:SEARCH_SRP,includeFiltersInResponse:false))`
    );
  });
  it("never emits an empty keywords token (that 400s)", () => {
    expect(
      buildConnectionOfVariables({ flagshipProfileId: FLAGSHIP_X, start: 0, count: 10 })
    ).not.toContain("keywords:");
  });
  it("advances start and appends count only when not 10", () => {
    const v = buildConnectionOfVariables({ flagshipProfileId: FLAGSHIP_X, start: 50, count: 25 });
    expect(v).toContain("start:50");
    expect(v).toContain(",count:25)");
  });
});

describe("parseSearchClustersResponse (normalized EntityResultViewModel shape)", () => {
  function erv(flagshipId: string, member: number, slug: string) {
    return {
      $type: "com.linkedin.voyager.dash.search.EntityResultViewModel",
      entityUrn: `urn:li:fsd_entityResultViewModel:(urn:li:fsd_profile:${flagshipId},SEARCH_SRP,DEFAULT)`,
      trackingUrn: `urn:li:member:${member}`,
      navigationUrl: `https://www.linkedin.com/in/${slug}?miniProfileUrn=x`,
    };
  }
  function makeResponse(rows: Array<{ id: string; member: number; slug: string }>, total: number) {
    return {
      data: { data: { searchDashClustersByAll: { metadata: { totalResultCount: total } } } },
      included: [
        // a Profile entry (minimal) + a FeedbackCard that must be ignored
        {
          $type: "com.linkedin.voyager.dash.identity.profile.Profile",
          entityUrn: `urn:li:fsd_profile:${rows[0]?.id}`,
        },
        {
          $type: "com.linkedin.voyager.dash.search.FeedbackCard",
          entityUrn: "urn:li:fsd_feedbackCard:1",
        },
        ...rows.map((r) => erv(r.id, r.member, r.slug)),
      ],
    };
  }

  it("extracts flagship id + numeric member id + slug from each result", () => {
    const resp = makeResponse(
      [
        {
          id: "ACoAAB0000000000000000000000000000000001",
          member: 1000001,
          slug: "Example-User-A",
        },
        { id: "ACoAAB0000000000000000000000000000000002", member: 1000002, slug: "example-user-b" },
      ],
      22
    );
    const page = parseSearchClustersResponse(resp, 0, 10);
    expect(page.total).toBe(22);
    expect(page.hits).toEqual([
      {
        memberUrn: "urn:li:fsd_profile:ACoAAB0000000000000000000000000000000001",
        memberId: "1000001",
        publicIdentifier: "example-user-a",
      },
      {
        memberUrn: "urn:li:fsd_profile:ACoAAB0000000000000000000000000000000002",
        memberId: "1000002",
        publicIdentifier: "example-user-b",
      },
    ]);
    // 2 < 10 → last page
    expect(page.isLastPage).toBe(true);
  });

  it("is not the last page when a full count came back below total", () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({
      id: `ACoAAB00000000000000000000000000000000${(10 + i).toString()}`,
      member: 1000 + i,
      slug: `user-${i}`,
    }));
    const page = parseSearchClustersResponse(makeResponse(rows, 50), 0, 10);
    expect(page.hits).toHaveLength(10);
    expect(page.isLastPage).toBe(false);
  });

  it("handles the non-nested data root (data.searchDashClustersByAll)", () => {
    const resp = {
      data: { searchDashClustersByAll: { metadata: { totalResultCount: 1 } } },
      included: [erv("ACoAAB0000000000000000000000000000000009", 5, "solo-user")],
    };
    const page = parseSearchClustersResponse(resp, 0, 10);
    expect(page.hits).toHaveLength(1);
    expect(page.hits[0]?.publicIdentifier).toBe("solo-user");
  });

  it("dedupes repeated flagship ids and tolerates missing member/slug", () => {
    const resp = {
      data: { data: { searchDashClustersByAll: { metadata: { totalResultCount: 1 } } } },
      included: [
        {
          $type: "com.linkedin.voyager.dash.search.EntityResultViewModel",
          entityUrn:
            "urn:li:fsd_entityResultViewModel:(urn:li:fsd_profile:ACoAAB0000000000000000000000000000000007,SEARCH_SRP,DEFAULT)",
        },
        {
          $type: "com.linkedin.voyager.dash.search.EntityResultViewModel",
          entityUrn:
            "urn:li:fsd_entityResultViewModel:(urn:li:fsd_profile:ACoAAB0000000000000000000000000000000007,SEARCH_SRP,DEFAULT)",
        },
      ],
    };
    const page = parseSearchClustersResponse(resp, 0, 10);
    expect(page.hits).toEqual([
      {
        memberUrn: "urn:li:fsd_profile:ACoAAB0000000000000000000000000000000007",
        memberId: null,
        publicIdentifier: null,
      },
    ]);
  });
});

describe("normalizeSlugInput", () => {
  it("returns plain slugs lowercased", () => {
    expect(normalizeSlugInput("Example-User-1")).toBe("example-user-1");
  });
  it("strips full LinkedIn URLs", () => {
    expect(normalizeSlugInput("https://www.linkedin.com/in/example-user-1/")).toBe(
      "example-user-1"
    );
    expect(normalizeSlugInput("linkedin.com/in/example-user-1")).toBe("example-user-1");
  });
  it("strips /in/ prefix", () => {
    expect(normalizeSlugInput("/in/example-user-1")).toBe("example-user-1");
  });
  it("returns null for URNs (this command is slug-only)", () => {
    expect(normalizeSlugInput("urn:li:fsd_profile:ACoAAB000")).toBeNull();
  });
  it("returns null for whitespace / garbage", () => {
    expect(normalizeSlugInput("")).toBeNull();
    expect(normalizeSlugInput("   ")).toBeNull();
    expect(normalizeSlugInput("with spaces")).toBeNull();
  });
});
