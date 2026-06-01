/**
 * Unit tests for the flagship queryId resolver (env -> cache -> headless
 * capture -> persist), with the browser capture injected. Synthetic hashes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveSearchClustersQueryId } from "@/linkedin/api/flagship-queryid.js";
import type { AccountStore } from "@/store/index.js";

const FAKE_CLIENT = {} as never; // capture is injected in these tests, so it's unused
const QID = (h: string) => `voyagerSearchDashClusters.${h}`;
const HASH_A = "a".repeat(32);
const HASH_B = "b".repeat(32);

function fakeAccounts(cached?: string) {
  const writeQueryCache = vi.fn().mockResolvedValue(undefined);
  const readQueryCache = vi
    .fn()
    .mockResolvedValue(cached ? { searchClustersQueryId: cached, capturedAt: "t" } : null);
  return { readQueryCache, writeQueryCache } as unknown as AccountStore & {
    readQueryCache: ReturnType<typeof vi.fn>;
    writeQueryCache: ReturnType<typeof vi.fn>;
  };
}

let savedEnv: string | undefined;
beforeEach(() => {
  savedEnv = process.env.ALLMAN_SEARCH_CLUSTERS_QID;
  delete process.env.ALLMAN_SEARCH_CLUSTERS_QID;
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env.ALLMAN_SEARCH_CLUSTERS_QID;
  else process.env.ALLMAN_SEARCH_CLUSTERS_QID = savedEnv;
});

describe("resolveSearchClustersQueryId", () => {
  it("uses the env override and skips cache + capture", async () => {
    process.env.ALLMAN_SEARCH_CLUSTERS_QID = QID(HASH_A);
    const accounts = fakeAccounts(QID(HASH_B));
    const capture = vi.fn();
    const got = await resolveSearchClustersQueryId({
      accounts,
      profileId: "ACoX",
      apiClient: FAKE_CLIENT,
      cookieJar: {},
      capture,
    });
    expect(got).toBe(QID(HASH_A));
    expect(accounts.readQueryCache).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
  });

  it("ignores a malformed env override and falls through to cache", async () => {
    process.env.ALLMAN_SEARCH_CLUSTERS_QID = "not-a-valid-qid";
    const accounts = fakeAccounts(QID(HASH_B));
    const got = await resolveSearchClustersQueryId({
      accounts,
      profileId: "ACoX",
      apiClient: FAKE_CLIENT,
      cookieJar: {},
      capture: vi.fn(),
    });
    expect(got).toBe(QID(HASH_B));
  });

  it("returns the cached hash without capturing", async () => {
    const accounts = fakeAccounts(QID(HASH_B));
    const capture = vi.fn();
    const got = await resolveSearchClustersQueryId({
      accounts,
      profileId: "ACoX",
      apiClient: FAKE_CLIENT,
      cookieJar: {},
      capture,
    });
    expect(got).toBe(QID(HASH_B));
    expect(capture).not.toHaveBeenCalled();
  });

  it("captures + persists on cache miss", async () => {
    const accounts = fakeAccounts(undefined);
    const capture = vi.fn().mockResolvedValue(QID(HASH_A));
    const got = await resolveSearchClustersQueryId({
      accounts,
      profileId: "ACoX",
      apiClient: FAKE_CLIENT,
      cookieJar: { cookies: [] },
      capture,
    });
    expect(got).toBe(QID(HASH_A));
    expect(capture).toHaveBeenCalledOnce();
    expect(accounts.writeQueryCache).toHaveBeenCalledWith(
      "ACoX",
      expect.objectContaining({ searchClustersQueryId: QID(HASH_A) })
    );
  });

  it("force bypasses the cache and re-captures", async () => {
    const accounts = fakeAccounts(QID(HASH_B));
    const capture = vi.fn().mockResolvedValue(QID(HASH_A));
    const got = await resolveSearchClustersQueryId({
      accounts,
      profileId: "ACoX",
      apiClient: FAKE_CLIENT,
      cookieJar: {},
      force: true,
      capture,
    });
    expect(got).toBe(QID(HASH_A));
    expect(accounts.readQueryCache).not.toHaveBeenCalled();
    expect(capture).toHaveBeenCalledOnce();
  });

  it("returns null (and does not persist) when capture yields nothing", async () => {
    const accounts = fakeAccounts(undefined);
    const capture = vi.fn().mockResolvedValue(null);
    const got = await resolveSearchClustersQueryId({
      accounts,
      profileId: "ACoX",
      apiClient: FAKE_CLIENT,
      cookieJar: {},
      capture,
    });
    expect(got).toBeNull();
    expect(accounts.writeQueryCache).not.toHaveBeenCalled();
  });

  it("rejects a malformed captured value", async () => {
    const accounts = fakeAccounts(undefined);
    const capture = vi.fn().mockResolvedValue("voyagerSearchDashClusters.short");
    const got = await resolveSearchClustersQueryId({
      accounts,
      profileId: "ACoX",
      apiClient: FAKE_CLIENT,
      cookieJar: {},
      capture,
    });
    expect(got).toBeNull();
    expect(accounts.writeQueryCache).not.toHaveBeenCalled();
  });
});
