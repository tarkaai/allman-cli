/**
 * Proves the connections-of pagination honors the random page delay
 * (rate limiter): it sleeps BETWEEN pages and not after the last page, and
 * skips sleeping entirely when noDelay is set. All ids are synthetic.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const sleepMock = vi.fn().mockResolvedValue(undefined);
vi.mock("@/utils/random-delay.js", () => ({
  randomPageSleep: (...args: unknown[]) => sleepMock(...args),
  DEFAULT_PAGE_DELAY: { minMs: 2000, maxMs: 8000 },
  pickDelayMs: () => 2000,
  sleep: vi.fn(),
}));

const leadSearchMock = vi.fn();
const resolveMock = vi.fn().mockResolvedValue("ACwSYNTH0000000000000000000000000000001");
vi.mock("@/linkedin/api/endpoints/salesnav.js", () => ({
  leadSearchConnectionOf: (...args: unknown[]) => leadSearchMock(...args),
  resolveSalesnavIdFromFlagshipId: (...args: unknown[]) => resolveMock(...args),
}));

vi.mock("@/linkedin/api/endpoints/profiles.js", () => ({
  getProfileUrnBySlug: vi
    .fn()
    .mockResolvedValue("urn:li:fsd_profile:ACoSYNTH0000000000000000000000000000001"),
}));

vi.mock("@/linkedin/api/session.js", () => ({
  loadSession: vi.fn().mockResolvedValue({
    apiClient: {},
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

import { connectionsOfCommand } from "@/commands/connections-of.js";

function page(n: number, isLastPage: boolean) {
  return {
    leads: Array.from({ length: n }, (_, i) => ({
      salesnavId: `ACwSYNTH${i}`,
      entityUrn: `urn:li:fs_salesProfile:(ACwSYNTH${i},NAME_SEARCH,zz)`,
      memberUrn: `urn:li:member:${1000 + i}`,
      memberId: String(1000 + i),
    })),
    total: 100,
    start: 0,
    count: 25,
    isLastPage,
  };
}

afterEach(() => {
  sleepMock.mockClear();
  leadSearchMock.mockReset();
  resolveMock.mockClear();
});

describe("connections-of pacing (rate limiter)", () => {
  it("sleeps between pages but NOT after the last page", async () => {
    leadSearchMock
      .mockResolvedValueOnce(page(25, false))
      .mockResolvedValueOnce(page(25, false))
      .mockResolvedValueOnce(page(10, true));
    await connectionsOfCommand("example-user-1", { json: true });
    expect(leadSearchMock).toHaveBeenCalledTimes(3);
    // 3 pages → 2 inter-page delays, none after the final page
    expect(sleepMock).toHaveBeenCalledTimes(2);
  });

  it("does not sleep when only one page is returned", async () => {
    leadSearchMock.mockResolvedValueOnce(page(5, true));
    await connectionsOfCommand("example-user-1", { json: true });
    expect(sleepMock).not.toHaveBeenCalled();
  });

  it("skips delays entirely when noDelay is set", async () => {
    leadSearchMock.mockResolvedValueOnce(page(25, false)).mockResolvedValueOnce(page(5, true));
    await connectionsOfCommand("example-user-1", { json: true, noDelay: true });
    expect(leadSearchMock).toHaveBeenCalledTimes(2);
    expect(sleepMock).not.toHaveBeenCalled();
  });

  it("advances the start offset by the number of leads each page", async () => {
    leadSearchMock.mockResolvedValueOnce(page(25, false)).mockResolvedValueOnce(page(25, true));
    await connectionsOfCommand("example-user-1", { json: true, noDelay: true });
    expect(leadSearchMock.mock.calls[0]?.[1]).toMatchObject({ start: 0, count: 25 });
    expect(leadSearchMock.mock.calls[1]?.[1]).toMatchObject({ start: 25, count: 25 });
  });
});
