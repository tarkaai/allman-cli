/**
 * `allman read` — marks a conversation as seen on LinkedIn via the dash
 * messenger conversations action, then flips the local RECORD to read.
 */
import { describe, expect, it, vi } from "vitest";
import type { LinkedInApiClient } from "@/linkedin/api/client.js";
import { markConversationsRead } from "@/linkedin/api/endpoints/conversations.js";

const ME = "urn:li:fsd_profile:ACoSYNTHME000000000000000000000000001";

describe("markConversationsRead", () => {
  it("PATCHes read=true on each msg_conversation URN", async () => {
    const request = vi.fn().mockResolvedValue({});
    const client = { request } as unknown as LinkedInApiClient;
    const urn = `urn:li:msg_conversation:(${ME},2-synthetic==)`;

    await markConversationsRead(client, [urn, `${urn}2`]);

    expect(request).toHaveBeenCalledTimes(2);
    const call = request.mock.calls[0]?.[0];
    expect(call.method).toBe("POST");
    expect(call.url).toBe(
      `https://www.linkedin.com/voyager/api/voyagerMessagingDashMessengerConversations/${encodeURIComponent(urn)}`
    );
    expect(call.params).toBeUndefined();
    expect(call.data).toEqual({ patch: { $set: { read: true } } });
  });

  it("is a no-op for an empty list", async () => {
    const request = vi.fn();
    await markConversationsRead({ request } as unknown as LinkedInApiClient, []);
    expect(request).not.toHaveBeenCalled();
  });
});
