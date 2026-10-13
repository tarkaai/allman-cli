/**
 * Pure tests for the SalesNav facet helpers behind `connections-of
 * --region/--seniority/--slice`: alias parsing, flag → filter conversion,
 * slice plans, and the exact rest.li strings `buildConnectionOfQuery` emits
 * with and without facets. All ids are synthetic except LinkedIn's public
 * geo/seniority facet ids.
 */
import { describe, expect, it } from "vitest";
import { buildConnectionOfQuery } from "@/linkedin/api/endpoints/salesnav.js";
import {
  hasFilters,
  mergeFilters,
  parseFilterFlags,
  parseFilterIds,
  parseRelationship,
  REGION_ALIASES,
  SENIORITY_ALIASES,
  SLICE_PLANS,
} from "@/utils/salesnav-filters.js";

const SALESNAV_ID = "ACwSYNTH0000000000000000000000000000001";
const BASE =
  "(filters:List(" +
  `(type:CONNECTION_OF,values:List((id:${SALESNAV_ID},selectionType:INCLUDED))),` +
  "(type:RELATIONSHIP,values:List((id:S,selectionType:INCLUDED)))";

describe("parseFilterIds", () => {
  it("accepts numeric ids and aliases, case-insensitively, and dedupes", () => {
    expect(parseFilterIds("bay, 90000091,Bay,us", REGION_ALIASES, true, "region")).toEqual([
      { id: "90000084", include: true },
      { id: "90000091", include: true },
      { id: "103644278", include: true },
    ]);
  });
  it("expands the exec alias to VP + CXO + Owner", () => {
    expect(parseFilterIds("exec", SENIORITY_ALIASES, false, "seniority")).toEqual([
      { id: "300", include: false },
      { id: "310", include: false },
      { id: "320", include: false },
    ]);
  });
  it("returns [] for an empty flag", () => {
    expect(parseFilterIds(undefined, REGION_ALIASES, true, "region")).toEqual([]);
    expect(parseFilterIds(" , ", REGION_ALIASES, true, "region")).toEqual([]);
  });
  it("rejects unknown non-numeric tokens and names the aliases", () => {
    expect(() => parseFilterIds("mars", REGION_ALIASES, true, "region")).toThrow(
      /Unknown region "mars".*bay, seattle, us/
    );
  });
});

describe("parseFilterFlags", () => {
  it("returns null when no flag is set", () => {
    expect(parseFilterFlags({})).toBeNull();
    expect(parseFilterFlags({ region: "" })).toBeNull();
  });
  it("combines include + exclude per facet and omits empty facets", () => {
    expect(
      parseFilterFlags({ region: "us", excludeRegion: "bay,seattle", seniority: "vp" })
    ).toEqual({
      regions: [
        { id: "103644278", include: true },
        { id: "90000084", include: false },
        { id: "90000091", include: false },
      ],
      seniorities: [{ id: "300", include: true }],
    });
    expect(parseFilterFlags({ excludeSeniority: "exec" })).toEqual({
      seniorities: [
        { id: "300", include: false },
        { id: "310", include: false },
        { id: "320", include: false },
      ],
    });
  });
});

describe("hasFilters / mergeFilters", () => {
  it("hasFilters is false for null, undefined, and empty facets", () => {
    expect(hasFilters(null)).toBe(false);
    expect(hasFilters(undefined)).toBe(false);
    expect(hasFilters({ regions: [] })).toBe(false);
    expect(hasFilters({ seniorities: [{ id: "300", include: true }] })).toBe(true);
  });
  it("mergeFilters keeps base clauses first and drops empty facets", () => {
    expect(
      mergeFilters(
        { seniorities: [{ id: "300", include: true }] },
        {
          regions: [{ id: "90000084", include: true }],
        }
      )
    ).toEqual({
      regions: [{ id: "90000084", include: true }],
      seniorities: [{ id: "300", include: true }],
    });
    expect(mergeFilters(undefined, { regions: [{ id: "1", include: false }] })).toEqual({
      regions: [{ id: "1", include: false }],
    });
  });
});

describe("SLICE_PLANS", () => {
  it("walks region first, then seniority, with the verified partitions", () => {
    expect(SLICE_PLANS.map((plan) => plan.map((e) => e.label))).toEqual([
      ["bay", "seattle", "us-rest", "non-us"],
      ["exec", "non-exec"],
    ]);
    const usRest = SLICE_PLANS[0]?.[2];
    expect(usRest?.filters.regions).toEqual([
      { id: "103644278", include: true },
      { id: "90000084", include: false },
      { id: "90000091", include: false },
    ]);
    expect(SLICE_PLANS[1]?.[1]?.filters.seniorities?.every((v) => v.include === false)).toBe(true);
  });
});

describe("buildConnectionOfQuery with facets", () => {
  it("is byte-identical to the historical query when no filters are given", () => {
    expect(buildConnectionOfQuery(SALESNAV_ID)).toBe(`${BASE}))`);
    expect(buildConnectionOfQuery(SALESNAV_ID, undefined)).toBe(`${BASE}))`);
    expect(buildConnectionOfQuery(SALESNAV_ID, {})).toBe(`${BASE}))`);
    expect(buildConnectionOfQuery(SALESNAV_ID, { regions: [], seniorities: [] })).toBe(`${BASE}))`);
  });
  it("appends a REGION clause with INCLUDED/EXCLUDED selection types", () => {
    expect(
      buildConnectionOfQuery(SALESNAV_ID, {
        regions: [
          { id: "103644278", include: true },
          { id: "90000084", include: false },
        ],
      })
    ).toBe(
      `${BASE},` +
        "(type:REGION,values:List((id:103644278,selectionType:INCLUDED),(id:90000084,selectionType:EXCLUDED)))" +
        "))"
    );
  });
  it("appends REGION then SENIORITY_LEVEL when both are set", () => {
    expect(
      buildConnectionOfQuery(SALESNAV_ID, {
        regions: [{ id: "90000091", include: true }],
        seniorities: [
          { id: "320", include: true },
          { id: "310", include: true },
          { id: "300", include: true },
        ],
      })
    ).toBe(
      `${BASE},` +
        "(type:REGION,values:List((id:90000091,selectionType:INCLUDED)))," +
        "(type:SENIORITY_LEVEL,values:List((id:320,selectionType:INCLUDED),(id:310,selectionType:INCLUDED),(id:300,selectionType:INCLUDED)))" +
        "))"
    );
  });
  it("never leaks text labels", () => {
    expect(
      buildConnectionOfQuery(SALESNAV_ID, { regions: [{ id: "90000084", include: true }] })
    ).not.toContain("text:");
  });
});

describe("relationship (--relationship)", () => {
  it("parses degrees and aliases, dedupes, and keeps the default for an empty flag", () => {
    expect(parseRelationship(undefined)).toBeUndefined();
    expect(parseRelationship(" , ")).toBeUndefined();
    expect(parseRelationship("1st")).toEqual(["F"]);
    expect(parseRelationship("mutual,2")).toEqual(["F", "S"]);
    expect(parseRelationship("all,first")).toEqual(["F", "S"]);
    expect(() => parseRelationship("3rd")).toThrow(/Unknown relationship "3rd"/);
  });
  it("counts as a filter on its own and survives a slice merge", () => {
    const f = parseFilterFlags({ relationship: "all" });
    expect(f).toEqual({ relationship: ["F", "S"] });
    expect(hasFilters(f)).toBe(true);
    const bay = SLICE_PLANS[0]?.[0];
    if (!bay) throw new Error("slice plan missing");
    expect(mergeFilters(f, bay.filters)).toEqual({
      regions: [{ id: "90000084", include: true }],
      relationship: ["F", "S"],
    });
  });
  it("emits one RELATIONSHIP value per degree, S alone by default", () => {
    expect(buildConnectionOfQuery(SALESNAV_ID, { relationship: ["F"] })).toBe(
      "(filters:List(" +
        `(type:CONNECTION_OF,values:List((id:${SALESNAV_ID},selectionType:INCLUDED))),` +
        "(type:RELATIONSHIP,values:List((id:F,selectionType:INCLUDED)))))"
    );
    expect(buildConnectionOfQuery(SALESNAV_ID, { relationship: ["F", "S"] })).toBe(
      "(filters:List(" +
        `(type:CONNECTION_OF,values:List((id:${SALESNAV_ID},selectionType:INCLUDED))),` +
        "(type:RELATIONSHIP,values:List((id:F,selectionType:INCLUDED),(id:S,selectionType:INCLUDED)))))"
    );
    expect(buildConnectionOfQuery(SALESNAV_ID, { relationship: [] })).toBe(`${BASE}))`);
  });
});
