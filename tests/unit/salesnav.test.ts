/**
 * Unit tests for the Sales Navigator endpoint helpers.
 * All ids/names are synthetic placeholders (never real LinkedIn data).
 */
import { describe, expect, it } from "vitest";
import {
  buildConnectionOfQuery,
  extractSalesnavId,
  parseLeadSearchResponse,
} from "../../src/linkedin/api/endpoints/salesnav.js";

const SALESNAV_ID = "ACwAAB0000000000000000000000000000000001";
const SALESNAV_URN = `urn:li:fs_salesProfile:(${SALESNAV_ID},NAME_SEARCH,Aaaa)`;

describe("extractSalesnavId", () => {
  it("extracts the first composite segment", () => {
    expect(extractSalesnavId(SALESNAV_URN)).toBe(SALESNAV_ID);
  });
  it("handles the (id,undefined,undefined) resolver shape", () => {
    expect(extractSalesnavId(`urn:li:fs_salesProfile:(${SALESNAV_ID},undefined,undefined)`)).toBe(
      SALESNAV_ID
    );
  });
  it("returns null on malformed urns", () => {
    expect(extractSalesnavId("urn:li:fsd_profile:ACoAAB")).toBeNull();
    expect(extractSalesnavId("")).toBeNull();
  });
});

describe("buildConnectionOfQuery", () => {
  it("builds a rest.li filter list with CONNECTION_OF + RELATIONSHIP:S", () => {
    expect(buildConnectionOfQuery(SALESNAV_ID)).toBe(
      "(filters:List(" +
        `(type:CONNECTION_OF,values:List((id:${SALESNAV_ID},selectionType:INCLUDED))),` +
        "(type:RELATIONSHIP,values:List((id:S,selectionType:INCLUDED)))" +
        "))"
    );
  });
  it("does not leak text labels (no `text:` segments)", () => {
    expect(buildConnectionOfQuery(SALESNAV_ID)).not.toContain("text:");
  });
});

describe("parseLeadSearchResponse — normalized shape (live)", () => {
  function urn(id: string, ctx = "NAME_SEARCH", tok = "Xxxx") {
    return `urn:li:fs_salesProfile:(${id},${ctx},${tok})`;
  }
  // The live response: data["*elements"] = fs_salesProfile URNs, included = hits w/ objectUrn.
  function makeResponse(ids: Array<{ sid: string; member: number }>, total: number) {
    const refs = ids.map((x) => urn(x.sid));
    return {
      data: {
        paging: { total, count: ids.length, start: 0 },
        "*elements": refs,
        $type: "com.linkedin.sales.search.LeadSearchResults",
      },
      included: [
        // a company entry that must be ignored
        { entityUrn: "urn:li:fs_salesCompany:(123,foo)", $type: "fs_salesCompany" },
        ...ids.map((x) => ({
          entityUrn: urn(x.sid),
          objectUrn: `urn:li:member:${x.member}`,
          $type: "com.linkedin.sales.search.DecoratedPeopleSearchHit",
        })),
      ],
    };
  }

  it("extracts salesnavId + memberUrn + memberId from *elements + included", () => {
    const resp = makeResponse(
      [
        { sid: "ACwAAB0000000000000000000000000000000001", member: 1000001 },
        { sid: "ACwAAB0000000000000000000000000000000002", member: 1000002 },
      ],
      167
    );
    // request count == page size (2) so this isn't treated as the last page
    const page = parseLeadSearchResponse(resp, 0, 2);
    expect(page.total).toBe(167);
    expect(page.leads).toEqual([
      {
        salesnavId: "ACwAAB0000000000000000000000000000000001",
        entityUrn: urn("ACwAAB0000000000000000000000000000000001"),
        memberUrn: "urn:li:member:1000001",
        memberId: "1000001",
      },
      {
        salesnavId: "ACwAAB0000000000000000000000000000000002",
        entityUrn: urn("ACwAAB0000000000000000000000000000000002"),
        memberUrn: "urn:li:member:1000002",
        memberId: "1000002",
      },
    ]);
    expect(page.isLastPage).toBe(false);
  });

  it("marks last page when fewer results than requested", () => {
    const resp = makeResponse(
      [{ sid: "ACwAAB0000000000000000000000000000000003", member: 1000003 }],
      167
    );
    const page = parseLeadSearchResponse(resp, 0, 25);
    expect(page.isLastPage).toBe(true);
  });

  it("marks last page when total is reached", () => {
    const resp = makeResponse(
      Array.from({ length: 25 }, (_, i) => ({
        sid: `ACwAAB00000000000000000000000000000${(100 + i).toString()}`,
        member: 2000000 + i,
      })),
      150
    );
    const page = parseLeadSearchResponse(resp, 125, 25);
    expect(page.leads).toHaveLength(25);
    expect(page.isLastPage).toBe(true); // 125 + 25 >= 150
  });

  it("emits a lead even when objectUrn is missing from included", () => {
    const resp = {
      data: {
        paging: { total: 1, count: 1, start: 0 },
        "*elements": [urn("ACwAAB0000000000000000000000000000000009")],
      },
      included: [],
    };
    const page = parseLeadSearchResponse(resp, 0, 25);
    expect(page.leads).toEqual([
      {
        salesnavId: "ACwAAB0000000000000000000000000000000009",
        entityUrn: urn("ACwAAB0000000000000000000000000000000009"),
        memberUrn: "",
        memberId: "",
      },
    ]);
  });

  it("dedupes repeated salesnav ids", () => {
    const resp = makeResponse(
      [
        { sid: "ACwAAB0000000000000000000000000000000001", member: 1000001 },
        { sid: "ACwAAB0000000000000000000000000000000001", member: 1000001 },
      ],
      1
    );
    expect(parseLeadSearchResponse(resp, 0, 25).leads).toHaveLength(1);
  });

  it("ignores a non-numeric totalDisplayCount like '11M+'", () => {
    const resp = {
      data: {
        metadata: { totalDisplayCount: "11M+" },
        "*elements": [urn("ACwAAB0000000000000000000000000000000001")],
      },
      included: [],
    };
    const page = parseLeadSearchResponse(resp, 0, 25);
    expect(page.total).toBeNull();
    expect(page.leads).toHaveLength(1);
  });
});

describe("parseLeadSearchResponse — decorated fallback", () => {
  it("reads entityUrn/objectUrn inline when there is no *elements", () => {
    const resp = {
      paging: { total: 2, count: 25, start: 0 },
      elements: [
        {
          entityUrn:
            "urn:li:fs_salesProfile:(ACwAAB0000000000000000000000000000000005,NAME_SEARCH,Yy)",
          objectUrn: "urn:li:member:1000005",
        },
      ],
    };
    const page = parseLeadSearchResponse(resp, 0, 25);
    expect(page.leads).toEqual([
      {
        salesnavId: "ACwAAB0000000000000000000000000000000005",
        entityUrn:
          "urn:li:fs_salesProfile:(ACwAAB0000000000000000000000000000000005,NAME_SEARCH,Yy)",
        memberUrn: "urn:li:member:1000005",
        memberId: "1000005",
      },
    ]);
  });
});
