/**
 * Unit tests for the connection-invitation endpoint.
 * Synthetic ids only; the API client is faked (no network).
 */
import { describe, expect, it, vi } from "vitest";
import type { LinkedInApiClient } from "@/linkedin/api/client.js";
import {
  MAX_NOTE_LENGTH,
  parseInvitationUrn,
  sendConnectionRequest,
} from "@/linkedin/api/endpoints/invitations.js";

const PROFILE_ID = "ACoSYNTH0000000000000000000000000000001";
const PROFILE_URN = `urn:li:fsd_profile:${PROFILE_ID}`;
const INVITATION_URN = "urn:li:fsd_invitation:7000000000000000000";

describe("parseInvitationUrn", () => {
  it("reads the flat value shape", () => {
    expect(parseInvitationUrn({ value: { invitationUrn: INVITATION_URN } })).toBe(INVITATION_URN);
  });
  it("reads the normalized data.value shape", () => {
    expect(parseInvitationUrn({ data: { value: { invitationUrn: INVITATION_URN } } })).toBe(
      INVITATION_URN
    );
  });
  it("reads the data['*value'] ref shape", () => {
    expect(parseInvitationUrn({ data: { "*value": INVITATION_URN } })).toBe(INVITATION_URN);
  });
  it("returns null when no invitationUrn is present", () => {
    expect(parseInvitationUrn({})).toBeNull();
    expect(parseInvitationUrn({ value: {} })).toBeNull();
  });
});

describe("sendConnectionRequest", () => {
  function fakeClient(response: unknown) {
    const request = vi.fn().mockResolvedValue(response);
    return { client: { request } as unknown as LinkedInApiClient, request };
  }

  type Call = {
    method: string;
    url: string;
    params: Record<string, string>;
    data: { invitee: { inviteeUnion: { memberProfile: string } }; customMessage?: string };
  };

  it("posts the verifyQuotaAndCreateV2 action with the memberProfile + note", async () => {
    const { client, request } = fakeClient({ value: { invitationUrn: INVITATION_URN } });
    const res = await sendConnectionRequest(client, PROFILE_URN, "Hi there");
    expect(res.invitationUrn).toBe(INVITATION_URN);

    const call = request.mock.calls[0]?.[0] as Call;
    expect(call.method).toBe("POST");
    expect(call.url).toContain("voyagerRelationshipsDashMemberRelationships");
    expect(call.params.action).toBe("verifyQuotaAndCreateV2");
    expect(call.data).toEqual({
      invitee: { inviteeUnion: { memberProfile: PROFILE_URN } },
      customMessage: "Hi there",
    });
  });

  it("omits customMessage when no note is given", async () => {
    const { client, request } = fakeClient({ value: { invitationUrn: INVITATION_URN } });
    await sendConnectionRequest(client, PROFILE_ID); // bare id, no note
    const call = request.mock.calls[0]?.[0] as Call;
    expect(call.data.customMessage).toBeUndefined();
    // bare id gets normalized to a full URN
    expect(call.data.invitee.inviteeUnion.memberProfile).toBe(PROFILE_URN);
  });

  it("throws when LinkedIn returns no invitationUrn", async () => {
    const { client } = fakeClient({ value: {} });
    await expect(sendConnectionRequest(client, PROFILE_URN)).rejects.toThrow(/invitationUrn/);
  });

  it("exposes LinkedIn's 300-char note cap", () => {
    expect(MAX_NOTE_LENGTH).toBe(300);
  });
});
