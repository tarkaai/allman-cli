/**
 * Group creation at the transport layer — no network, the client is a stub.
 *
 *   - `sendFirstMessage` with several recipients posts ONE createMessage whose
 *     `hostRecipientUrns` lists them all and whose `message` carries no
 *     `conversationUrn` key (the web client's new-thread shape, unchanged from
 *     the 1:1 case except for the recipient list).
 *   - The new thread's URN is read from the created message in the response
 *     (`included[data["*value"]].backendConversationUrn`).
 *   - `findConversationsByRecipients` queries `recipients:List(…)` with every
 *     recipient and keeps only threads whose membership is exactly me + them.
 */

import { describe, expect, it, vi } from "vitest";
import type { LinkedInApiClient } from "@/linkedin/api/client.js";
import {
  findConversationByRecipient,
  findConversationsByRecipients,
} from "@/linkedin/api/endpoints/conversations.js";
import { sendFirstMessage } from "@/linkedin/api/endpoints/messages.js";

const ME_ID = "ACoAAEXAMPLE000000000000000000000000ME";
const ME = `urn:li:fsd_profile:${ME_ID}`;
const AVERY = "urn:li:fsd_profile:ACoAAEXAMPLE000001";
const BLAKE = "urn:li:fsd_profile:ACoAAEXAMPLE000002";
const NEW_CONV_ID = "2-R3JvdXBFeGFtcGxlVGhyZWFk";

describe("sendFirstMessage — group creation payload", () => {
  it("posts every recipient in hostRecipientUrns and omits conversationUrn", async () => {
    const request = vi.fn().mockResolvedValue({
      data: { "*value": `urn:li:msg_message:(${ME},2-sent1)` },
      included: [
        {
          entityUrn: `urn:li:msg_message:(${ME},2-sent1)`,
          backendUrn: "urn:li:messagingMessage:2-sent1",
          conversationUrn: `urn:li:msg_conversation:(${ME},${NEW_CONV_ID})`,
          backendConversationUrn: `urn:li:messagingThread:${NEW_CONV_ID}`,
          deliveredAt: 1786982000000,
        },
      ],
    });
    const client = { request } as unknown as LinkedInApiClient;

    const result = await sendFirstMessage(client, [AVERY, BLAKE], ME, "hi both");

    expect(request).toHaveBeenCalledTimes(1);
    const call = request.mock.calls[0]?.[0];
    expect(call.method).toBe("POST");
    expect(call.url).toBe(
      "https://www.linkedin.com/voyager/api/voyagerMessagingDashMessengerMessages"
    );
    expect(call.params).toEqual({ action: "createMessage" });

    const payload = call.data;
    expect(payload.hostRecipientUrns).toEqual([AVERY, BLAKE]);
    expect(payload.mailboxUrn).toBe(ME);
    expect(payload.dedupeByClientGeneratedToken).toBe(false);
    expect(typeof payload.trackingId).toBe("string");
    expect(payload.message.body).toEqual({ attributes: [], text: "hi both" });
    expect(payload.message.renderContentUnions).toEqual([]);
    expect(typeof payload.message.originToken).toBe("string");
    // The key must be absent, not an empty string — LinkedIn 400s on the latter.
    expect("conversationUrn" in payload.message).toBe(false);
    expect(Object.keys(payload).sort()).toEqual([
      "dedupeByClientGeneratedToken",
      "hostRecipientUrns",
      "mailboxUrn",
      "message",
      "trackingId",
    ]);

    // The created message names the new thread.
    expect(result).toEqual({
      messageUrn: "urn:li:messagingMessage:2-sent1",
      conversationUrn: `urn:li:msg_conversation:(${ME},${NEW_CONV_ID})`,
      backendConversationUrn: `urn:li:messagingThread:${NEW_CONV_ID}`,
      deliveredAt: 1786982000000,
    });
  });

  it("keeps the 1:1 shape for a single recipient (string or one-element list)", async () => {
    const request = vi.fn().mockResolvedValue({
      data: { value: { backendUrn: "urn:li:messagingMessage:2-x", deliveredAt: 1 } },
    });
    const client = { request } as unknown as LinkedInApiClient;
    await sendFirstMessage(client, AVERY, ME, "hi");
    await sendFirstMessage(client, [AVERY], ME, "hi");
    for (const call of request.mock.calls) {
      expect(call[0].data.hostRecipientUrns).toEqual([AVERY]);
      expect("conversationUrn" in call[0].data.message).toBe(false);
    }
  });

  it("refuses an empty recipient list without touching the network", async () => {
    const request = vi.fn();
    const client = { request } as unknown as LinkedInApiClient;
    await expect(sendFirstMessage(client, [], ME, "hi")).rejects.toThrow(/at least one/);
    expect(request).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

function participant(urn: string, first: string) {
  return {
    $type: "com.linkedin.messenger.MessagingParticipant",
    entityUrn: `urn:li:msg_messagingParticipant:${urn}`,
    backendUrn: `urn:li:msg_messagingParticipant:${urn}`,
    hostIdentityUrn: urn,
    participantType: { member: { firstName: { text: first }, lastName: { text: "Example" } } },
  };
}

function conversation(id: string, members: string[], lastActivityAt: number) {
  const urn = `urn:li:msg_conversation:(${ME},${id})`;
  return {
    urn,
    entity: {
      $type: "com.linkedin.messenger.Conversation",
      entityUrn: urn,
      backendUrn: `urn:li:messagingThread:${id}`,
      groupChat: members.length > 2,
      lastActivityAt,
      "*conversationParticipants": members.map((m) => `urn:li:msg_messagingParticipant:${m}`),
    },
  };
}

describe("findConversationsByRecipients", () => {
  const oneToOne = conversation("2-one", [ME, AVERY], 10);
  const groupOld = conversation("2-groupOld", [ME, AVERY, BLAKE], 5);
  const groupNew = conversation("2-groupNew", [ME, AVERY, BLAKE], 20);
  const bigger = conversation(
    "2-bigger",
    [ME, AVERY, BLAKE, "urn:li:fsd_profile:ACoAAEXAMPLE000003"],
    30
  );
  const response = {
    data: {
      data: {
        messengerConversationsByRecipients: {
          "*elements": [oneToOne.urn, groupOld.urn, groupNew.urn, bigger.urn],
        },
      },
    },
    included: [
      oneToOne.entity,
      groupOld.entity,
      groupNew.entity,
      bigger.entity,
      participant(ME, "Me"),
      participant(AVERY, "Avery"),
      participant(BLAKE, "Blake"),
      participant("urn:li:fsd_profile:ACoAAEXAMPLE000003", "Casey"),
    ],
  };

  it("lists every recipient in the query and keeps only exact-membership threads, newest first", async () => {
    const request = vi.fn().mockResolvedValue(response);
    const client = { request } as unknown as LinkedInApiClient;

    const matches = await findConversationsByRecipients(client, [AVERY, BLAKE], ME);

    const url: string = request.mock.calls[0]?.[0]?.url;
    expect(url).toContain(
      `recipients:List(${encodeURIComponent(AVERY)},${encodeURIComponent(BLAKE)})`
    );
    expect(url).toContain(`mailboxUrn:${encodeURIComponent(ME)}`);
    expect(matches.map((m) => m.backendUrn)).toEqual([
      "urn:li:messagingThread:2-groupNew",
      "urn:li:messagingThread:2-groupOld",
    ]);
    expect(matches[0]?.isGroup).toBe(true);
    expect(matches[0]?.participants.map((p) => p.entityUrn)).toEqual([ME, AVERY, BLAKE]);
  });

  it("drops the signed-in user from the recipient list and returns [] when nobody is left", async () => {
    const request = vi.fn().mockResolvedValue(response);
    const client = { request } as unknown as LinkedInApiClient;
    expect(await findConversationsByRecipients(client, [ME], ME)).toEqual([]);
    expect(request).not.toHaveBeenCalled();

    await findConversationsByRecipients(client, [ME, AVERY, BLAKE], ME);
    const url: string = request.mock.calls[0]?.[0]?.url;
    expect(url).not.toContain(`List(${encodeURIComponent(ME)}`);
  });

  it("findConversationByRecipient still returns only the 1:1 thread", async () => {
    const request = vi.fn().mockResolvedValue(response);
    const client = { request } as unknown as LinkedInApiClient;
    const c = await findConversationByRecipient(client, AVERY, ME);
    expect(c?.backendUrn).toBe("urn:li:messagingThread:2-one");
    expect(c?.isGroup).toBe(false);
  });
});
