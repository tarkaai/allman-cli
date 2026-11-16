/**
 * `getProfileSlugById` must return the slug of the profile that was asked for.
 *
 * LinkedIn's profiles response lists the viewer's own profile in `included`
 * next to the requested one (often first). Taking the first publicIdentifier
 * stamped the viewer's slug onto other people's conversation records, and
 * every `send`/`react`/`read` addressed by that slug then hit the wrong thread.
 */

import { mkdtemp, readlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LinkedInApiClient } from "@/linkedin/api/client.js";
import type { ConversationData } from "@/linkedin/api/endpoints/conversations.js";
import { getProfileSlugById, pickPublicIdentifier } from "@/linkedin/api/endpoints/profiles.js";
import { buildConversationRecord } from "@/store/conversation-record.js";
import { Store } from "@/store/index.js";

const ME = "ACoAAME";
const THEM = "ACoAATHEM";
const PROFILE = "com.linkedin.voyager.dash.identity.profile.Profile";

const response = {
  data: { "*elements": [`urn:li:fsd_profile:${THEM}`] },
  included: [
    { $type: PROFILE, entityUrn: `urn:li:fsd_profile:${ME}`, publicIdentifier: "viewer-slug" },
    { $type: PROFILE, entityUrn: `urn:li:fsd_profile:${THEM}`, publicIdentifier: "Sarah-Chen" },
  ],
};

describe("pickPublicIdentifier", () => {
  it("returns the requested profile's slug, not the viewer's", () => {
    expect(pickPublicIdentifier(response, THEM)).toBe("sarah-chen");
  });

  it("returns null when the requested profile is absent", () => {
    expect(pickPublicIdentifier({ included: [response.included[0]] }, THEM)).toBeNull();
    expect(pickPublicIdentifier({}, THEM)).toBeNull();
  });
});

describe("getProfileSlugById", () => {
  it("resolves through the client and matches by entityUrn", async () => {
    const client = { request: vi.fn().mockResolvedValue(response) };
    const slug = await getProfileSlugById(client as unknown as LinkedInApiClient, THEM);
    expect(slug).toBe("sarah-chen");
  });
});

describe("a record carrying the account's own slug", () => {
  let dir: string;
  let store: Store;
  const convId = "2-QUJDREVGR0g=";
  const conv = {
    urn: `urn:li:msg_conversation:(urn:li:fsd_profile:${ME},${convId})`,
    backendUrn: `urn:li:messagingThread:${convId}`,
    isGroup: false,
    title: null,
    participants: [
      { entityUrn: `urn:li:fsd_profile:${ME}`, name: "Me Myself", profilePictures: [] },
      { entityUrn: `urn:li:fsd_profile:${THEM}`, name: "Sarah Chen", profilePictures: [] },
    ],
  } as unknown as ConversationData;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "allman-slug-"));
    store = new Store({ path: dir, gitDebounceMs: 0 });
    await store.init();
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("is looked up again on sync and its stale alias is dropped", async () => {
    const conversations = store.forAccount(ME);
    const poisoned = await buildConversationRecord({
      conv,
      myProfileUrn: `urn:li:fsd_profile:${ME}`,
      existing: null,
      conversations,
      resolveSlug: async () => "viewer-slug",
    });
    if (!poisoned) throw new Error("no record built");
    await conversations.upsert(convId, poisoned);
    expect(await conversations.resolve("viewer-slug")).toBe(convId);

    const resolveSlug = vi.fn().mockResolvedValue("sarah-chen");
    const healed = await buildConversationRecord({
      conv,
      myProfileUrn: `urn:li:fsd_profile:${ME}`,
      existing: await conversations.read(convId),
      conversations,
      resolveSlug,
      mySlug: "viewer-slug",
    });
    if (!healed) throw new Error("no record built");
    expect(resolveSlug).toHaveBeenCalledWith(THEM);
    expect(healed.slug).toBe("sarah-chen");

    await conversations.upsert(convId, healed);
    expect(await conversations.resolve("viewer-slug")).toBeNull();
    expect(await readlink(join(dir, ME, "sarah-chen"))).toBe(convId);
  });
});
