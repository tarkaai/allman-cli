/**
 * Cookie persistence must MERGE into the jar on disk, not overwrite it.
 *
 * Scenario under test (seen live on 2026-10-09): a long-running `allman listen`
 * loaded the jar at startup; the user then ran `allman login`, which wrote a
 * fresh Sales Navigator seat (li_a) to COOKIES.json; listen's next response
 * carried a Set-Cookie and it wrote its whole stale jar back, dropping li_a.
 * All cookie values here are synthetic.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadCookieJar, mergeCookies, serializeCookieJar } from "@/linkedin/api/cookies.js";
import { loadSession, persistSetCookies } from "@/linkedin/api/session.js";
import { Store } from "@/store/index.js";
import type { AccountRecord } from "@/store/types.js";

// Note: simple-git is mocked globally in tests/setup.ts

const PROFILE_ID = "ACoAATEST00000000000000000000000000000";
const FAR_FUTURE = "Sat, 01 Jan 2050 00:00:00 GMT";

async function jarWith(...pairs: Array<[string, string]>) {
  const jar = loadCookieJar({ cookieJar: null });
  await mergeCookies(
    jar,
    pairs.map(([k, v]) => `${k}=${v}; Domain=.www.linkedin.com; Path=/; Expires=${FAR_FUTURE}`)
  );
  return serializeCookieJar(jar);
}

async function cookieNames(store: Store): Promise<Record<string, string>> {
  const cookies = await store.accounts.readCookies(PROFILE_ID);
  const jar = loadCookieJar({ cookieJar: cookies?.cookieJar ?? null });
  const all = await jar.store.getAllCookies();
  return Object.fromEntries(all.map((c) => [c.key, c.value]));
}

let tempDir: string;
let store: Store;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "allman-cookie-test-"));
  store = new Store({ path: tempDir, gitDebounceMs: 0 });
  await store.init();
  const record: AccountRecord = {
    urn: `urn:li:fsd_profile:${PROFILE_ID}`,
    profileSlug: "test-user",
    name: "Test User",
    headline: null,
    profileUrl: null,
    imageUrl: null,
    userType: null,
    networkSize: null,
    status: "authenticated",
    cookieJar: await jarWith(["JSESSIONID", '"ajax:1"'], ["li_at", "old-li-at"]),
    cookiesUpdatedAt: new Date().toISOString(),
    lastSyncAt: null,
  };
  await store.accounts.write(PROFILE_ID, record);
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("persistSetCookies", () => {
  it("keeps cookies another process wrote to disk after this process loaded its jar", async () => {
    // "Another process" (login) adds the SalesNav seat after we started.
    await store.accounts.writeCookies(PROFILE_ID, {
      cookieJar: await jarWith(
        ["JSESSIONID", '"ajax:1"'],
        ["li_at", "old-li-at"],
        ["li_a", "seat"]
      ),
      cookiesUpdatedAt: new Date().toISOString(),
    });

    // This process receives a rotated bcookie.
    const merged = await persistSetCookies(store, PROFILE_ID, [
      `bcookie=rotated; Domain=.linkedin.com; Path=/; Expires=${FAR_FUTURE}`,
    ]);

    expect(merged).not.toBeNull();
    const onDisk = await cookieNames(store);
    expect(onDisk.li_a).toBe("seat"); // not clobbered
    expect(onDisk.bcookie).toBe("rotated"); // ours landed
    expect(onDisk.li_at).toBe("old-li-at");
  });

  it("lets this process's Set-Cookie override the same cookie on disk", async () => {
    await persistSetCookies(store, PROFILE_ID, [
      `li_at=new-li-at; Domain=.www.linkedin.com; Path=/; Expires=${FAR_FUTURE}`,
    ]);
    expect((await cookieNames(store)).li_at).toBe("new-li-at");
  });

  it("writes nothing when the account was logged out meanwhile", async () => {
    await store.accounts.writeCookies(PROFILE_ID, { cookieJar: null, cookiesUpdatedAt: null });
    const merged = await persistSetCookies(store, PROFILE_ID, [
      `li_at=zombie; Domain=.www.linkedin.com; Path=/; Expires=${FAR_FUTURE}`,
    ]);
    expect(merged).toBeNull();
    const cookies = await store.accounts.readCookies(PROFILE_ID);
    expect(cookies?.cookieJar).toBeNull();
  });
});

describe("loadSession cookie callback", () => {
  it("merges on disk and adopts the merged jar in the client", async () => {
    const session = await loadSession(store, PROFILE_ID);

    // Another process writes a seat cookie after the session loaded its jar.
    await store.accounts.writeCookies(PROFILE_ID, {
      cookieJar: await jarWith(
        ["JSESSIONID", '"ajax:1"'],
        ["li_at", "old-li-at"],
        ["li_a", "seat"]
      ),
      cookiesUpdatedAt: new Date().toISOString(),
    });

    // Drive the persist callback the way the client does after a response.
    const client = session.apiClient as unknown as {
      onCookieUpdate: (jar: unknown, headers: string[]) => Promise<void>;
    };
    await client.onCookieUpdate(session.apiClient.getJar(), [
      `bcookie=rotated; Domain=.linkedin.com; Path=/; Expires=${FAR_FUTURE}`,
    ]);

    const onDisk = await cookieNames(store);
    expect(onDisk.li_a).toBe("seat");
    expect(onDisk.bcookie).toBe("rotated");

    // The in-memory jar now carries the other process's cookie too.
    const inMemory = await session.apiClient.getJar().store.getAllCookies();
    expect(inMemory.map((c) => c.key)).toContain("li_a");
  });
});
