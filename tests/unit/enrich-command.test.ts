/**
 * `allman enrich` end-to-end, fully mocked: no network, no filesystem.
 *
 * Covers the bits that only exist at the command layer — quota enforcement,
 * skip/force semantics, core-vs-deep request counts, and the `source` tagging
 * that keeps `connect`'s guard honest. The API client is a recording fake, so
 * the real endpoint code runs.
 *
 * All ids/slugs are synthetic.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ID_1 = "ACoSYNTH0000000000000000000000000000001";
const ID_2 = "ACoSYNTH0000000000000000000000000000002";
const P = "com.linkedin.voyager.dash.identity.profile.";

const h = vi.hoisted(() => {
  const state = {
    records: new Map<string, Record<string, unknown>>(),
    config: {} as Record<string, unknown>,
    rateState: null as Record<string, unknown> | null,
    seat: true,
  };
  const urls: string[] = [];
  const upserts: Array<Record<string, unknown>> = [];
  const enrichCalls: Array<{ id: string; patch: Record<string, unknown>; depth: string }> = [];
  const out = {
    errors: [] as string[],
    successes: [] as string[],
    infos: [] as string[],
    warns: [] as string[],
  };
  return { state, urls, upserts, enrichCalls, out };
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
        const id = /memberIdentity=([^&]+)/.exec(url)?.[1] ?? ID_1;
        if (url.includes("/profiles?")) {
          return {
            included: [
              {
                $type: `${P}Profile`,
                entityUrn: `urn:li:fsd_profile:${id}`,
                publicIdentifier: `slug-${id.slice(-1)}`,
                firstName: "Syn",
                lastName: "Thetic",
                headline: "Headline",
                summary: "About.",
              },
            ],
          };
        }
        if (url.includes("profilePositions")) {
          return {
            included: [
              {
                $type: `${P}Position`,
                entityUrn: "urn:li:fsd_position:1",
                title: "Engineer",
                companyName: "Test Co",
                dateRange: { start: { year: 2020 } },
              },
            ],
          };
        }
        if (url.includes("profileEducations")) {
          return { included: [{ $type: `${P}Education`, entityUrn: "e1", degreeName: "BS" }] };
        }
        if (url.includes("profileSkills")) {
          return { included: [{ $type: `${P}Skill`, entityUrn: "s1", name: "TypeScript" }] };
        }
        return { included: [] };
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
    git = { flush: vi.fn().mockResolvedValue(undefined) };
    accounts = {
      readConfig: async () => h.state.config,
      readRateState: async () => h.state.rateState,
      writeRateState: async (_i: string, s: Record<string, unknown>) => {
        h.state.rateState = s;
      },
    };
    async init() {}
    connectionsFor() {
      return {
        git: { scheduleCommit: vi.fn() },
        listConnectionIds: async () => [...h.state.records.keys()],
        readConnection: async (id: string) => h.state.records.get(id) ?? null,
        upsertConnection: async (c: Record<string, unknown>) => {
          h.upserts.push(c);
          h.state.records.set(c.flagshipId as string, c);
        },
        enrichConnection: async (id: string, patch: Record<string, unknown>, depth: string) => {
          h.enrichCalls.push({ id, patch, depth });
          const prev = h.state.records.get(id) ?? {};
          h.state.records.set(id, { ...prev, ...patch, enrichedAt: "now", enrichDepth: depth });
          return true;
        },
      };
    }
  },
}));

import { enrichCommand } from "@/commands/enrich.js";

const pending = (id: string) => ({
  flagshipId: id,
  publicIdentifier: null,
  enrichedAt: null,
  enrichDepth: null,
});

beforeEach(() => {
  h.state.records = new Map();
  h.state.config = {};
  h.state.rateState = null;
  h.state.seat = true;
  h.urls.length = 0;
  h.upserts.length = 0;
  h.enrichCalls.length = 0;
  for (const k of Object.keys(h.out) as Array<keyof typeof h.out>) h.out[k].length = 0;
});
afterEach(() => vi.clearAllMocks());

describe("enrich: request shape", () => {
  it("core mode costs 2 requests per profile (core + positions)", async () => {
    h.state.records.set(ID_1, pending(ID_1));
    await enrichCommand(undefined, { noDelay: true });
    expect(h.urls.filter((u) => u.includes("/profiles?"))).toHaveLength(1);
    expect(h.urls.filter((u) => u.includes("profilePositions"))).toHaveLength(1);
    expect(h.urls.some((u) => u.includes("profileEducations"))).toBe(false);
  });

  it("deep mode adds education and skills (4 requests)", async () => {
    h.state.records.set(ID_1, pending(ID_1));
    await enrichCommand(undefined, { deep: true, noDelay: true });
    expect(h.urls.filter((u) => u.includes("profileEducations"))).toHaveLength(1);
    expect(h.urls.filter((u) => u.includes("profileSkills"))).toHaveLength(1);
  });

  it("writes title and company resolved from positions", async () => {
    h.state.records.set(ID_1, pending(ID_1));
    await enrichCommand(undefined, { noDelay: true });
    expect(h.enrichCalls[0]?.patch).toMatchObject({ title: "Engineer", company: "Test Co" });
  });

  it("does not persist positions/education/skills in core mode", async () => {
    h.state.records.set(ID_1, pending(ID_1));
    await enrichCommand(undefined, { noDelay: true });
    expect(h.enrichCalls[0]?.patch).not.toHaveProperty("positions");
  });
});

describe("enrich: skip and force", () => {
  it("skips records already enriched at the requested depth", async () => {
    h.state.records.set(ID_1, { flagshipId: ID_1, enrichedAt: "yesterday", enrichDepth: "core" });
    await enrichCommand(undefined, { noDelay: true });
    expect(h.urls).toHaveLength(0);
    expect(h.out.successes.join(" ")).toMatch(/skipped 1/);
  });

  it("re-fetches a skipped record under --force", async () => {
    h.state.records.set(ID_1, { flagshipId: ID_1, enrichedAt: "yesterday", enrichDepth: "core" });
    await enrichCommand(undefined, { force: true, noDelay: true });
    expect(h.urls.length).toBeGreaterThan(0);
  });

  it("upgrades a core record when --deep is requested", async () => {
    h.state.records.set(ID_1, { flagshipId: ID_1, enrichedAt: "yesterday", enrichDepth: "core" });
    await enrichCommand(undefined, { deep: true, noDelay: true });
    expect(h.enrichCalls[0]?.depth).toBe("deep");
  });

  it("stops after --limit profiles", async () => {
    h.state.records.set(ID_1, pending(ID_1));
    h.state.records.set(ID_2, pending(ID_2));
    await enrichCommand(undefined, { limit: 1, noDelay: true });
    expect(h.enrichCalls).toHaveLength(1);
  });
});

describe("enrich: quota", () => {
  it("stops early when the window is spent, and says when it returns", async () => {
    h.state.config = { rateLimit: { maxEnrichments: 1, enrichmentWindowMs: 3_600_000 } };
    h.state.records.set(ID_1, pending(ID_1));
    h.state.records.set(ID_2, pending(ID_2));
    await enrichCommand(undefined, { noDelay: true });
    expect(h.enrichCalls).toHaveLength(1);
    expect(h.out.warns.join(" ")).toMatch(/limit reached/);
  });

  it("skipped records do not consume quota", async () => {
    h.state.config = { rateLimit: { maxEnrichments: 1, enrichmentWindowMs: 3_600_000 } };
    h.state.records.set(ID_1, { flagshipId: ID_1, enrichedAt: "yesterday", enrichDepth: "core" });
    h.state.records.set(ID_2, pending(ID_2));
    await enrichCommand(undefined, { noDelay: true });
    // The skip didn't burn the single slot, so ID_2 still got enriched.
    expect(h.enrichCalls.map((c) => c.id)).toEqual([ID_2]);
  });

  it("refuses a single-target enrich when the window is spent", async () => {
    h.state.config = { rateLimit: { maxEnrichments: 1, enrichmentWindowMs: 3_600_000 } };
    h.state.rateState = { lastMessageSentAt: 0, enrichmentTimestamps: [Date.now()] };
    await enrichCommand("someone", { noDelay: true });
    expect(h.out.errors[0]).toMatch(/limit reached/i);
    expect(h.urls).toHaveLength(0);
  });
});

describe("enrich: single target", () => {
  it("tags ad-hoc records as source=enrich so connect's guard ignores them", async () => {
    await enrichCommand("someone", { noDelay: true });
    expect(h.upserts[0]).toMatchObject({ source: "enrich" });
  });

  it("errors when there are no stored connections to bulk-enrich", async () => {
    await enrichCommand(undefined, { noDelay: true });
    expect(h.out.errors[0]).toMatch(/No stored connections/);
  });
});
