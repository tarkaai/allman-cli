/**
 * LinkedIn URN utilities.
 *
 * URN shapes used in the LinkedIn API:
 *   urn:li:fsd_profile:{id}           — profile (person)
 *   urn:li:msg_conversation:...        — conversation (entity URN, used in frontend)
 *   urn:li:messagingThread:{id}        — conversation (backend URN, used in API payloads)
 *   urn:li:msg_message:{id}            — message (entity URN)
 *   urn:li:messagingMessage:{id}       — message (backend URN)
 *
 * The "full" conversation URN used in message send payloads:
 *   urn:li:msg_conversation:(urn:li:fsd_profile:{senderUrn},{conversationUrn})
 */

export type UrnType =
  | "fsd_profile"
  | "msg_conversation"
  | "messagingThread"
  | "msg_message"
  | "messagingMessage"
  | string;

export interface ParsedUrn {
  type: UrnType;
  id: string;
}

/** Parse a LinkedIn URN string into its type and ID components. */
export function parseUrn(urn: string): ParsedUrn {
  const match = urn.match(/^urn:li:([^:]+):(.+)$/);
  if (!match?.[1] || !match[2]) {
    throw new Error(`Invalid LinkedIn URN: ${urn}`);
  }
  return { type: match[1], id: match[2] };
}

/** Build a profile URN from a raw profile ID. */
export function profileUrn(id: string): string {
  return `urn:li:fsd_profile:${id}`;
}

/** Extract the raw ID from a profile URN. */
export function profileUrnId(urn: string): string {
  const parsed = parseUrn(urn);
  if (parsed.type !== "fsd_profile") {
    throw new Error(`Expected fsd_profile URN, got: ${urn}`);
  }
  return parsed.id;
}

/**
 * Build the conversation URN used inside message send payloads.
 *
 * Format: urn:li:msg_conversation:(urn:li:fsd_profile:{senderProfileId},{conversationUrn})
 */
export function buildSendConversationUrn(senderProfileId: string, conversationUrn: string): string {
  return `urn:li:msg_conversation:(urn:li:fsd_profile:${senderProfileId},${conversationUrn})`;
}

/** URL-encode a URN for use in query parameters. */
export function encodeUrn(urn: string): string {
  return encodeURIComponent(urn);
}

/** Check whether a string looks like a LinkedIn URN. */
export function isUrn(value: string): boolean {
  return /^urn:li:[^:]+:.+$/.test(value);
}

/**
 * Convert a UUID string to a byte array (Uint8Array of length 16).
 * Used to construct the trackingId field in message send payloads.
 *
 * Source: monorepo/lib/services/.../linkedin-api-services.ts
 */
export function uuidToByteArray(uuid: string): Uint8Array {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uuid)) {
    throw new TypeError(`Invalid UUID format: ${uuid}`);
  }

  const bytes = new Uint8Array(16);

  const s1 = parseInt(uuid.slice(0, 8), 16);
  bytes[0] = (s1 >>> 24) & 0xff;
  bytes[1] = (s1 >>> 16) & 0xff;
  bytes[2] = (s1 >>> 8) & 0xff;
  bytes[3] = s1 & 0xff;

  const s2 = parseInt(uuid.slice(9, 13), 16);
  bytes[4] = (s2 >>> 8) & 0xff;
  bytes[5] = s2 & 0xff;

  const s3 = parseInt(uuid.slice(14, 18), 16);
  bytes[6] = (s3 >>> 8) & 0xff;
  bytes[7] = s3 & 0xff;

  const s4 = parseInt(uuid.slice(19, 23), 16);
  bytes[8] = (s4 >>> 8) & 0xff;
  bytes[9] = s4 & 0xff;

  const s5 = parseInt(uuid.slice(24, 36), 16);
  bytes[10] = Math.floor(s5 / 1099511627776) & 0xff; // 2^40
  bytes[11] = Math.floor(s5 / 4294967296) & 0xff; // 2^32
  bytes[12] = (s5 >>> 24) & 0xff;
  bytes[13] = (s5 >>> 16) & 0xff;
  bytes[14] = (s5 >>> 8) & 0xff;
  bytes[15] = s5 & 0xff;

  return bytes;
}

/** Convert a Uint8Array to a string of characters (for trackingId). */
export function byteArrayToString(bytes: Uint8Array): string {
  return String.fromCharCode(...bytes);
}

/**
 * Extract the bare conversation ID from any conversation URN format.
 *   urn:li:msg_conversation:(urn:li:fsd_profile:...,2-...)  → 2-...
 *   urn:li:messagingThread:2-...                             → 2-...
 *   2-...                                                    → 2-...
 */
export function extractBareConvId(urn: string): string {
  const fullMatch = urn.match(/\(urn:li:fsd_profile:[^,]+,([^)]+)\)/);
  if (fullMatch?.[1]) return fullMatch[1];
  const threadMatch = urn.match(/urn:li:messagingThread:(.+)/);
  if (threadMatch?.[1]) return threadMatch[1];
  return urn;
}
