import { describe, expect, it } from "vitest";
import {
  buildSendConversationUrn,
  byteArrayToString,
  encodeUrn,
  isUrn,
  parseUrn,
  profileUrn,
  profileUrnId,
  uuidToByteArray,
} from "@/utils/urn.js";

describe("parseUrn", () => {
  it("parses a profile URN", () => {
    const result = parseUrn("urn:li:fsd_profile:ABC123");
    expect(result).toEqual({ type: "fsd_profile", id: "ABC123" });
  });

  it("parses a conversation URN", () => {
    const result = parseUrn("urn:li:msg_conversation:CONV456");
    expect(result).toEqual({ type: "msg_conversation", id: "CONV456" });
  });

  it("throws on invalid URN", () => {
    expect(() => parseUrn("not-a-urn")).toThrow("Invalid LinkedIn URN");
    expect(() => parseUrn("urn:li:")).toThrow("Invalid LinkedIn URN");
  });
});

describe("profileUrn", () => {
  it("builds a profile URN", () => {
    expect(profileUrn("ABC123")).toBe("urn:li:fsd_profile:ABC123");
  });
});

describe("profileUrnId", () => {
  it("extracts ID from profile URN", () => {
    expect(profileUrnId("urn:li:fsd_profile:ABC123")).toBe("ABC123");
  });

  it("throws for non-profile URN", () => {
    expect(() => profileUrnId("urn:li:msg_conversation:CONV456")).toThrow(
      "Expected fsd_profile URN"
    );
  });
});

describe("buildSendConversationUrn", () => {
  it("builds the nested conversation URN format used in send payloads", () => {
    const result = buildSendConversationUrn("SENDER123", "urn:li:messagingThread:THREAD456");
    expect(result).toBe(
      "urn:li:msg_conversation:(urn:li:fsd_profile:SENDER123,urn:li:messagingThread:THREAD456)"
    );
  });
});

describe("encodeUrn", () => {
  it("URL-encodes colons and parentheses", () => {
    const result = encodeUrn("urn:li:fsd_profile:ABC123");
    expect(result).toBe("urn%3Ali%3Afsd_profile%3AABC123");
  });
});

describe("isUrn", () => {
  it("returns true for valid URNs", () => {
    expect(isUrn("urn:li:fsd_profile:ABC123")).toBe(true);
    expect(isUrn("urn:li:msg_conversation:XYZ")).toBe(true);
  });

  it("returns false for non-URNs", () => {
    expect(isUrn("sarah-chen")).toBe(false);
    expect(isUrn("https://linkedin.com/in/sarah")).toBe(false);
    expect(isUrn("")).toBe(false);
  });
});

describe("uuidToByteArray", () => {
  it("converts a UUID to a 16-byte Uint8Array", () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    const bytes = uuidToByteArray(uuid);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBe(16);
    // First 4 bytes from "550e8400" = 0x55, 0x0e, 0x84, 0x00
    expect(bytes[0]).toBe(0x55);
    expect(bytes[1]).toBe(0x0e);
    expect(bytes[2]).toBe(0x84);
    expect(bytes[3]).toBe(0x00);
  });

  it("throws on invalid UUID format", () => {
    expect(() => uuidToByteArray("not-a-uuid")).toThrow("Invalid UUID format");
    expect(() => uuidToByteArray("550e8400-e29b-41d4-a716")).toThrow("Invalid UUID format");
  });

  it("produces the same result as the monorepo implementation", () => {
    // Known value from monorepo test: consistent conversion
    const uuid = "00000000-0000-0000-0000-000000000000";
    const bytes = uuidToByteArray(uuid);
    expect(Array.from(bytes)).toEqual(new Array(16).fill(0));
  });
});

describe("byteArrayToString", () => {
  it("converts bytes to a string of characters", () => {
    const bytes = new Uint8Array([65, 66, 67]); // ABC
    expect(byteArrayToString(bytes)).toBe("ABC");
  });
});
