/**
 * Unit tests for SSE event parsing logic.
 * Tests the private parseEvent logic by testing the overall shape of parsed events.
 * No network required.
 */

import { describe, it, expect } from "vitest";

/**
 * Minimal reproduction of the SSE event parsing logic from SseClient.
 * We test the logic independently from the full client to keep tests fast.
 */

const TOPIC_REGEX = /:(\w+Topic):urn:li-realtime/;

function parseTopic(topic: string): string | null {
  const match = topic.match(TOPIC_REGEX);
  return match ? (match[1] ?? null) : null;
}

describe("SSE topic parsing", () => {
  it("extracts messagesTopic from a LinkedIn topic string", () => {
    const topic =
      "urn:li-realtime:messagesTopic:urn:li-realtime:messagesTopic:user123";
    expect(parseTopic(topic)).toBe("messagesTopic");
  });

  it("extracts typingIndicatorsTopic", () => {
    const topic = "urn:li-realtime:typingIndicatorsTopic:urn:li-realtime:etc";
    expect(parseTopic(topic)).toBe("typingIndicatorsTopic");
  });

  it("extracts messageSeenReceiptsTopic", () => {
    const topic = "urn:li-realtime:messageSeenReceiptsTopic:urn:li-realtime:etc";
    expect(parseTopic(topic)).toBe("messageSeenReceiptsTopic");
  });

  it("returns null for unrecognised topics", () => {
    expect(parseTopic("some-random-string")).toBeNull();
    expect(parseTopic("")).toBeNull();
  });
});

describe("SSE event shape detection", () => {
  it("detects connection event (has id, no topic)", () => {
    const data = { id: "conn-abc-123" };
    const isConnection = typeof data.id === "string" && !("topic" in data);
    expect(isConnection).toBe(true);
  });

  it("detects heartbeat event (empty object)", () => {
    const data = {};
    const isHeartbeat = Object.keys(data).length === 0;
    expect(isHeartbeat).toBe(true);
  });

  it("determines message is inbound (no originToken)", () => {
    const event = { originToken: null };
    const isEcho = event.originToken !== null && event.originToken !== undefined;
    expect(isEcho).toBe(false);
  });

  it("determines message is echo (has originToken)", () => {
    const event = { originToken: "some-uuid-here" };
    const isEcho = event.originToken !== null && event.originToken !== undefined && event.originToken !== "";
    expect(isEcho).toBe(true);
  });
});

describe("SSE data line parsing", () => {
  it("strips 'data:' prefix and parses JSON", () => {
    const line = 'data: {"id":"conn123"}';
    const jsonStr = line.startsWith("data:") ? line.slice(5).trim() : null;
    expect(jsonStr).toBe('{"id":"conn123"}');
    const parsed = JSON.parse(jsonStr!);
    expect(parsed).toEqual({ id: "conn123" });
  });

  it("skips non-data lines", () => {
    const lines = ["event: message", ": keep-alive", ""];
    const dataLines = lines.filter((l) => l.startsWith("data:"));
    expect(dataLines.length).toBe(0);
  });

  it("handles malformed JSON gracefully", () => {
    const line = "data: {broken json}";
    const jsonStr = line.slice(5).trim();
    let result: unknown = null;
    try {
      result = JSON.parse(jsonStr);
    } catch {
      result = null;
    }
    expect(result).toBeNull();
  });
});
