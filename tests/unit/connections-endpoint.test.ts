/**
 * Unit tests for the 1st-degree connections endpoint parser.
 *
 * All ids/slugs/names below are synthetic placeholders — they intentionally do
 * not correspond to any real LinkedIn profile.
 */
import { describe, expect, it } from "vitest";
import { parseConnectionsResponse } from "../../src/linkedin/api/endpoints/connections.js";

const PROFILE_A = "urn:li:fsd_profile:ACoAAB0000000000000000000000000000000001";
const PROFILE_B = "urn:li:fsd_profile:ACoAAB0000000000000000000000000000000002";
const CONN_A = "urn:li:fsd_connection:ACoAAB0000000000000000000000000000000001";
const CONN_B = "urn:li:fsd_connection:ACoAAB0000000000000000000000000000000002";

function makeResponse(opts: {
  connections: Array<{ connUrn: string; memberUrn: string; createdAt?: number }>;
  profiles: Array<{
    urn: string;
    publicIdentifier?: string;
    firstName?: string;
    lastName?: string;
    headline?: string;
  }>;
  pagingCount?: number;
}) {
  return {
    data: {
      paging: { count: opts.pagingCount ?? opts.connections.length, start: 0 },
      "*elements": opts.connections.map((c) => c.connUrn),
    },
    included: [
      ...opts.connections.map((c) => ({
        $type: "com.linkedin.voyager.dash.relationships.Connection",
        entityUrn: c.connUrn,
        connectedMember: c.memberUrn,
        createdAt: c.createdAt,
      })),
      ...opts.profiles.map((p) => ({
        $type: "com.linkedin.voyager.dash.identity.profile.Profile",
        entityUrn: p.urn,
        publicIdentifier: p.publicIdentifier,
        firstName: p.firstName,
        lastName: p.lastName,
        headline: p.headline,
      })),
    ],
  };
}

describe("parseConnectionsResponse", () => {
  it("joins connections to profile entries via connectedMember", () => {
    const resp = makeResponse({
      connections: [
        { connUrn: CONN_A, memberUrn: PROFILE_A, createdAt: 1700000000000 },
        { connUrn: CONN_B, memberUrn: PROFILE_B, createdAt: 1700100000000 },
      ],
      profiles: [
        {
          urn: PROFILE_A,
          publicIdentifier: "example-user-1",
          firstName: "Alpha",
          lastName: "Tester",
          headline: "Synthetic Headline A",
        },
        {
          urn: PROFILE_B,
          publicIdentifier: "Example-User-2",
          firstName: "Bravo",
          lastName: "Tester",
        },
      ],
    });
    const { records, isLastPage } = parseConnectionsResponse(resp, 2);
    expect(records).toEqual([
      {
        memberUrn: PROFILE_A,
        publicIdentifier: "example-user-1",
        firstName: "Alpha",
        lastName: "Tester",
        headline: "Synthetic Headline A",
        connectedAt: 1700000000000,
      },
      {
        memberUrn: PROFILE_B,
        publicIdentifier: "example-user-2", // lowercased
        firstName: "Bravo",
        lastName: "Tester",
        headline: null,
        connectedAt: 1700100000000,
      },
    ]);
    expect(isLastPage).toBe(false);
  });

  it("marks last page when fewer records than requested", () => {
    const resp = makeResponse({
      connections: [{ connUrn: CONN_A, memberUrn: PROFILE_A }],
      profiles: [{ urn: PROFILE_A, publicIdentifier: "example-user-1" }],
    });
    const { records, isLastPage } = parseConnectionsResponse(resp, 10);
    expect(records).toHaveLength(1);
    expect(isLastPage).toBe(true);
  });

  it("skips connections whose profile is missing from `included`", () => {
    const resp = makeResponse({
      connections: [
        { connUrn: CONN_A, memberUrn: PROFILE_A },
        { connUrn: CONN_B, memberUrn: PROFILE_B },
      ],
      profiles: [{ urn: PROFILE_A, publicIdentifier: "example-user-1" }],
    });
    const { records } = parseConnectionsResponse(resp, 2);
    // Without the profile we still emit the record (id-only) — connectedMember is enough.
    expect(records.map((r) => r.memberUrn)).toEqual([PROFILE_A, PROFILE_B]);
    expect(records[1]?.publicIdentifier).toBeNull();
    expect(records[1]?.firstName).toBeNull();
  });

  it("handles {text} wrapped name fields (graphql-style)", () => {
    const resp = makeResponse({
      connections: [{ connUrn: CONN_A, memberUrn: PROFILE_A }],
      profiles: [{ urn: PROFILE_A }],
    });
    // Inject {text:} variant for firstName via direct included push
    const profileEntry = resp.included.find(
      (i) => (i as { entityUrn?: string }).entityUrn === PROFILE_A
    ) as { firstName?: unknown; lastName?: unknown };
    profileEntry.firstName = { text: "Charlie" };
    profileEntry.lastName = { text: "Tester" };
    const { records } = parseConnectionsResponse(resp, 1);
    expect(records[0]?.firstName).toBe("Charlie");
    expect(records[0]?.lastName).toBe("Tester");
  });

  it("returns empty page cleanly", () => {
    const resp = makeResponse({ connections: [], profiles: [], pagingCount: 0 });
    const { records, isLastPage } = parseConnectionsResponse(resp, 10);
    expect(records).toEqual([]);
    expect(isLastPage).toBe(true);
  });
});
