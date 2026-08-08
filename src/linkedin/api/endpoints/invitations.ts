/**
 * Connection invitations — send a connection request, optionally with a note.
 *
 *   POST /voyager/api/voyagerRelationshipsDashMemberRelationships
 *        ?action=verifyQuotaAndCreateV2
 *        &decorationId=com.linkedin.voyager.dash.deco.relationships.InvitationCreationResultWithInvitee-2
 *
 *   payload: {
 *     invitee: { inviteeUnion: { memberProfile: "urn:li:fsd_profile:<id>" } },
 *     customMessage?: "<note>"
 *   }
 *
 * Success is signalled by an `invitationUrn` in the response value.
 *
 * Reference: monorepo `sendConnectionRequestViaLinkedinGraphApi`.
 */
import type { LinkedInApiClient } from "../client.js";

const INVITE_URL =
  "https://www.linkedin.com/voyager/api/voyagerRelationshipsDashMemberRelationships";
const INVITE_DECORATION =
  "com.linkedin.voyager.dash.deco.relationships.InvitationCreationResultWithInvitee-2";

/** LinkedIn's hard cap on the connection-request note length. */
export const MAX_NOTE_LENGTH = 300;

export interface SendInvitationResult {
  /** `urn:li:fsd_invitation:<id>` */
  invitationUrn: string;
}

interface InvitePayload {
  invitee: { inviteeUnion: { memberProfile: string } };
  customMessage?: string;
}

interface InviteResponse {
  // Normalized and flat forms both observed.
  value?: { invitationUrn?: string };
  data?: { value?: { invitationUrn?: string }; ["*value"]?: string };
}

/**
 * Send a connection request to a profile.
 *
 * @param profileUrn  Recipient's profile URN (`urn:li:fsd_profile:<id>`) or bare id.
 * @param note        Optional custom note (<= MAX_NOTE_LENGTH chars). Caller validates length.
 * @throws if LinkedIn does not return an invitationUrn (the request was not created).
 */
export async function sendConnectionRequest(
  client: LinkedInApiClient,
  profileUrn: string,
  note?: string
): Promise<SendInvitationResult> {
  const memberProfile = profileUrn.startsWith("urn:li:fsd_profile:")
    ? profileUrn
    : `urn:li:fsd_profile:${profileUrn}`;

  const payload: InvitePayload = {
    invitee: { inviteeUnion: { memberProfile } },
  };
  if (note && note.length > 0) payload.customMessage = note;

  const resp = await client.request<InviteResponse>({
    method: "POST",
    url: INVITE_URL,
    params: { action: "verifyQuotaAndCreateV2", decorationId: INVITE_DECORATION },
    data: payload,
  });

  const invitationUrn = parseInvitationUrn(resp);
  if (!invitationUrn) {
    throw new Error("LinkedIn did not return an invitationUrn — the request was not created.");
  }
  return { invitationUrn };
}

/** Pull the invitationUrn out of either response shape. Exposed for tests. */
export function parseInvitationUrn(resp: InviteResponse): string | null {
  return (
    resp.value?.invitationUrn ?? resp.data?.value?.invitationUrn ?? resp.data?.["*value"] ?? null
  );
}
