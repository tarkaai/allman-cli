/**
 * `allman login` must not discard a captured session just because the browser
 * flow didn't expose the profile id. Fallback order under test:
 *   1. slug → URN lookup (pre-existing)
 *   2. voyager/api/me identifies the session
 *   3. --account named an existing account → assume that id (with a warning)
 *   4. otherwise error, nothing written
 * All ids are synthetic.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  runLogin: vi.fn(),
  getProfileUrnBySlug: vi.fn(),
  getMyProfile: vi.fn(),
  storePath: "",
}));

vi.mock("@/linkedin/auth/playwright-auth.js", () => ({
  runLogin: (...a: unknown[]) => h.runLogin(...a),
}));
vi.mock("@/linkedin/api/endpoints/profiles.js", () => ({
  getProfileUrnBySlug: (...a: unknown[]) => h.getProfileUrnBySlug(...a),
  getMyProfile: (...a: unknown[]) => h.getMyProfile(...a),
}));
vi.mock("@/linkedin/api/client.js", () => ({
  buildApiClient: () => ({ updateJar: () => {}, request: vi.fn() }),
}));

import { loginCommand } from "@/commands/login.js";
import { Store } from "@/store/index.js";

const ME_ID = "ACoSYNTH00000000000000000000000000000ME";
const OLD_ID = "ACoSYNTH0000000000000000000000000000OLD";
const JAR = { cookies: [{ key: "li_at", value: "x", domain: ".linkedin.com", path: "/" }] };

function browserResult(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    success: true,
    profileUrn: null,
    name: "Synth Person",
    headline: null,
    profileUrl: null,
    imageUrl: null,
    cookieJar: JAR,
    ...overrides,
  };
}

async function readAuth(id: string) {
  return JSON.parse(await readFile(join(h.storePath, id, "AUTH.json"), "utf8"));
}

beforeEach(async () => {
  h.storePath = await mkdtemp(join(tmpdir(), "allman-login-test-"));
  h.runLogin.mockResolvedValue(browserResult());
  h.getProfileUrnBySlug.mockResolvedValue(null);
  h.getMyProfile.mockResolvedValue(null);
});
afterEach(async () => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  await rm(h.storePath, { recursive: true, force: true });
});

describe("login profile-id fallback", () => {
  it("browser gives no urn/url → /me identifies the session and supplies the slug", async () => {
    h.getMyProfile.mockResolvedValue({
      urn: `urn:li:fsd_profile:${ME_ID}`,
      publicIdentifier: "synth-person",
      firstName: "Synth",
      lastName: "Person",
    });
    await loginCommand({ store: h.storePath, salesnav: false });

    const auth = await readAuth(ME_ID);
    expect(auth.urn).toBe(`urn:li:fsd_profile:${ME_ID}`);
    expect(auth.profileSlug).toBe("synth-person");
    expect(auth.status).toBe("authenticated");
    const cookies = JSON.parse(await readFile(join(h.storePath, ME_ID, "COOKIES.json"), "utf8"));
    expect(cookies.cookieJar).toEqual(JAR);
    // slug lookup never ran: there was no slug to look up
    expect(h.getProfileUrnBySlug).not.toHaveBeenCalled();
  });

  it("nothing resolves but --account names an existing account → assumes that id, warns", async () => {
    const store = new Store({ path: h.storePath, gitDebounceMs: 0 });
    await store.init();
    await store.accounts.write(OLD_ID, {
      urn: `urn:li:fsd_profile:${OLD_ID}`,
      profileSlug: "old-slug",
      name: "Old",
      headline: null,
      profileUrl: null,
      imageUrl: null,
      userType: null,
      networkSize: null,
      status: "authenticated",
      cookieJar: { cookies: [] },
      cookiesUpdatedAt: "2026-01-01T00:00:00.000Z",
      lastSyncAt: null,
    });
    await store.accounts.createAlias("old-slug", OLD_ID);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await loginCommand({ store: h.storePath, account: "old-slug", salesnav: false });

    const auth = await readAuth(OLD_ID);
    expect(auth.urn).toBe(`urn:li:fsd_profile:${OLD_ID}`);
    const cookies = JSON.parse(await readFile(join(h.storePath, OLD_ID, "COOKIES.json"), "utf8"));
    expect(cookies.cookieJar).toEqual(JAR); // fresh session landed on the existing account
    const written = stderr.mock.calls.map((c) => String(c[0])).join("");
    expect(written).toMatch(/assuming it is the existing account "old-slug"/);
    stderr.mockRestore();
  });

  it("nothing resolves and no --account → errors out, writes nothing", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await expect(loginCommand({ store: h.storePath, salesnav: false })).rejects.toThrow(/exit:1/);

    const store = new Store({ path: h.storePath, gitDebounceMs: 0 });
    await store.init();
    expect(await store.accounts.list()).toEqual([]);
    exit.mockRestore();
  });

  it("browser-sniffed urn wins → no API identity calls", async () => {
    h.runLogin.mockResolvedValue(
      browserResult({
        profileUrn: `urn:li:fsd_profile:${ME_ID}`,
        profileUrl: "https://www.linkedin.com/in/synth-person/",
      })
    );
    await loginCommand({ store: h.storePath, salesnav: false });
    expect(h.getMyProfile).not.toHaveBeenCalled();
    expect(h.getProfileUrnBySlug).not.toHaveBeenCalled();
    expect((await readAuth(ME_ID)).profileSlug).toBe("synth-person");
  });
});
