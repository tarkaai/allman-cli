/**
 * Backend selection + SalesNav→flagship fallback for `connections-of`.
 *
 * Rules under test:
 *   - default (auto): SalesNav when a seat (li_a cookie) is present, else flagship.
 *   - auto + seat but SalesNav unavailable at runtime → fall back to flagship.
 *   - --flagship: flagship only, never touches SalesNav.
 *   - --salesnav: SalesNav only, errors (no fallback) when there's no seat.
 * All ids are synthetic.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  accountRecord: { cookieJar: { cookies: [] as Array<{ key: string }> } },
  resolveSalesnav: vi.fn(),
  leadSearch: vi.fn(),
  searchPeople: vi.fn(),
  resolveQid: vi.fn(),
  getUrn: vi.fn(),
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
vi.mock("@/linkedin/api/endpoints/salesnav.js", () => ({
  resolveSalesnavIdFromFlagshipId: (...a: unknown[]) => h.resolveSalesnav(...a),
  leadSearchConnectionOf: (...a: unknown[]) => h.leadSearch(...a),
}));
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

import { connectionsOfCommand } from "@/commands/connections-of.js";

const SEAT = { cookies: [{ key: "li_at" }, { key: "li_a" }] };
const NO_SEAT = { cookies: [{ key: "li_at" }] };
const salesPage = {
  leads: [
    {
      salesnavId: "ACw1",
      entityUrn: "urn:li:fs_salesProfile:(ACw1,x,y)",
      memberUrn: "urn:li:member:1",
      memberId: "1",
    },
  ],
  total: 1,
  start: 0,
  count: 25,
  isLastPage: true,
};
const flagshipPage = {
  hits: [{ memberUrn: "urn:li:fsd_profile:ACoX", memberId: "9", publicIdentifier: "synthetic" }],
  total: 1,
  start: 0,
  count: 10,
  isLastPage: true,
};

function setSeat(present: boolean) {
  h.accountRecord.cookieJar = present ? SEAT : NO_SEAT;
}

beforeEach(() => {
  h.getUrn.mockResolvedValue("urn:li:fsd_profile:ACoTARGET");
  h.resolveSalesnav.mockResolvedValue("ACwTARGET");
  h.leadSearch.mockResolvedValue(salesPage);
  h.searchPeople.mockResolvedValue(flagshipPage);
  h.resolveQid.mockResolvedValue(`voyagerSearchDashClusters.${"a".repeat(32)}`);
  setSeat(false);
});
afterEach(() => {
  vi.clearAllMocks();
});

describe("connections-of backend selection", () => {
  it("auto + SalesNav seat present → uses SalesNav", async () => {
    setSeat(true);
    await connectionsOfCommand("example-user-1", { json: true, noDelay: true });
    expect(h.leadSearch).toHaveBeenCalled();
    expect(h.searchPeople).not.toHaveBeenCalled();
  });

  it("auto + no seat → falls back to flagship (never tries SalesNav)", async () => {
    setSeat(false);
    await connectionsOfCommand("example-user-1", { json: true, noDelay: true });
    expect(h.searchPeople).toHaveBeenCalled();
    expect(h.leadSearch).not.toHaveBeenCalled();
    expect(h.resolveSalesnav).not.toHaveBeenCalled();
  });

  it("auto + seat present but SalesNav unresolvable → falls back to flagship", async () => {
    setSeat(true);
    h.resolveSalesnav.mockResolvedValue(null);
    await connectionsOfCommand("example-user-1", { json: true, noDelay: true });
    expect(h.searchPeople).toHaveBeenCalled();
  });

  it("--flagship → flagship only, never touches SalesNav (even with a seat)", async () => {
    setSeat(true);
    await connectionsOfCommand("example-user-1", { json: true, noDelay: true, flagship: true });
    expect(h.searchPeople).toHaveBeenCalled();
    expect(h.resolveSalesnav).not.toHaveBeenCalled();
    expect(h.leadSearch).not.toHaveBeenCalled();
  });

  it("--salesnav + no seat → errors, does NOT fall back to flagship", async () => {
    setSeat(false);
    h.resolveSalesnav.mockResolvedValue(null);
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    await expect(
      connectionsOfCommand("example-user-1", { json: true, noDelay: true, salesnav: true })
    ).rejects.toThrow(/exit/);
    expect(h.searchPeople).not.toHaveBeenCalled();
    exit.mockRestore();
  });

  it("--salesnav + seat present → uses SalesNav (no fallback)", async () => {
    setSeat(true);
    await connectionsOfCommand("example-user-1", { json: true, noDelay: true, salesnav: true });
    expect(h.leadSearch).toHaveBeenCalled();
    expect(h.searchPeople).not.toHaveBeenCalled();
  });
});
