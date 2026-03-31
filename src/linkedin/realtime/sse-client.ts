/**
 * LinkedIn real-time SSE (Server-Sent Events) client.
 *
 * Connects to https://www.linkedin.com/realtime/connect?rc=1
 * and streams events as NDJSON to the caller via an async generator.
 *
 * Event topics handled (from mautrix constants.go + lilac/api stream-handler.ts):
 *   messagesTopic           — new message
 *   typingIndicatorsTopic   — typing indicator
 *   readReceiptsTopic / messageSeenReceiptsTopic — read receipt
 *   conversationsTopic      — conversation metadata update
 *   messageReactionSummariesTopic — reaction added/removed
 *   ClientConnection        — connection established
 *   Heartbeat               — keep-alive
 *
 * Reconnection: exponential backoff 1s → 2s → 4s → 8s … max 60s.
 * Sends a heartbeat POST every 60s to keep the connection alive.
 *
 * Source: lilac/api/src/services/realtime/stream-handler.ts
 *         monorepo/lib/services/.../linkedin-api-services.ts
 */

import axios from "axios";
import { createInterface } from "readline";
import type { LinkedInApiClient } from "../api/client.js";
import { buildCookieHeader, getCsrfToken } from "../api/cookies.js";
import * as output from "../../utils/output.js";

const SSE_URL = "https://www.linkedin.com/realtime/connect";
const HEARTBEAT_URL =
  "https://www.linkedin.com/realtime/realtimeFrontendClientConnectivityTracking";
const HEARTBEAT_INTERVAL_MS = 60_000;

// Regex to extract event topic name from the topic string
// e.g. "urn:li-realtime:messagesTopic:..." → "messagesTopic"
const TOPIC_REGEX = /:(\w+Topic):urn:li-realtime/;

// ---------------------------------------------------------------------------
// Event types emitted by the SSE client
// ---------------------------------------------------------------------------

export type SseEventType =
  | "connected"
  | "message.received"
  | "message.sent_echo"
  | "typing"
  | "read_receipt"
  | "reaction"
  | "heartbeat"
  | "raw"; // unrecognised events, forwarded as-is

export interface SseEvent {
  type: SseEventType;
  raw?: unknown;
  // Populated for message.received / message.sent_echo
  messageUrn?: string;
  conversationUrn?: string;
  fromUrn?: string;
  body?: string;
  timestamp?: number;
  originToken?: string;
  reactions?: Array<{ emoji: string; count: number; hasUserReacted: boolean }>;
  // Populated for typing
  durationMs?: number;
  // Populated for connected
  connectionId?: string;
}

// ---------------------------------------------------------------------------
// SSE client
// ---------------------------------------------------------------------------

export interface SseClientOptions {
  /** Max reconnect attempts before giving up (0 = unlimited). Default: 0. */
  maxReconnectAttempts?: number;
  /** Initial backoff in ms. Default: 1000. */
  initialBackoffMs?: number;
}

export class SseClient {
  private abortController: AbortController | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private connectionId: string | null = null;
  private senderProfileUrn: string | null = null;
  private mpVersion = "1.13.8751";

  constructor(
    private readonly apiClient: LinkedInApiClient,
    senderProfileId: string,
    private readonly options: SseClientOptions = {}
  ) {
    this.senderProfileUrn = `urn:li:fsd_profile:${senderProfileId}`;
  }

  /**
   * Connect to the SSE stream and yield events.
   * This is an async generator — consume it with `for await (const event of client.connect())`.
   * Reconnects automatically on disconnect until aborted or maxReconnectAttempts reached.
   */
  async *connect(): AsyncGenerator<SseEvent> {
    const maxAttempts = this.options.maxReconnectAttempts ?? 0;
    const initialBackoff = this.options.initialBackoffMs ?? 1000;

    let attempts = 0;

    while (maxAttempts === 0 || attempts < maxAttempts) {
      this.abortController = new AbortController();
      const backoffMs = Math.min(initialBackoff * Math.pow(2, attempts), 60_000);

      if (attempts > 0) {
        output.debug(`SSE reconnecting in ${backoffMs}ms (attempt ${attempts + 1})`);
        await sleep(backoffMs);
      }

      attempts++;

      try {
        for await (const event of this.streamEvents()) {
          yield event;
          // Reset attempt counter on successful events
          attempts = 0;
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        output.debug(`SSE stream error: ${msg}`);
        yield {
          type: "raw",
          raw: { error: msg },
        };
      } finally {
        this.stopHeartbeat();
      }
    }

    output.debug(`SSE giving up after ${attempts} reconnect attempts`);
  }

  /** Abort the current connection. */
  abort(): void {
    this.abortController?.abort();
    this.stopHeartbeat();
  }

  private async *streamEvents(): AsyncGenerator<SseEvent> {
    const jar = this.apiClient.getJar();
    const cookieHeader = await buildCookieHeader(jar);
    const csrfToken = (await getCsrfToken(jar)) ?? "";

    output.debug("SSE: connecting to LinkedIn realtime stream");

    const response = await axios({
      method: "GET",
      url: SSE_URL,
      params: { rc: "1" },
      headers: {
        accept: "text/event-stream",
        "accept-language": "en-US,en;q=0.9",
        "x-li-lang": "en_US",
        "x-restli-protocol-version": "2.0.0",
        "x-li-track": JSON.stringify({
          clientVersion: "1.13.8751",
          mpVersion: "1.13.8751",
          osName: "web",
          timezoneOffset: -5,
          timezone: "America/New York",
          deviceFormFactor: "DESKTOP",
          mpName: "voyager-web",
          displayDensity: 1,
          displayWidth: 2560,
          displayHeight: 1440,
        }),
        "csrf-token": csrfToken,
        cookie: cookieHeader,
        referer: "https://www.linkedin.com/messaging/",
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
      responseType: "stream",
      timeout: 0, // no timeout for SSE
      maxRedirects: 0,
      validateStatus: () => true,
    });

    if (response.status === 401 || response.status === 302) {
      throw new Error(
        "LinkedIn session expired. Run `lilac login` to re-authenticate."
      );
    }

    output.debug(`SSE: connected (HTTP ${response.status})`);

    const rl = createInterface({
      input: response.data as NodeJS.ReadableStream,
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      if (!line.startsWith("data:")) continue;
      const jsonStr = line.slice(5).trim();
      if (!jsonStr) continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(jsonStr);
      } catch {
        output.debug(`SSE: failed to parse line: ${jsonStr.slice(0, 100)}`);
        continue;
      }

      const event = this.parseEvent(parsed);
      if (event) yield event;
    }
  }

  private parseEvent(data: unknown): SseEvent | null {
    if (!data || typeof data !== "object") return null;
    const d = data as Record<string, unknown>;

    // Connection established: {"com.linkedin.realtimefrontend.ClientConnection": {id, personalTopics, ...}}
    const clientConn = d["com.linkedin.realtimefrontend.ClientConnection"] as Record<string, unknown> | undefined;
    if (clientConn) {
      const id = typeof clientConn["id"] === "string" ? clientConn["id"] : null;
      if (id) {
        this.connectionId = id;
        this.startHeartbeat(id);
      }
      return { type: "connected", connectionId: this.connectionId ?? "" };
    }

    // Heartbeat: {"com.linkedin.realtimefrontend.Heartbeat": {...}} or empty object
    if (d["com.linkedin.realtimefrontend.Heartbeat"] !== undefined || Object.keys(d).length === 0) {
      return { type: "heartbeat" };
    }

    // Decorated event: {"com.linkedin.realtimefrontend.DecoratedEvent": {topic, payload}}
    const decorated = d["com.linkedin.realtimefrontend.DecoratedEvent"] as Record<string, unknown> | undefined;
    if (!decorated) {
      output.debug(`SSE: unknown event shape, top keys: ${Object.keys(d).join(", ")}`);
      return { type: "raw", raw: data };
    }

    const topic = typeof decorated["topic"] === "string" ? decorated["topic"] : null;
    if (!topic) return null;

    const topicMatch = topic.match(TOPIC_REGEX);
    const topicName = topicMatch ? topicMatch[1] : null;

    const payload = (decorated["payload"] ?? decorated) as Record<string, unknown>;

    if (topicName === "messagesTopic") {
      return this.parseMessageEvent(payload);
    }

    if (topicName === "typingIndicatorsTopic") {
      return this.parseTypingEvent(payload);
    }

    if (
      topicName === "readReceiptsTopic" ||
      topicName === "messageSeenReceiptsTopic"
    ) {
      return this.parseReadReceiptEvent(payload);
    }

    if (topicName === "messageReactionSummariesTopic") {
      return this.parseReactionEvent(payload);
    }

    // Forward unknown topics as raw events (debug)
    output.debug(`SSE: unhandled topic: ${topicName ?? topic}`);
    return { type: "raw", raw: data };
  }

  private parseMessageEvent(payload: Record<string, unknown>): SseEvent | null {
    // Navigate the nested event content structure
    const event = (payload["event"] as Record<string, unknown>) ?? payload;
    const eventContent =
      (event["eventContent"] as Record<string, unknown>) ??
      (event["com.linkedin.voyager.messaging.event.MessageEvent"] as Record<string, unknown>);

    if (!eventContent) {
      output.debug("SSE: message event missing eventContent");
      return null;
    }

    const body =
      (
        (eventContent["attributedBody"] as Record<string, unknown> | undefined) ??
        (eventContent["body"] as Record<string, unknown> | undefined)
      )?.["text"] as string | undefined;

    const fromMember =
      (event["from"] as Record<string, unknown> | undefined)?.[
        "com.linkedin.voyager.messaging.MessagingMember"
      ] as Record<string, unknown> | undefined;

    // fromUrn: normalize fs_miniProfile → fsd_profile
    const rawFromUrn =
      (fromMember?.["miniProfile"] as Record<string, unknown> | undefined)?.[
        "entityUrn"
      ] as string | undefined;
    const fromUrn = rawFromUrn?.replace("urn:li:fs_miniProfile:", "urn:li:fsd_profile:");

    const messageUrn =
      (event["entityUrn"] as string | undefined) ??
      (event["backendUrn"] as string | undefined);

    // conversationUrn: check payload/event fields, then extract from message URN
    // Message URN format: urn:li:fs_event:(CONV_BARE_ID,MSG_ID)
    let conversationUrn =
      (event["conversationUrn"] as string | undefined) ??
      (payload["conversationUrn"] as string | undefined);

    if (!conversationUrn && messageUrn) {
      const convMatch = messageUrn.match(/urn:li:fs_event:\(([^,]+),/);
      if (convMatch?.[1]) {
        conversationUrn = `urn:li:messagingThread:${convMatch[1]}`;
      }
    }

    const timestamp =
      (event["createdAt"] as number | undefined) ??
      (event["deliveredAt"] as number | undefined) ??
      Date.now();

    const originToken = (event["originToken"] as string | undefined) ?? null;

    // Determine direction: originToken present means it's an echo of our own send
    const isEcho =
      originToken !== null && originToken !== undefined && originToken !== "";

    return {
      type: isEcho ? "message.sent_echo" : "message.received",
      messageUrn,
      conversationUrn,
      fromUrn,
      body: body ?? "",
      timestamp,
      originToken: originToken ?? undefined,
    };
  }

  private parseTypingEvent(payload: Record<string, unknown>): SseEvent {
    return {
      type: "typing",
      conversationUrn: (payload["conversationUrn"] as string) ?? undefined,
      fromUrn: (payload["fromEntityUrn"] as string) ?? undefined,
      durationMs: (payload["durationMs"] as number) ?? undefined,
      timestamp: Date.now(),
      raw: payload,
    };
  }

  private parseReadReceiptEvent(payload: Record<string, unknown>): SseEvent {
    return {
      type: "read_receipt",
      conversationUrn: (payload["conversationUrn"] as string) ?? undefined,
      fromUrn: (payload["fromEntityUrn"] as string) ?? undefined,
      timestamp: (payload["seenAt"] as number) ?? Date.now(),
      raw: payload,
    };
  }

  private parseReactionEvent(payload: Record<string, unknown>): SseEvent {
    const summaries = payload["reactionSummaries"] as
      | Array<Record<string, unknown>>
      | undefined;
    return {
      type: "reaction",
      messageUrn: (payload["entityUrn"] as string) ?? undefined,
      conversationUrn: (payload["conversationUrn"] as string) ?? undefined,
      timestamp: Date.now(),
      reactions: (summaries ?? []).map((r) => ({
        emoji: (r["emoji"] as string) ?? "",
        count: (r["count"] as number) ?? 0,
        hasUserReacted: (r["hasUserReacted"] as boolean) ?? false,
      })),
      raw: payload,
    };
  }

  private startHeartbeat(connectionId: string): void {
    this.stopHeartbeat();
    let isFirst = true;

    this.heartbeatTimer = setInterval(async () => {
      try {
        const jar = this.apiClient.getJar();
        const csrfToken = (await getCsrfToken(jar)) ?? "";
        const cookieHeader = await buildCookieHeader(jar);

        await axios.post(
          HEARTBEAT_URL,
          {
            action: "sendHeartbeat",
            isFirstHeartbeat: isFirst,
            isLastHeartbeat: false,
            realtimeSessionId: connectionId,
            mpName: "voyager-web",
            mpVersion: this.mpVersion,
            clientId: "voyager-web",
            actorUrn: this.senderProfileUrn,
            contextUrns: [this.senderProfileUrn],
          },
          {
            headers: {
              "csrf-token": csrfToken,
              cookie: cookieHeader,
              "content-type": "application/json",
            },
          }
        );
        output.debug("SSE: heartbeat sent");
        isFirst = false;
      } catch (err: unknown) {
        output.debug(`SSE: heartbeat failed: ${String(err)}`);
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
