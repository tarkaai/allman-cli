/**
 * `allman connect` end-to-end, fully mocked: no network, no filesystem.
 *
 * This is the highest-risk command in the CLI — it sends irreversible outbound
 * invitations — so the guards get covered here rather than only at the store or
 * endpoint layer. The API client is a recording fake, so the real endpoint code
 * (URL, payload shape, response parsing) is exercised.
 *
 * All ids/slugs are synthetic and match no real LinkedIn profile.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SLUG = "synthetic-target";
const TARGET_ID = "ACoSYNTH0000000000000000000000000000009";
const TARGET_URN = `urn:li:fsd_profile:${TARGET_ID}`;
const INVITATION_URN = "urn:li:fsd_invitation:7000000000000000000";

const h = vi.hoisted(() => {
  interface State {
    connections: Set<string>;
    invitations: Map<string, { sentAt: string; note: string | null }>;
    rateState: Record<string, unknown> | null;
    config: Record<string, unknown>;
    seat: boolean;
    inviteStatus: number | null;
    profileFound: boolean;
  }
  const state: State = {
    connections: new Set(),
    invitations: new Map(),
    rateState: null,
    config: {},
    seat: true,
    inviteStatus: null,
    profileFound: true,
  };
  const posts: Array<{ url: string; data: unknown }> = [];
  const out = {
    errors: [] as string[],
    successes: [] as string[],
    infos: [] as string[],
    warns: [] as string[],
    data: [] as unknown[],
  };
  return { state, posts, out };
});

vi.mock("@/utils/output.js", () => ({
  // The real `error` calls process.exit — record instead, since every call site
  // returns immediately afterwards anyway.
  error: (m: string) => h.out.errors.push(m),
  success: (m: string) => h.out.successes.push(m),
  info: (m: string) => h.out.infos.push(m),
  warn: (m: string) => h.out.warns.push(m),
  debug: () => {},
  printData: (d: unknown) => h.out.data.push(d),
  emitEvent: (d: unknown) => h.out.data.push(d),
  setJsonMode: () => {},
  setDebugMode: () => {},
}));

vi.mock("@/linkedin/api/session.js", () => ({
  loadSession: vi.fn().mockImplementation(async () => ({
    apiClient: {
      request: async ({ method, url, data }: { method: string; url: string; data?: unknown }) => {
        if (method === "POST" && url.includes("voyagerRelationshipsDashMemberRelationships")) {
          h.posts.push({ url, data });
          if (h.state.inviteStatus) {
            const { LinkedInError } = await import("@/linkedin/api/client.js");
            throw new LinkedInError("refused", "FORBIDDEN", h.state.inviteStatus);
          }
          return { value: { invitationUrn: INVITATION_URN } };
        }
        // Profile lookup by slug.
        if (!h.state.profileFound) return { data: { data: {} } };
        return {
          data: {
            data: {
              identityDashProfilesByMemberIdentity: {
                elements: [{ entityUrn: TARGET_URN, firstName: { text: "Syn" } }],
              },
            },
          },
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
    git = { flush: vi.fn().mockResolvedValue(undefined) };
    accounts = {
      readConfig: async () => h.state.config,
      readRateState: async () => h.state.rateState,
      writeRateState: async (_id: string, s: Record<string, unknown>) => {
        h.state.rateState = s;
      },
    };
    async init() {}
    connectionsFor() {
      return {
        git: { scheduleCommit: vi.fn() },
        hasConnection: async (k: string) => h.state.connections.has(k),
        readInvitation: async (id: string) => h.state.invitations.get(id) ?? null,
        recordInvitation: async (inv: {
          inviteeId: string;
          sentAt: string;
          note: string | null;
        }) => {
          h.state.invitations.set(inv.inviteeId, { sentAt: inv.sentAt, note: inv.note });
        },
      };
    }
  },
}));

import { connectCommand } from "@/commands/connect.js";

beforeEach(() => {
  h.state.connections = new Set();
  h.state.invitations = new Map();
  h.state.rateState = null;
  h.state.config = {};
  h.state.seat = true;
  h.state.inviteStatus = null;
  h.state.profileFound = true;
  h.posts.length = 0;
  for (const k of Object.keys(h.out) as Array<keyof typeof h.out>) h.out[k].length = 0;
});
afterEach(() => vi.clearAllMocks());

describe("connect: input validation", () => {
  it("refuses a note over LinkedIn's 300-char cap without touching the network", async () => {
    await connectCommand(SLUG, { note: "x".repeat(301) });
    expect(h.out.errors[0]).toMatch(/300/);
    expect(h.posts).toHaveLength(0);
  });

  it("accepts a note of exactly 300", async () => {
    await connectCommand(SLUG, { note: "x".repeat(300) });
    expect(h.posts).toHaveLength(1);
  });

  it("rejects a URL that isn't a LinkedIn profile", async () => {
    // Bare words are treated as slugs; only URL-shaped input is validated,
    // so this is what actually exercises the rejection path.
    await connectCommand("https://example.com/someone", {});
    expect(h.out.errors[0]).toMatch(/Cannot resolve/);
    expect(h.posts).toHaveLength(0);
  });

  it("accepts a full LinkedIn profile URL", async () => {
    await connectCommand("https://www.linkedin.com/in/synthetic-target/", {});
    expect(h.posts).toHaveLength(1);
  });

  it("stops when the profile does not exist", async () => {
    h.state.profileFound = false;
    await connectCommand(SLUG, {});
    expect(h.out.errors[0]).toMatch(/not found/);
    expect(h.posts).toHaveLength(0);
  });
});

describe("connect: duplicate guards", () => {
  it("refuses someone already in the connections store", async () => {
    h.state.connections.add(TARGET_ID);
    await connectCommand(SLUG, {});
    expect(h.out.successes[0]).toMatch(/Already connected/);
    expect(h.posts).toHaveLength(0);
  });

  it("refuses someone already invited", async () => {
    h.state.invitations.set(TARGET_ID, { sentAt: "2026-06-01T00:00:00.000Z", note: null });
    await connectCommand(SLUG, {});
    expect(h.out.successes[0]).toMatch(/Already invited/);
    expect(h.posts).toHaveLength(0);
  });
});

describe("connect: dry run", () => {
  it("sends nothing and records nothing", async () => {
    await connectCommand(SLUG, { note: "hello", dryRun: true });
    expect(h.posts).toHaveLength(0);
    expect(h.state.invitations.size).toBe(0);
    expect(h.out.infos.join(" ")).toMatch(/dry-run/);
  });

  it("does not consume invitation quota", async () => {
    await connectCommand(SLUG, { dryRun: true });
    expect(h.state.rateState).toBeNull();
  });
});

describe("connect: sending", () => {
  it("posts the invitation and records it", async () => {
    await connectCommand(SLUG, { note: "would love to connect" });
    expect(h.posts).toHaveLength(1);
    expect(h.posts[0]?.data).toEqual({
      invitee: { inviteeUnion: { memberProfile: TARGET_URN } },
      customMessage: "would love to connect",
    });
    expect(h.state.invitations.get(TARGET_ID)?.note).toBe("would love to connect");
  });

  it("omits customMessage entirely when no note is given", async () => {
    await connectCommand(SLUG, {});
    expect((h.posts[0]?.data as { customMessage?: string }).customMessage).toBeUndefined();
    expect(h.state.invitations.get(TARGET_ID)?.note).toBeNull();
  });

  it("records the invitation in the quota ledger", async () => {
    await connectCommand(SLUG, {});
    expect((h.state.rateState?.inviteTimestamps as number[]).length).toBe(1);
  });
});

describe("connect: quota", () => {
  it("refuses once the daily cap is spent, and sends nothing", async () => {
    h.state.config = { rateLimit: { maxInvitesPerDay: 1 } };
    h.state.rateState = { lastMessageSentAt: 0, inviteTimestamps: [Date.now()] };
    await connectCommand(SLUG, {});
    expect(h.out.errors[0]).toMatch(/Daily invitation limit/);
    expect(h.posts).toHaveLength(0);
  });

  it("mentions the missing seat when there isn't one", async () => {
    h.state.seat = false;
    h.state.config = { rateLimit: { maxInvitesPerDay: 1 } };
    h.state.rateState = { lastMessageSentAt: 0, inviteTimestamps: [Date.now()] };
    await connectCommand(SLUG, {});
    expect(h.out.errors[0]).toMatch(/Sales Navigator seat/);
  });
});

describe("connect: failure handling", () => {
  it("explains a 403 as a likely invitation-quota hit", async () => {
    h.state.inviteStatus = 403;
    await connectCommand(SLUG, {});
    expect(h.out.errors[0]).toMatch(/invitation limit/i);
    // Nothing recorded when the send failed.
    expect(h.state.invitations.size).toBe(0);
  });
});
