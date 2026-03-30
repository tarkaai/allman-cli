/**
 * lilac listen — stream real-time LinkedIn events to stdout as NDJSON.
 *
 * Each event is a JSON line on stdout. All logs/debug go to stderr.
 * Reconnects automatically on disconnect.
 *
 * The AI agent consuming this stream should:
 *   - Parse each line as JSON
 *   - Handle "error" events with code "COOKIE_EXPIRED" by re-running lilac login
 *   - Check "heartbeat" events to detect stalls (if no heartbeat in >90s, restart)
 */

import { Store, resolveStorePath } from "../store/index.js";
import { buildApiClient } from "../linkedin/api/client.js";
import { loadCookieJar, serializeCookieJar } from "../linkedin/api/cookies.js";
import { SseClient, type SseEvent } from "../linkedin/realtime/sse-client.js";
import { emitEvent, info, error, debug } from "../utils/output.js";
import type { StoredMessage } from "../store/types.js";

export interface ListenOptions {
  account?: string;
  store?: string;
}

export async function listenCommand(options: ListenOptions): Promise<void> {
  const storePath = resolveStorePath(options.store);
  const store = new Store({ path: storePath });
  await store.init();

  const accountSlug = await store.accounts.getDefault(options.account);
  const accountRecord = await store.accounts.read(accountSlug);

  if (!accountRecord || accountRecord.status !== "authenticated") {
    error(
      `Account "${accountSlug}" is not authenticated. Run \`lilac login --account ${accountSlug}\``,
      1
    );
    return;
  }

  if (!accountRecord.urn) {
    error(`Account "${accountSlug}" has no profile URN. Re-run \`lilac login\`.`, 1);
    return;
  }

  const myProfileUrn = accountRecord.urn;
  const myProfileId = myProfileUrn.replace("urn:li:fsd_profile:", "");
  const accountConfig = await store.accounts.readConfig(accountSlug);
  const jar = loadCookieJar(accountRecord);

  const apiClient = buildApiClient(
    accountRecord,
    async (updatedJar) => {
      await store.accounts.update(accountSlug, {
        cookieJar: serializeCookieJar(updatedJar),
        cookiesUpdatedAt: new Date().toISOString(),
      });
    },
    accountConfig.proxy
  );
  apiClient.updateJar(jar);

  info(`Listening for messages on account "${accountSlug}"...`);
  info("Streaming NDJSON events to stdout. Ctrl+C to stop.");

  const sseClient = new SseClient(apiClient, myProfileId);

  // Handle graceful shutdown
  process.on("SIGINT", () => {
    info("Shutting down...");
    sseClient.abort();
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    sseClient.abort();
    process.exit(0);
  });

  for await (const event of sseClient.connect()) {
    await handleEvent(event, accountSlug, myProfileUrn, store);
  }
}

async function handleEvent(
  event: SseEvent,
  accountSlug: string,
  myProfileUrn: string,
  store: Store
): Promise<void> {
  const timestamp = Date.now();

  switch (event.type) {
    case "connected": {
      emitEvent({
        event: "connected",
        account: accountSlug,
        connectionId: event.connectionId,
        timestamp,
      });
      return;
    }

    case "heartbeat": {
      emitEvent({ event: "heartbeat", account: accountSlug, timestamp });
      return;
    }

    case "message.received":
    case "message.sent_echo": {
      const isFromMe =
        event.type === "message.sent_echo" ||
        (event.fromUrn !== undefined && event.fromUrn === myProfileUrn);

      // Look up conversation and contact info from local store
      const convInfo = event.conversationUrn
        ? await store.conversations.findByUrn(event.conversationUrn)
        : null;

      const fromInfo = event.fromUrn
        ? await store.contacts.findByUrn(event.fromUrn)
        : null;

      const convSlug = convInfo?.slug;
      const convRecord = convInfo?.record;

      // Build the enriched NDJSON event
      emitEvent({
        event: isFromMe ? "message.sent" : "message.received",
        account: accountSlug,
        timestamp: event.timestamp ?? timestamp,
        conversation: convRecord
          ? {
              urn: convRecord.urn,
              slug: convSlug,
              title: convRecord.title,
              isGroup: convRecord.isGroup,
            }
          : {
              urn: event.conversationUrn,
              slug: null,
              title: null,
              isGroup: false,
            },
        from: fromInfo
          ? {
              urn: fromInfo.record.urn,
              slug: fromInfo.slug,
              name: fromInfo.record.name,
              headline: fromInfo.record.headline,
            }
          : {
              urn: event.fromUrn,
              slug: null,
              name: isFromMe ? accountSlug : null,
              headline: null,
            },
        message: {
          urn: event.messageUrn,
          body: event.body,
          isFromMe,
        },
      });

      // Persist the message to the file store
      if (convSlug && event.messageUrn) {
        const storedMsg: StoredMessage = {
          urn: event.messageUrn,
          timestamp: event.timestamp ?? timestamp,
          fromUrn: event.fromUrn ?? "",
          fromName: fromInfo?.record.name ?? (isFromMe ? accountSlug : ""),
          fromSlug: fromInfo?.slug ?? (isFromMe ? accountSlug : "unknown"),
          isFromMe,
          body: event.body ?? "",
          reactions: [],
          attachments: [],
          originToken: event.originToken ?? null,
        };
        await store.conversations.appendMessages(convSlug, [storedMsg]).catch((err: unknown) => {
          debug(`Failed to persist message: ${String(err)}`);
        });
      }
      return;
    }

    case "typing": {
      const convInfo = event.conversationUrn
        ? await store.conversations.findByUrn(event.conversationUrn)
        : null;
      const fromInfo = event.fromUrn
        ? await store.contacts.findByUrn(event.fromUrn)
        : null;

      emitEvent({
        event: "typing",
        account: accountSlug,
        timestamp,
        conversation: { urn: event.conversationUrn, slug: convInfo?.slug ?? null },
        from: { urn: event.fromUrn, name: fromInfo?.record.name ?? null },
      });
      return;
    }

    case "read_receipt": {
      emitEvent({
        event: "read_receipt",
        account: accountSlug,
        timestamp: event.timestamp ?? timestamp,
        conversation: { urn: event.conversationUrn },
      });
      return;
    }

    case "reaction": {
      emitEvent({
        event: "reaction",
        account: accountSlug,
        timestamp,
        messageUrn: event.messageUrn,
        reactions: event.reactions,
      });
      return;
    }

    case "raw": {
      debug(`Unhandled SSE event: ${JSON.stringify(event.raw)}`);
      return;
    }
  }
}
