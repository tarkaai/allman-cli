/**
 * `connections-of` facets and `--slice` against a mocked SalesNav lead search.
 *
 * Rules under test:
 *   - explicit filters ride along on every page request;
 *   - --slice with a total under the cap costs one probe and then a plain pull;
 *   - --slice over the cap probes each region slice with count=1, splits an
 *     over-cap region by seniority, dedupes a salesnavId seen in two slices,
 *     and never requests a page at start >= 1000;
 *   - filters/--slice refuse to run on the flagship backend.
 * The mocked server answers from a lookup keyed by the REGION/SENIORITY
 * clauses in the query. All ids are synthetic.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LeadSearchFilters } from "@/utils/salesnav-filters.js";

const h = vi.hoisted(() => ({
  accountRecord: { cookieJar: { cookies: [] as Array<{ key: string }> } },
  resolveSalesnav: vi.fn(),
  leadSearch: vi.fn(),
  searchPeople: vi.fn(),
  resolveQid: vi.fn(),
  getUrn: vi.fn(),
  emitted: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/linkedin/api/session.js", () => ({
  loadSession: vi.fn(async () => ({
    apiClient: {},
    profileId: "ACoME",
    accountRecord: h.accountRecord,
    myProfileUrn: "urn:li:fsd_profile:ACoME",
  })),
}));
vi.mock("@/linkedin/api/endpoints/profiles.js", () => ({
  getProfileUrnBySlug: (...a: unknown[]) => h.getUrn(...a),
}));
vi.mock("@/linkedin/api/endpoints/salesnav.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/linkedin/api/endpoints/salesnav.js")>();
  return {
    ...actual,
    resolveSalesnavIdFromFlagshipId: (...a: unknown[]) => h.resolveSalesnav(...a),
    leadSearchConnectionOf: (...a: unknown[]) => h.leadSearch(...a),
  };
});
vi.mock("@/linkedin/api/endpoints/people-search.js", () => ({
  searchPeopleConnectionOf: (...a: unknown[]) => h.searchPeople(...a),
}));
vi.mock("@/linkedin/api/flagship-queryid.js", () => ({
  resolveSearchClustersQueryId: (...a: unknown[]) => h.resolveQid(...a),
}));
vi.mock("@/store/index.js", () => ({
  resolveStorePath: () => "/tmp/allman-test",
  Store: class {
    accounts = {};
    async init() {}
  },
}));
vi.mock("@/utils/random-delay.js", () => ({
  randomPageSleep: vi.fn().mockResolvedValue(undefined),
  DEFAULT_PAGE_DELAY: { minMs: 0, maxMs: 0 },
  pickDelayMs: () => 0,
  sleep: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/utils/output.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/output.js")>();
  return {
    ...actual,
    emitEvent: (e: Record<string, unknown>) => h.emitted.push(e),
    info: () => {},
    warn: () => {},
    success: () => {},
  };
});

import { connectionsOfCommand } from "@/commands/connections-of.js";

type Call = { start: number; count: number; filters?: LeadSearchFilters };

/** Stable key for a slice: the facet clauses it carries. */
function sliceKey(filters: LeadSearchFilters | undefined): string {
  const r = (filters?.regions ?? []).map((v) => `${v.include ? "+" : "-"}${v.id}`).join(",");
  const s = (filters?.seniorities ?? []).map((v) => `${v.include ? "+" : "-"}${v.id}`).join(",");
  return `R[${r}]S[${s}]`;
}

const BAY = "R[+90000084]S[]";
const SEATTLE = "R[+90000091]S[]";
const US_REST = "R[+103644278,-90000084,-90000091]S[]";
const NON_US = "R[-103644278]S[]";
const US_REST_EXEC = "R[+103644278,-90000084,-90000091]S[+300,+310,+320]";
const US_REST_NON_EXEC = "R[+103644278,-90000084,-90000091]S[-300,-310,-320]";
const UNFILTERED = "R[]S[]";

interface SliceSpec {
  total: number;
  /** Ids this slice serves, in order (defaults to `${prefix}${i}`). */
  ids?: string[];
}

/** A fake lead search: each slice has a total and a deterministic id list. */
function serve(slices: Record<string, SliceSpec>) {
  h.leadSearch.mockImplementation(async (_client: unknown, opts: Call) => {
    const key = sliceKey(opts.filters);
    const spec = slices[key];
    if (!spec) throw new Error(`unexpected slice ${key}`);
    const ids =
      spec.ids ?? Array.from({ length: spec.total }, (_, i) => `${key}#${i}`.replace(/\W/g, "_"));
    // The real server: nothing past the 1,000th result, whatever `total` says.
    const visible = ids.slice(0, 1000);
    const page = visible.slice(opts.start, opts.start + opts.count);
    return {
      leads: page.map((id) => ({
        salesnavId: id,
        entityUrn: `urn:li:fs_salesProfile:(${id},NAME_SEARCH,zz)`,
        memberUrn: `urn:li:member:${id}`,
        memberId: id,
      })),
      total: spec.total,
      start: opts.start,
      count: opts.count,
      isLastPage: page.length < opts.count || opts.start + page.length >= spec.total,
    };
  });
}

function calls(): Call[] {
  return h.leadSearch.mock.calls.map((c) => c[1] as Call);
}

function seat(present: boolean) {
  h.accountRecord.cookieJar = present ? { cookies: [{ key: "li_a" }] } : { cookies: [] };
}

beforeEach(() => {
  h.emitted.length = 0;
  h.getUrn.mockResolvedValue("urn:li:fsd_profile:ACoTARGET");
  h.resolveSalesnav.mockResolvedValue("ACwTARGET");
  h.resolveQid.mockResolvedValue(`voyagerSearchDashClusters.${"a".repeat(32)}`);
  h.searchPeople.mockResolvedValue({ hits: [], total: 0, start: 0, count: 10, isLastPage: true });
  seat(true);
});
afterEach(() => {
  vi.clearAllMocks();
});

function expectExit(fn: () => Promise<void>) {
  const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`exit:${code}`);
  }) as never);
  return expect(fn())
    .rejects.toThrow(/exit/)
    .finally(() => exit.mockRestore());
}

describe("connections-of explicit filters", () => {
  it("forwards the filters on every page request", async () => {
    const filters: LeadSearchFilters = {
      regions: [{ id: "90000084", include: true }],
      seniorities: [{ id: "300", include: true }],
    };
    serve({ "R[+90000084]S[+300]": { total: 60 } });
    await connectionsOfCommand("example-user-1", { json: true, noDelay: true, filters });
    const seen = calls();
    expect(seen.length).toBe(3); // 25 + 25 + 10
    for (const c of seen) expect(c.filters).toEqual(filters);
    expect(h.emitted.length).toBe(60);
  });

  it("refuses the flagship backend when filters are given (--flagship)", async () => {
    await expectExit(() =>
      connectionsOfCommand("example-user-1", {
        json: true,
        noDelay: true,
        flagship: true,
        filters: { regions: [{ id: "90000084", include: true }] },
      })
    );
    expect(h.searchPeople).not.toHaveBeenCalled();
    expect(h.leadSearch).not.toHaveBeenCalled();
  });

  it("refuses to fall back to flagship when there is no seat and --slice is set", async () => {
    seat(false);
    await expectExit(() =>
      connectionsOfCommand("example-user-1", { json: true, noDelay: true, slice: true })
    );
    expect(h.searchPeople).not.toHaveBeenCalled();
  });

  it("does not fall back to flagship when the seat dies mid-run with filters set", async () => {
    h.resolveSalesnav.mockResolvedValue(null);
    await expectExit(() =>
      connectionsOfCommand("example-user-1", {
        json: true,
        noDelay: true,
        filters: { regions: [{ id: "90000084", include: true }] },
      })
    );
    expect(h.searchPeople).not.toHaveBeenCalled();
  });
});

describe("connections-of --slice", () => {
  it("under the cap: one count=1 probe, then a plain pull, no facets added", async () => {
    serve({ [UNFILTERED]: { total: 40 } });
    await connectionsOfCommand("example-user-1", { json: true, noDelay: true, slice: true });
    const seen = calls();
    expect(seen[0]).toMatchObject({ start: 0, count: 1 });
    expect(seen.slice(1).map((c) => c.start)).toEqual([0, 25]);
    for (const c of seen) expect(c.filters).toBeUndefined();
    expect(h.emitted.length).toBe(40);
  });

  it("over the cap: probes region slices, splits an over-cap region by seniority, dedupes, and never pages past 1000", async () => {
    serve({
      [UNFILTERED]: { total: 3611 },
      [BAY]: { total: 30, ids: ["bay-1", "bay-2", "shared", ...ids("bay", 27)] },
      [SEATTLE]: { total: 0 },
      [US_REST]: { total: 1357 },
      [US_REST_EXEC]: { total: 26, ids: ["shared", ...ids("exec", 25)] },
      [US_REST_NON_EXEC]: { total: 1200 }, // deepest split still over the cap → truncated
      [NON_US]: { total: 10 },
    });
    await connectionsOfCommand("example-user-1", { json: true, noDelay: true, slice: true });
    const seen = calls();

    // Probes: unfiltered, then every region, then both seniority halves of us-rest.
    const probes = seen.filter((c) => c.count === 1).map((c) => sliceKey(c.filters));
    expect(probes).toEqual([
      UNFILTERED,
      BAY,
      SEATTLE,
      US_REST,
      US_REST_EXEC,
      US_REST_NON_EXEC,
      NON_US,
    ]);

    // Pages: never for the empty Seattle slice or the over-cap us-rest as a whole.
    const pages = seen.filter((c) => c.count === 25);
    const pagedSlices = new Set(pages.map((c) => sliceKey(c.filters)));
    expect(pagedSlices).toEqual(new Set([BAY, US_REST_EXEC, US_REST_NON_EXEC, NON_US]));
    expect(pages.every((c) => c.start < 1000)).toBe(true);
    expect(Math.max(...pages.map((c) => c.start))).toBe(975);

    // Merge: 30 + 26 + 1000 (truncated) + 10, minus the one id seen twice.
    expect(h.emitted.length).toBe(30 + 26 + 1000 + 10 - 1);
    const sharedRows = h.emitted.filter((e) => e.salesnavId === "shared");
    expect(sharedRows.length).toBe(1);
  });

  it("uses explicit filters as the base of every slice", async () => {
    const base: LeadSearchFilters = { seniorities: [{ id: "320", include: true }] };
    serve({
      "R[]S[+320]": { total: 1500 },
      "R[+90000084]S[+320]": { total: 5 },
      "R[+90000091]S[+320]": { total: 5 },
      "R[+103644278,-90000084,-90000091]S[+320]": { total: 5 },
      "R[-103644278]S[+320]": { total: 5 },
    });
    await connectionsOfCommand("example-user-1", {
      json: true,
      noDelay: true,
      slice: true,
      filters: base,
    });
    for (const c of calls()) {
      expect(c.filters?.seniorities).toEqual(base.seniorities);
    }
    expect(h.emitted.length).toBe(20);
  });

  it("skips the region split when the base already includes a region (OR would widen it)", async () => {
    const base: LeadSearchFilters = { regions: [{ id: "90000084", include: true }] };
    serve({
      [BAY]: { total: 1500 },
      // Explicit ids: the generated ids strip punctuation, so +/- slices would collide.
      "R[+90000084]S[+300,+310,+320]": { total: 40, ids: ids("exec", 40) },
      "R[+90000084]S[-300,-310,-320]": { total: 60, ids: ids("nonexec", 60) },
    });
    await connectionsOfCommand("example-user-1", {
      json: true,
      noDelay: true,
      slice: true,
      filters: base,
    });
    // No slice ever carries a second region value: the plan goes straight to seniority.
    for (const c of calls()) expect(c.filters?.regions).toEqual(base.regions);
    const probes = calls()
      .filter((c) => c.count === 1)
      .map((c) => sliceKey(c.filters));
    expect(probes).toEqual([BAY, "R[+90000084]S[+300,+310,+320]", "R[+90000084]S[-300,-310,-320]"]);
    expect(h.emitted.length).toBe(100);
  });

  it("pulls one truncated slice when both facets are already included", async () => {
    const base: LeadSearchFilters = {
      regions: [{ id: "90000084", include: true }],
      seniorities: [{ id: "300", include: true }],
    };
    serve({ "R[+90000084]S[+300]": { total: 1200 } });
    await connectionsOfCommand("example-user-1", {
      json: true,
      noDelay: true,
      slice: true,
      filters: base,
    });
    const seen = calls();
    expect(seen.filter((c) => c.count === 1).length).toBe(1);
    for (const c of seen) expect(sliceKey(c.filters)).toBe("R[+90000084]S[+300]");
    expect(Math.max(...seen.map((c) => c.start))).toBe(975);
    expect(h.emitted.length).toBe(1000);
  });

  it("still splits by region when the base only excludes one", async () => {
    const base: LeadSearchFilters = { regions: [{ id: "90000091", include: false }] };
    serve({
      "R[-90000091]S[]": { total: 1500 },
      "R[-90000091,+90000084]S[]": { total: 10 },
      "R[-90000091,+90000091]S[]": { total: 0 },
      "R[-90000091,+103644278,-90000084,-90000091]S[]": { total: 10 },
      "R[-90000091,-103644278]S[]": { total: 10 },
    });
    await connectionsOfCommand("example-user-1", {
      json: true,
      noDelay: true,
      slice: true,
      filters: base,
    });
    expect(h.emitted.length).toBe(30);
  });

  it("honors --limit on the merged result", async () => {
    serve({
      [UNFILTERED]: { total: 1200 },
      [BAY]: { total: 30 },
      [SEATTLE]: { total: 30 },
      [US_REST]: { total: 30 },
      [NON_US]: { total: 30 },
    });
    await connectionsOfCommand("example-user-1", {
      json: true,
      noDelay: true,
      slice: true,
      limit: 1100,
    });
    expect(h.emitted.length).toBe(120);
  });
});

describe("connections-of without --slice", () => {
  it("stops at the 1,000-result cap even when the server total is larger", async () => {
    serve({ [UNFILTERED]: { total: 3611 } });
    await connectionsOfCommand("example-user-1", { json: true, noDelay: true });
    const seen = calls();
    expect(seen.every((c) => c.start < 1000)).toBe(true);
    expect(h.emitted.length).toBe(1000);
  });
});

function ids(prefix: string, n: number): string[] {
  return Array.from({ length: n }, (_, i) => `${prefix}-x${i}`);
}
