/**
 * `allman connections` backend selection and storage, fully mocked.
 *
 * The important behaviour here is the default: flagship, *even with a Sales
 * Navigator seat*, because SalesNav refuses to paginate past 2500 and would
 * silently truncate a larger network. That's easy to "helpfully" regress, so
 * it's pinned.
 *
 * All ids/slugs are synthetic.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const state = { seat: true, salesnavTotal: 9999 };
  const urls: string[] = [];
  const flagshipUpserts: Array<Record<string, unknown>> = [];
  const salesnavUpserts: Array<Record<string, unknown>> = [];
  const out = {
    errors: [] as string[],
    successes: [] as string[],
    infos: [] as string[],
    warns: [] as string[],
  };
  return { state, urls, flagshipUpserts, salesnavUpserts, out };
});

vi.mock("@/utils/output.js", () => ({
  error: (m: string) => h.out.errors.push(m),
  success: (m: string) => h.out.successes.push(m),
  info: (m: string) => h.out.infos.push(m),
  warn: (m: string) => h.out.warns.push(m),
  debug: () => {},
  printData: () => {},
  emitEvent: () => {},
  setJsonMode: () => {},
  setDebugMode: () => {},
}));

vi.mock("@/utils/random-delay.js", () => ({
  randomPageSleep: vi.fn().mockResolvedValue(undefined),
  DEFAULT_PAGE_DELAY: { minMs: 0, maxMs: 0 },
  pickDelayMs: () => 0,
  sleep: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/linkedin/api/session.js", () => ({
  loadSession: vi.fn().mockImplementation(async () => ({
    apiClient: {
      request: async ({ url }: { url: string }) => {
        h.urls.push(url);
        if (url.includes("salesApiLeadSearch")) {
          const start = Number(/[?&]start=(\d+)/.exec(url)?.[1] ?? "0");
          const count = Number(/[?&]count=(\d+)/.exec(url)?.[1] ?? "100");
          // One short page, so pagination terminates immediately.
          const n = start === 0 ? Math.min(2, count) : 0;
          return {
            data: { paging: { total: h.state.salesnavTotal } },
            included: Array.from({ length: n }, (_, i) => ({
              $type: "com.linkedin.sales.search.DecoratedPeopleSearchHit",
              entityUrn: `urn:li:fs_salesProfile:(ACwSYNTH${i},NAME_SEARCH,zz)`,
              objectUrn: `urn:li:member:${100 + i}`,
              firstName: "Syn",
              lastName: String(i),
              fullName: `Syn ${i}`,
              geoRegion: "Testville",
              degree: 1,
              currentPositions: [{ title: "Engineer", companyName: "Test Co" }],
            })),
          };
        }
        // Flagship connections page.
        const count = Number(/[?&]count=(\d+)/.exec(url)?.[1] ?? "100");
        const n = Math.min(2, count);
        return {
          data: {
            paging: { count: n, start: 0 },
            "*elements": Array.from({ length: n }, (_, i) => `urn:li:fsd_connection:C${i}`),
          },
          included: [
            ...Array.from({ length: n }, (_, i) => ({
              entityUrn: `urn:li:fsd_connection:C${i}`,
              connectedMember: `urn:li:fsd_profile:ACoSYNTH${i}`,
              createdAt: 1700000000000,
            })),
            ...Array.from({ length: n }, (_, i) => ({
              entityUrn: `urn:li:fsd_profile:ACoSYNTH${i}`,
              publicIdentifier: `synthetic-${i}`,
              firstName: "Syn",
              lastName: String(i),
            })),
          ],
        };
      },
    },
    profileId: "ACoSYNTHSELF",
    accountRecord: { cookieJar: { cookies: h.state.seat ? [{ key: "li_a" }] : [] } },
    myProfileUrn: "urn:li:fsd_profile:ACoSYNTHSELF",
  })),
}));

vi.mock("@/store/index.js", () => ({
  resolveStorePath: () => "/tmp/allman-test-store",
  Store: class {
    path = "/tmp/allman-test-store";
    git = { flush: vi.fn().mockResolvedValue(undefined) };
    async init() {}
    connectionsFor() {
      return {
        git: { scheduleCommit: vi.fn() },
        upsertConnection: async (c: Record<string, unknown>) => {
          h.flagshipUpserts.push(c);
        },
        upsertSalesnavConnection: async (c: Record<string, unknown>) => {
          h.salesnavUpserts.push(c);
        },
        listConnectionIds: async () => [],
        readConnection: async () => null,
        enrichConnection: async () => true,
      };
    }
  },
}));

import { connectionsCommand } from "@/commands/connections.js";

const usedSalesnav = () => h.urls.some((u) => u.includes("salesApiLeadSearch"));
const usedFlagship = () => h.urls.some((u) => u.includes("relationships/dash/connections"));

beforeEach(() => {
  h.state.seat = true;
  h.state.salesnavTotal = 9999;
  h.urls.length = 0;
  h.flagshipUpserts.length = 0;
  h.salesnavUpserts.length = 0;
  for (const k of Object.keys(h.out) as Array<keyof typeof h.out>) h.out[k].length = 0;
});
afterEach(() => vi.clearAllMocks());

describe("connections: backend selection", () => {
  it("defaults to flagship EVEN WITH a Sales Navigator seat", async () => {
    // Regression: defaulting to the seat silently truncated large networks at
    // SalesNav's 2500 wall.
    h.state.seat = true;
    await connectionsCommand({ noDelay: true });
    expect(usedFlagship()).toBe(true);
    expect(usedSalesnav()).toBe(false);
  });

  it("uses flagship without a seat", async () => {
    h.state.seat = false;
    await connectionsCommand({ noDelay: true });
    expect(usedFlagship()).toBe(true);
  });

  it("--salesnav opts into the SalesNav sweep", async () => {
    await connectionsCommand({ salesnav: true, noDelay: true });
    expect(usedSalesnav()).toBe(true);
    expect(usedFlagship()).toBe(false);
  });

  it("--salesnav without a seat errors and makes no requests", async () => {
    h.state.seat = false;
    await connectionsCommand({ salesnav: true, noDelay: true });
    expect(h.out.errors[0]).toMatch(/Sales Navigator seat/);
    expect(h.urls).toHaveLength(0);
  });

  it("--flagship forces flagship even when --salesnav-capable", async () => {
    await connectionsCommand({ flagship: true, noDelay: true });
    expect(usedFlagship()).toBe(true);
  });
});

describe("connections: storage", () => {
  it("tags flagship records as source=connections so connect's guard trusts them", async () => {
    await connectionsCommand({ noDelay: true });
    expect(h.flagshipUpserts.length).toBeGreaterThan(0);
    for (const c of h.flagshipUpserts) expect(c.source).toBe("connections");
  });

  it("keeps slugs on flagship records", async () => {
    await connectionsCommand({ noDelay: true });
    expect(h.flagshipUpserts[0]?.publicIdentifier).toBe("synthetic-0");
  });

  it("stores SalesNav records in their own namespace with inline profile data", async () => {
    await connectionsCommand({ salesnav: true, noDelay: true });
    expect(h.flagshipUpserts).toHaveLength(0);
    expect(h.salesnavUpserts[0]).toMatchObject({
      memberId: "100",
      title: "Engineer",
      company: "Test Co",
      location: "Testville",
    });
  });

  it("warns when the network is larger than SalesNav can paginate", async () => {
    await connectionsCommand({ salesnav: true, noDelay: true });
    expect(h.out.warns.join(" ")).toMatch(/2500/);
  });

  it("does not warn when the network fits inside the wall", async () => {
    h.state.salesnavTotal = 10;
    await connectionsCommand({ salesnav: true, noDelay: true });
    expect(h.out.warns.join(" ")).not.toMatch(/2500/);
  });
});
