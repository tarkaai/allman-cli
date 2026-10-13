/**
 * `allman send --audio/--file`: the upload handshake and the render units
 * that ride on createMessage. The metadata/PUT shapes mirror the web client
 * and are exercised against mocks only.
 */
import { describe, expect, it, vi } from "vitest";
import type { LinkedInApiClient } from "@/linkedin/api/client.js";
import {
  buildAudioRenderContent,
  buildFileRenderContent,
  buildUploadMetadataPayload,
  mimeTypeFor,
  parseUploadSlot,
  requestUploadSlot,
} from "@/linkedin/api/endpoints/media-upload.js";
import { sendFirstMessage, sendMessage } from "@/linkedin/api/endpoints/messages.js";

const ME = "urn:li:fsd_profile:ACoSYNTHME000000000000000000000000001";

describe("media upload handshake", () => {
  it("asks for a slot with the voice upload type and parses urn + PUT url", async () => {
    const request = vi.fn().mockResolvedValue({
      value: {
        urn: "urn:li:digitalmediaAsset:D5620AQ",
        singleUploadUrl: "https://www.linkedin.com/dms-uploads/abc",
        singleUploadHeaders: { "Content-Type": "application/octet-stream" },
      },
    });
    const slot = await requestUploadSlot(
      { request } as unknown as LinkedInApiClient,
      "audio",
      1234,
      "note.m4a"
    );
    expect(request.mock.calls[0]?.[0]).toMatchObject({
      method: "POST",
      params: { action: "upload" },
      data: { mediaUploadType: "MESSAGING_VOICE_MESSAGE", fileSize: 1234, filename: "note.m4a" },
    });
    expect(slot.assetUrn).toBe("urn:li:digitalmediaAsset:D5620AQ");
    expect(slot.singleUploadUrl).toBe("https://www.linkedin.com/dms-uploads/abc");
    expect(slot.singleUploadHeaders).toEqual({ "Content-Type": "application/octet-stream" });
  });

  it("parses the normalized data/*value form too, and rejects missing urls", () => {
    expect(
      parseUploadSlot({
        data: { "*value": "urn:x" },
        included: [
          { entityUrn: "urn:x", urn: "urn:li:digitalmediaAsset:1", singleUploadUrl: "https://u" },
        ],
      })
    ).toMatchObject({ assetUrn: "urn:li:digitalmediaAsset:1" });
    expect(parseUploadSlot({ value: { urn: "urn:li:digitalmediaAsset:1" } })).toBeNull();
  });

  it("builds file metadata with the file upload type and infers mime types", () => {
    expect(buildUploadMetadataPayload("file", 9, "deck.pdf").mediaUploadType).toBe(
      "MESSAGING_FILE_ATTACHMENT"
    );
    expect(mimeTypeFor("note.m4a")).toBe("audio/mp4");
    expect(mimeTypeFor("x.unknownext")).toBe("application/octet-stream");
  });
});

describe("send with attachments", () => {
  const ok = () =>
    vi.fn().mockResolvedValue({
      data: {
        value: {
          backendUrn: "urn:li:messagingMessage:2-new",
          conversationUrn: "c",
          backendConversationUrn: "b",
          deliveredAt: 1,
        },
      },
    });

  it("puts the audio unit in renderContentUnions, after a reply quote", async () => {
    const request = ok();
    await sendMessage(
      { request } as unknown as LinkedInApiClient,
      "urn:li:messagingThread:2-conv",
      ME,
      "",
      undefined,
      [buildAudioRenderContent("urn:li:digitalmediaAsset:A", 12_300)]
    );
    const units = request.mock.calls[0]?.[0]?.data.message.renderContentUnions;
    expect(units).toEqual([
      { audio: { assetUrn: "urn:li:digitalmediaAsset:A", duration: 12_300 } },
    ]);
    expect(request.mock.calls[0]?.[0]?.data.message.body.text).toBe("");
  });

  it("new conversations carry the file unit", async () => {
    const request = ok();
    await sendFirstMessage(
      { request } as unknown as LinkedInApiClient,
      "urn:li:fsd_profile:THEM",
      ME,
      "see attached",
      [buildFileRenderContent("urn:li:digitalmediaAsset:F", 10, "application/pdf", "deck.pdf")]
    );
    const payload = request.mock.calls[0]?.[0]?.data;
    expect(payload.hostRecipientUrns).toEqual(["urn:li:fsd_profile:THEM"]);
    expect(payload.message.renderContentUnions).toEqual([
      {
        file: {
          assetUrn: "urn:li:digitalmediaAsset:F",
          byteSize: 10,
          mediaType: "application/pdf",
          name: "deck.pdf",
        },
      },
    ]);
  });
});
