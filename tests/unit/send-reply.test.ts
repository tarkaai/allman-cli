/**
 * `allman send --reply-to`: the quoted message rides along as a
 * repliedMessageContent render unit, in the shape LinkedIn stores on replies.
 */
import { describe, expect, it, vi } from "vitest";
import type { LinkedInApiClient } from "@/linkedin/api/client.js";
import { buildReplyRenderContent, sendMessage } from "@/linkedin/api/endpoints/messages.js";

const ME = "urn:li:fsd_profile:ACoSYNTHME000000000000000000000000001";
const THEM = "urn:li:fsd_profile:ACoSYNTHTHEM00000000000000000000001";

describe("buildReplyRenderContent", () => {
  it("quotes the original with participant + composite message URNs", () => {
    const unit = buildReplyRenderContent(
      {
        messageUrn: "urn:li:messagingMessage:2-orig==",
        senderUrn: THEM,
        sentAt: 1_700_000_000_000,
        text: "original",
      },
      ME.replace("urn:li:fsd_profile:", "")
    ) as { repliedMessageContent: Record<string, unknown> };
    expect(unit.repliedMessageContent).toEqual({
      originalSender: `urn:li:msg_messagingParticipant:${THEM}`,
      originalMessage: `urn:li:msg_message:(${ME},2-orig==)`,
      originalSendAt: 1_700_000_000_000,
      messageBody: { attributes: [], text: "original" },
    });
  });
});

describe("sendMessage with replyTo", () => {
  it("puts the reply unit in renderContentUnions", async () => {
    const request = vi.fn().mockResolvedValue({
      data: {
        value: {
          backendUrn: "urn:li:messagingMessage:2-new",
          conversationUrn: "c",
          backendConversationUrn: "b",
          deliveredAt: 1,
        },
      },
    });
    const client = { request } as unknown as LinkedInApiClient;
    await sendMessage(client, "urn:li:messagingThread:2-conv", ME, "reply text", {
      messageUrn: "urn:li:messagingMessage:2-orig==",
      senderUrn: THEM,
      sentAt: 5,
      text: "original",
    });
    const payload = request.mock.calls[0]?.[0]?.data;
    expect(payload.message.body.text).toBe("reply text");
    expect(payload.message.renderContentUnions).toHaveLength(1);
    expect(payload.message.renderContentUnions[0].repliedMessageContent.messageBody.text).toBe(
      "original"
    );
  });

  it("sends an empty renderContentUnions without replyTo", async () => {
    const request = vi.fn().mockResolvedValue({
      data: { value: { backendUrn: "urn:li:messagingMessage:2-new", deliveredAt: 1 } },
    });
    await sendMessage(
      { request } as unknown as LinkedInApiClient,
      "urn:li:messagingThread:2-conv",
      ME,
      "hi"
    );
    expect(request.mock.calls[0]?.[0]?.data.message.renderContentUnions).toEqual([]);
  });
});
