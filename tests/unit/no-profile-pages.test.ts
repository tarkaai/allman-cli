/**
 * Guard test: the connections / connections-of commands must only hit LinkedIn
 * *API* endpoints (voyager/api, sales-api) and must NEVER fetch a person's
 * profile page (/in/<slug>, /sales/lead/, /sales/people/, /pub/) — i.e. we
 * fetch IDs, we do not scrape profiles.
 *
 * This runs the REAL endpoint code through a recording apiClient and asserts on
 * the actual URLs requested. (The flagship backend is intentionally not
 * exercised here: it fetches the search-results page once for queryId
 * discovery, which is a search page, not a profile page.)
 *
 * All ids/slugs are synthetic.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

// Hoisted so the (hoisted) vi.mock factory below can reference these.
const { requestedUrls, recordingApiClient } = vi.hoisted(() => {
  const requestedUrls: string[] = [];
  const cannedFor = (url: string): unknown => {
    if (/voyager\/api\/graphql/.test(url) && /memberIdentity/.test(url)) {
      return {
        data: {
          data: {
            identityDashProfilesByMemberIdentity: {
              "*elements": ["urn:li:fsd_profile:ACoSYNTH0000000000000000000000000000001"],
            },
          },
          included: [],
        },
      };
    }
    if (/salesApiProfiles/.test(url)) {
      return {
        data: {
          results: {
            x: "urn:li:fs_salesProfile:(ACwSYNTH0000000000000000000000000000001,undefined,undefined)",
          },
        },
      };
    }
    if (/salesApiLeadSearch/.test(url)) {
      const urn = "urn:li:fs_salesProfile:(ACwSYNTH0000000000000000000000000000001,NAME_SEARCH,zz)";
      return {
        data: { paging: { total: 1, count: 25, start: 0 }, "*elements": [urn] },
        included: [{ entityUrn: urn, objectUrn: "urn:li:member:1000001" }],
      };
    }
    if (/relationships\/dash\/connections/.test(url)) {
      return {
        data: { paging: { count: 1, start: 0 }, "*elements": ["urn:li:fsd_connection:ACoCONN1"] },
        included: [
          {
            entityUrn: "urn:li:fsd_connection:ACoCONN1",
            connectedMember: "urn:li:fsd_profile:ACoMEM1",
          },
          {
            entityUrn: "urn:li:fsd_profile:ACoMEM1",
            publicIdentifier: "synthetic-user-1",
            firstName: "Syn",
            lastName: "Thetic",
          },
        ],
      };
    }
    return { data: {}, included: [] };
  };
  const recordingApiClient = {
    request: async ({ url }: { url: string }) => {
      requestedUrls.push(url);
      return cannedFor(url);
    },
  };
  return { requestedUrls, recordingApiClient };
});

vi.mock("@/linkedin/api/session.js", () => ({
  loadSession: vi.fn().mockResolvedValue({
    apiClient: recordingApiClient,
    profileId: "ACoSYNTH",
    accountRecord: { cookieJar: { cookies: [{ key: "li_a" }] } }, // has a SalesNav seat
    myProfileUrn: "urn:li:fsd_profile:ACoSYNTH",
  }),
}));
vi.mock("@/store/index.js", () => ({
  resolveStorePath: () => "/tmp/allman-test",
  Store: class {
    async init() {}
  },
}));
vi.mock("@/utils/random-delay.js", () => ({
  randomPageSleep: vi.fn().mockResolvedValue(undefined),
  DEFAULT_PAGE_DELAY: { minMs: 2000, maxMs: 8000 },
  pickDelayMs: () => 0,
  sleep: vi.fn().mockResolvedValue(undefined),
}));

import { connectionsCommand } from "@/commands/connections.js";
import { connectionsOfCommand } from "@/commands/connections-of.js";

const PROFILE_PAGE_PATTERNS = [/\/in\//, /\/sales\/lead\//, /\/sales\/people\//, /\/pub\//];
const ALLOWED_API_PREFIXES = ["/voyager/api/", "/sales-api/"];

afterEach(() => {
  requestedUrls.length = 0;
});

describe("no profile-page fetches", () => {
  it("connections-of (SalesNav) only hits API endpoints, never a profile page", async () => {
    await connectionsOfCommand("synthetic-user-1", { json: true, noDelay: true });
    expect(requestedUrls.length).toBeGreaterThan(0);
    for (const url of requestedUrls) {
      for (const bad of PROFILE_PAGE_PATTERNS) {
        expect(url, `must not fetch a profile page: ${url}`).not.toMatch(bad);
      }
      const path = new URL(url).pathname;
      expect(
        ALLOWED_API_PREFIXES.some((p) => path.startsWith(p)),
        `must be an API endpoint: ${path}`
      ).toBe(true);
    }
  });

  it("connections export only hits API endpoints, never a profile page", async () => {
    await connectionsCommand({ json: true, noDelay: true });
    expect(requestedUrls.length).toBeGreaterThan(0);
    for (const url of requestedUrls) {
      for (const bad of PROFILE_PAGE_PATTERNS) {
        expect(url, `must not fetch a profile page: ${url}`).not.toMatch(bad);
      }
      const path = new URL(url).pathname;
      expect(
        ALLOWED_API_PREFIXES.some((p) => path.startsWith(p)),
        `must be an API endpoint: ${path}`
      ).toBe(true);
    }
  });
});
