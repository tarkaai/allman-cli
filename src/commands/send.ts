/**
 * allman send — send a message to a LinkedIn contact, an existing thread, or
 * a new group of people.
 *
 * One target → the 1:1 thread with that person (created if needed) or, for a
 * bare `2-…` convId / thread URN, that exact thread (1:1 or group).
 * Several targets (comma-separated and/or repeated `--to`) → a **new group
 * thread** with all of them, created by the same `createMessage` call the web
 * client makes: every recipient in `hostRecipientUrns`, no `conversationUrn`.
 *
 * `--audio <file>` (voice note) / `--file <file>` (attachment) ride on either
 * path: the file is read and validated here, before dispatch and before any
 * network call; the upload happens right before the `createMessage`, and the
 * sent bytes are cached under `{conv}/media/` once the thread and message ids
 * are known.
 */

import { copyFile, mkdir, readFile, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { type LinkedInApiClient, LinkedInError } from "../linkedin/api/client.js";
import {
  type ConversationData,
  type ConversationParticipantData,
  findConversationByRecipient,
  findConversationsByRecipients,
} from "../linkedin/api/endpoints/conversations.js";
import { extensionFor } from "../linkedin/api/endpoints/media.js";
import {
  buildAudioRenderContent,
  buildFileRenderContent,
  buildUploadMetadataPayload,
  type MediaUploadKind,
  mimeTypeFor,
  requestUploadSlot,
  uploadBytes,
} from "../linkedin/api/endpoints/media-upload.js";
import {
  fetchMessages,
  type ReplyTarget,
  sendFirstMessage,
  sendMessage,
} from "../linkedin/api/endpoints/messages.js";
import { getProfileSlugById, getProfileUrnBySlug } from "../linkedin/api/endpoints/profiles.js";
import { loadSession } from "../linkedin/api/session.js";
import { buildConversationRecord, profileIdFromUrn } from "../store/conversation-record.js";
import type { ConversationStore } from "../store/index.js";
import { resolveStorePath, Store } from "../store/index.js";
import type { ConversationRecord, MessageAttachment, StoredMessage } from "../store/types.js";
import * as output from "../utils/output.js";
import { slugFromUrl } from "../utils/slug.js";
import { extractBareConvId, isUrn, profileUrnId } from "../utils/urn.js";

export interface SendOptions {
  account?: string;
  store?: string;
  json?: boolean;
  /** URN of a message in this thread to quote as the one being replied to. */
  replyTo?: string;
  /**
   * Resolve the target and print what would be sent (including the upload
   * plan for an attachment), without any LinkedIn write.
   */
  dryRun?: boolean;
  /**
   * Additional recipients (repeatable `--to`). Together with a comma-separated
   * `<to>` these make the send create a group thread.
   */
  to?: string[];
  /** Path to an audio file sent as a voice note. Needs `durationMs`. */
  audio?: string;
  /** Path to any file sent as an attachment. */
  file?: string;
  /**
   * Length of the voice note in milliseconds — shown on the bubble and sent in
   * the render unit. Required with `audio`; a positive integer (the CLI passes
   * the raw string). Containers are not parsed.
   */
  durationMs?: number | string;
}

type Session = Awaited<ReturnType<typeof loadSession>>;

/** Largest attachment `send` will read and upload. */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/** An attachment read from disk and validated, ready to upload. */
export interface PreparedAttachment {
  kind: MediaUploadKind;
  /** Path as given — the source of the cached copy. */
  path: string;
  name: string;
  mimeType: string;
  bytes: Buffer;
  /** Voice note length; null for a file. */
  durationMs: number | null;
  /** Extension (no dot) for the cached copy — from the name, else the mime type. */
  ext: string;
}

/**
 * Read and validate `--audio` / `--file` before anything else happens: at most
 * one of them, a regular file at most `MAX_ATTACHMENT_BYTES`, an audio mime
 * type for `--audio`, and a positive-integer `--duration-ms` for a voice note.
 * Returns null when no attachment was asked for.
 */
export async function prepareAttachment(
  options: Pick<SendOptions, "audio" | "file" | "durationMs">
): Promise<PreparedAttachment | null | { error: string }> {
  if (options.audio && options.file) {
    return { error: "Pass either --audio or --file, not both." };
  }
  const path = options.audio ?? options.file;
  if (!path) return null;
  const kind: MediaUploadKind = options.audio ? "audio" : "file";

  let size: number;
  try {
    const st = await stat(path);
    if (!st.isFile()) return { error: `Can't read ${path}: not a regular file` };
    size = st.size;
  } catch (err) {
    return { error: `Can't read ${path}: ${(err as Error).message}` };
  }
  if (size === 0) return { error: `Can't send ${path}: the file is empty` };
  if (size > MAX_ATTACHMENT_BYTES) {
    return {
      error: `Can't send ${path}: ${formatBytes(size)} is over the ${formatBytes(MAX_ATTACHMENT_BYTES)} attachment limit`,
    };
  }

  const name = basename(path);
  const mimeType = mimeTypeFor(name);
  if (kind === "audio" && !mimeType.startsWith("audio/")) {
    return {
      error: `--audio expects an audio file (m4a, aac, mp3, wav, ogg, caf); got ${name}`,
    };
  }

  let durationMs: number | null = null;
  if (kind === "audio") {
    const raw = options.durationMs;
    const n = typeof raw === "number" ? raw : raw === undefined ? Number.NaN : Number(raw.trim());
    if (raw === undefined || raw === "" || !Number.isInteger(n) || n <= 0) {
      return {
        error:
          "--audio needs --duration-ms <n>: the voice note length in milliseconds (a positive integer). " +
          "The container is not parsed, so pass what your recorder reported.",
      };
    }
    durationMs = n;
  }

  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (err) {
    return { error: `Can't read ${path}: ${(err as Error).message}` };
  }
  if (bytes.length > MAX_ATTACHMENT_BYTES) {
    return {
      error: `Can't send ${path}: ${formatBytes(bytes.length)} is over the ${formatBytes(MAX_ATTACHMENT_BYTES)} attachment limit`,
    };
  }

  const fromName = extname(name).replace(/^\./, "").toLowerCase();
  const ext = fromName || extensionFor(mimeType, null, null) || "bin";
  return { kind, path, name, mimeType, bytes, durationMs, ext };
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

/** The render unit that references the uploaded asset. */
function renderUnitFor(att: PreparedAttachment, assetUrn: string): unknown {
  return att.kind === "audio"
    ? buildAudioRenderContent(assetUrn, att.durationMs ?? 0)
    : buildFileRenderContent(assetUrn, att.bytes.length, att.mimeType, att.name);
}

/** What the dry-run preview shows for an attachment: the two upload steps and the unit. */
export function attachmentPlan(att: PreparedAttachment): {
  attachment: {
    kind: MediaUploadKind;
    name: string;
    mimeType: string;
    bytes: number;
    durationMs: number | null;
  };
  upload: {
    step1: { POST: string; body: ReturnType<typeof buildUploadMetadataPayload> };
    step2: { PUT: string; contentType: string; bytes: number };
    renderUnit: unknown;
  };
} {
  return {
    attachment: {
      kind: att.kind,
      name: att.name,
      mimeType: att.mimeType,
      bytes: att.bytes.length,
      durationMs: att.durationMs,
    },
    upload: {
      step1: {
        POST: "voyagerVideoDashMediaUploadMetadata?action=upload",
        body: buildUploadMetadataPayload(att.kind, att.bytes.length, att.name),
      },
      step2: {
        PUT: "<singleUploadUrl from step 1>",
        contentType: att.mimeType,
        bytes: att.bytes.length,
      },
      renderUnit: renderUnitFor(att, "<assetUrn from step 1>"),
    },
  };
}

function describeAttachment(att: PreparedAttachment): string {
  const extra = att.durationMs !== null ? `, ${(att.durationMs / 1000).toFixed(1)}s` : "";
  return `${att.kind === "audio" ? "voice note" : "file"} ${att.name} (${att.mimeType}, ${formatBytes(att.bytes.length)}${extra})`;
}

/**
 * Upload the attachment (metadata request, then the PUT) and return the render
 * units to send with the message. On failure the error is printed and the
 * process exits — nothing has been sent at that point.
 */
async function uploadAttachment(
  apiClient: LinkedInApiClient,
  att: PreparedAttachment | null
): Promise<unknown[]> {
  if (!att) return [];
  try {
    output.info(`Uploading ${att.name} (${formatBytes(att.bytes.length)})…`);
    const slot = await requestUploadSlot(apiClient, att.kind, att.bytes.length, att.name);
    await uploadBytes(apiClient, slot, att.bytes, att.mimeType);
    return [renderUnitFor(att, slot.assetUrn)];
  } catch (err: unknown) {
    const msg = err instanceof LinkedInError ? err.message : String((err as Error).message ?? err);
    output.error(
      `Attachment upload failed: ${msg}\n  (The upload flow is modelled on the web client and may need adjusting — see --dry-run.)`,
      1
    );
    return [];
  }
}

/** The attachment as it is stored on the sent message. */
function storedAttachmentFor(att: PreparedAttachment): MessageAttachment {
  return att.kind === "audio"
    ? {
        type: "voice",
        name: att.name,
        mimeType: att.mimeType,
        size: att.bytes.length,
        durationMs: att.durationMs ?? undefined,
      }
    : { type: "file", name: att.name, mimeType: att.mimeType, size: att.bytes.length };
}

/**
 * Keep the sent bytes beside the thread as `media/<messageId>-<index>.<ext>`,
 * the name `allman media` writes for downloads, so front-ends render our own
 * upload from disk. Only when both the bare conv id and the message id are
 * known — never `media/-0.m4a`, never under the account dir itself.
 */
export async function cacheSentAttachment(
  storePath: string,
  profileId: string,
  convId: string | null | undefined,
  messageUrn: string | null | undefined,
  att: PreparedAttachment,
  index: number
): Promise<string | null> {
  const bareConv = (convId ?? "").trim();
  const messageId = bareMessageId(messageUrn ?? "").trim();
  if (!bareConv || !messageId || bareConv.includes("/") || messageId.includes("/")) return null;
  const mediaDir = join(storePath, profileId, bareConv, "media");
  const dest = join(mediaDir, `${messageId}-${index}.${att.ext}`);
  try {
    await mkdir(mediaDir, { recursive: true });
    await copyFile(att.path, dest);
    return dest;
  } catch {
    // Non-fatal: the message went out; `allman media` can fetch it later.
    return null;
  }
}

/**
 * Split `<to>` into individual targets on commas, except commas inside
 * parentheses — composite URNs like `urn:li:msg_conversation:(me,2-…)` carry
 * one and must stay whole. Blank entries are dropped.
 */
export function splitTargets(input: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of input) {
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

export async function sendCommand(
  target: string,
  text: string,
  options: SendOptions
): Promise<void> {
  const storePath = resolveStorePath(options.store);
  const store = new Store({ path: storePath });
  await store.init();

  let session: Session;
  try {
    session = await loadSession(store, options.account);
  } catch (err) {
    output.error(String((err as Error).message), 1);
    return;
  }

  const targets = [...splitTargets(target), ...(options.to ?? []).flatMap(splitTargets)];
  if (targets.length === 0) {
    output.error("No recipient given. Pass a slug, URL, URN or conversation id.", 1);
    return;
  }

  // Read + validate the attachment before any dispatch or network call.
  const prepared = await prepareAttachment(options);
  if (prepared && "error" in prepared) {
    output.error(prepared.error, 1);
    return;
  }
  const attachment = prepared;
  if (!text && !attachment) {
    output.error("Nothing to send: give message text, --audio <file> or --file <file>.", 1);
    return;
  }

  if (targets.length > 1) {
    await sendToGroup(targets, text, options, store, session, attachment);
    return;
  }
  await sendToOne(targets[0] as string, text, options, store, session, attachment);
}

// ---------------------------------------------------------------------------
// Single target: 1:1 thread (new or existing) or an existing thread by id
// ---------------------------------------------------------------------------

async function sendToOne(
  target: string,
  text: string,
  options: SendOptions,
  store: Store,
  session: Session,
  attachment: PreparedAttachment | null = null
): Promise<void> {
  const { apiClient, profileId, myProfileUrn, accountRecord } = session;
  const conversations = store.forAccount(profileId);
  const storePath = store.path;

  const resolved = await resolveTarget(target, myProfileUrn, apiClient, conversations);

  if (resolved.error) {
    output.error(resolved.error, 1);
    return;
  }

  const {
    bareConvId,
    contactProfileUrn,
    contactSlug,
    contactFirstName,
    contactLastName,
    isNewConversation,
  } = resolved;

  if (options.dryRun) {
    const convRecord = bareConvId ? await conversations.read(bareConvId) : null;
    const preview = {
      dryRun: true,
      convId: bareConvId ?? null,
      conversationUrn: convRecord?.backendUrn ?? convRecord?.convUrn ?? null,
      name: convRecord?.name ?? null,
      isGroup: convRecord?.isGroup === true,
      participants: convRecord?.participants?.map((p) => p.name) ?? null,
      contactProfileUrn: contactProfileUrn ?? null,
      contactSlug: contactSlug ?? null,
      isNewConversation: isNewConversation === true,
      replyTo: options.replyTo ?? null,
      text,
      ...(attachment ? attachmentPlan(attachment) : { attachment: null, upload: null }),
    };
    if (options.json) {
      output.printData(preview);
    } else {
      const to = convRecord
        ? `${convRecord.name}${convRecord.isGroup ? " (group)" : ""} [${bareConvId}]`
        : `new conversation with ${contactSlug ?? contactProfileUrn ?? target}`;
      output.info(`[dry-run] Would send to ${to}:`);
      if (text) process.stderr.write(`  ${text}\n`);
      if (attachment) printAttachmentPlan(attachment);
    }
    return;
  }

  // Pre-send sync — abort if new inbound messages arrived since last sync
  if (bareConvId && !isNewConversation) {
    const newInbounds = await preSendSync(apiClient, conversations, bareConvId, myProfileUrn);
    if (newInbounds.length > 0) {
      output.warn(`${newInbounds.length} new message(s) received before send — aborting.`);
      output.warn("Read them before deciding whether to send:\n");
      for (const m of newInbounds) {
        const time = new Date(m.timestamp).toLocaleTimeString();
        process.stderr.write(`  [${time}] ${m.fromName || m.fromUrn}: ${m.body}\n`);
      }
      process.stderr.write("\nRe-run the send command when you're ready.\n");
      process.exit(1);
    }
  }

  // Resolve the quoted message for --reply-to from the local store.
  let replyTarget: ReplyTarget | undefined;
  let replyFromName: string | null = null;
  if (options.replyTo) {
    if (!bareConvId || isNewConversation) {
      output.error(
        "--reply-to needs an existing conversation with that message synced locally.",
        1
      );
      return;
    }
    const wanted = bareMessageId(options.replyTo);
    const recent = await conversations.readMessages(bareConvId, { limit: 500 });
    const original = recent.find((m) => bareMessageId(m.urn) === wanted);
    if (!original) {
      output.error(
        `Message "${options.replyTo}" not found in this conversation. Run \`allman sync\` first.`,
        1
      );
      return;
    }
    replyTarget = {
      messageUrn: original.urn,
      senderUrn: original.fromUrn,
      sentAt: original.timestamp,
      text: original.body,
    };
    replyFromName = original.fromName || null;
  }

  // Send (rate limiting enforced by the API client)
  let result: {
    messageUrn: string;
    conversationUrn: string;
    backendConversationUrn: string;
    deliveredAt: number;
  };

  // Upload the attachment first; the render unit rides on createMessage.
  const renderUnits = await uploadAttachment(apiClient, attachment);

  try {
    if (isNewConversation && contactProfileUrn) {
      output.info("Starting new conversation...");
      result = await sendFirstMessage(
        apiClient,
        contactProfileUrn,
        myProfileUrn,
        text,
        renderUnits
      );
    } else if (bareConvId) {
      const convRecord = await conversations.read(bareConvId);
      const convUrn = convRecord?.backendUrn ?? convRecord?.convUrn ?? bareConvId;
      result = await sendMessage(apiClient, convUrn, myProfileUrn, text, replyTarget, renderUnits);
    } else {
      output.error("Could not determine conversation to send to.", 1);
      return;
    }
  } catch (err: unknown) {
    if (err instanceof LinkedInError) {
      output.error(err.message, 1);
    } else {
      output.error(`Send failed: ${String(err)}`, 1);
    }
    return;
  }

  // Store the sent message
  const targetBareId =
    bareConvId ?? extractBareConvId(result.backendConversationUrn || result.conversationUrn);
  const storedMsg: StoredMessage = {
    urn: result.messageUrn,
    timestamp: result.deliveredAt,
    fromUrn: myProfileUrn,
    fromName: accountRecord.name ?? "",
    isFromMe: true,
    body: text,
    reactions: [],
    attachments: [
      ...(replyTarget
        ? [
            {
              type: "replied" as const,
              originalText: replyTarget.text,
              authorName: replyFromName ?? undefined,
            },
          ]
        : []),
      ...(attachment ? [storedAttachmentFor(attachment)] : []),
    ],
    originToken: null,
  };

  if (attachment) {
    await cacheSentAttachment(
      storePath,
      profileId,
      targetBareId,
      result.messageUrn,
      attachment,
      storedMsg.attachments.length - 1
    );
  }

  if (await conversations.exists(targetBareId)) {
    await conversations.appendMessages(targetBareId, [storedMsg]);
    // Update lastActivityAt, newestMessageAt, and backfill slug if missing
    const existing = await conversations.read(targetBareId);
    if (existing) {
      await conversations.upsert(targetBareId, {
        ...existing,
        slug: contactSlug && !existing.slug ? contactSlug : existing.slug,
        lastActivityAt: new Date(result.deliveredAt).toISOString(),
        lastReadAt: new Date(result.deliveredAt).toISOString(),
        syncState: {
          ...existing.syncState,
          newestMessageAt: Math.max(existing.syncState?.newestMessageAt ?? 0, result.deliveredAt),
        },
      });
    }
  } else if (result.backendConversationUrn) {
    const contactPid = contactProfileUrn
      ? contactProfileUrn.replace("urn:li:fsd_profile:", "")
      : "";
    const newRecord: ConversationRecord = {
      convId: targetBareId,
      profileId: contactPid,
      slug: contactSlug ?? null,
      convUrn: result.conversationUrn,
      backendUrn: result.backendConversationUrn,
      profileUrn: contactProfileUrn ?? "",
      memberUrn: null,
      firstName: contactFirstName ?? "",
      lastName: contactLastName ?? "",
      name: [contactFirstName, contactLastName].filter(Boolean).join(" ") || "New conversation",
      headline: null,
      profileUrl: null,
      profilePictures: null,
      distance: null,
      pronoun: null,
      memberBadgeType: null,
      isPremium: false,
      isVerified: false,
      unreadCount: 0,
      lastActivityAt: new Date(result.deliveredAt).toISOString(),
      lastReadAt: new Date(result.deliveredAt).toISOString(),
      createdAt: new Date(result.deliveredAt).toISOString(),
      read: true,
      notificationStatus: null,
      categories: [],
      conversationUrl: null,
      disabledFeatures: [],
      syncState: {
        oldestMessageAt: result.deliveredAt,
        newestMessageAt: result.deliveredAt,
        lastSyncAt: new Date().toISOString(),
        totalSynced: 1,
        fullyBackfilled: false,
      },
      fetchedAt: new Date().toISOString(),
    };
    await conversations.upsert(targetBareId, newRecord);
    await conversations.appendMessages(targetBareId, [storedMsg]);
  }

  await store.git.flush();

  if (options.json) {
    output.printData({
      messageUrn: result.messageUrn,
      conversationUrn: result.backendConversationUrn || result.conversationUrn,
      deliveredAt: result.deliveredAt,
      isNewConversation,
    });
  } else {
    output.success(`Message sent (${new Date(result.deliveredAt).toLocaleTimeString()})`);
    if (isNewConversation) output.info("  New conversation created.");
  }
}

function printAttachmentPlan(att: PreparedAttachment): void {
  const plan = attachmentPlan(att);
  output.info(`  Attachment: ${describeAttachment(att)}`);
  output.info(
    `  Upload: POST ${plan.upload.step1.POST} ${JSON.stringify(plan.upload.step1.body)}; then PUT ${plan.upload.step2.bytes} bytes (${plan.upload.step2.contentType})`
  );
  output.info(`  Render unit: ${JSON.stringify(plan.upload.renderUnit)}`);
}

/** Bare message id from any URN form: composite `(…,2-id)`, backend `…:2-id`, or bare. */
function bareMessageId(urn: string): string {
  const comma = urn.lastIndexOf(",");
  if (comma !== -1) return urn.slice(comma + 1).replace(/\)$/, "");
  const colon = urn.lastIndexOf(":");
  return colon !== -1 ? urn.slice(colon + 1) : urn;
}

// ---------------------------------------------------------------------------
// Several targets: create a group thread
// ---------------------------------------------------------------------------

/** One resolved group recipient — a person, never a thread. */
export interface GroupRecipient {
  /** What the user typed. */
  target: string;
  profileUrn: string;
  profileId: string;
  /** Known from the target or a local 1:1 record; null when only a URN was given. */
  slug: string | null;
  /** From the local 1:1 record with this person, when there is one. */
  name: string | null;
}

async function sendToGroup(
  targets: string[],
  text: string,
  options: SendOptions,
  store: Store,
  session: Session,
  attachment: PreparedAttachment | null = null
): Promise<void> {
  const { apiClient, profileId, myProfileUrn, accountRecord } = session;
  const conversations = store.forAccount(profileId);

  if (options.replyTo) {
    output.error("--reply-to cannot be combined with several recipients (a new group thread).", 1);
    return;
  }

  // Resolve every target to a person. Any failure aborts before any write.
  const recipients: GroupRecipient[] = [];
  const seen = new Set<string>();
  for (const target of targets) {
    const r = await resolveGroupRecipient(target, apiClient, conversations);
    if ("error" in r) {
      output.error(r.error, 1);
      return;
    }
    if (r.profileUrn === myProfileUrn) {
      output.warn(`Skipping "${target}" — that is the signed-in account.`);
      continue;
    }
    if (seen.has(r.profileUrn)) continue;
    seen.add(r.profileUrn);
    recipients.push(r);
  }

  if (recipients.length === 0) {
    output.error("No recipients left after removing yourself and duplicates.", 1);
    return;
  }
  if (recipients.length === 1) {
    const only = recipients[0] as GroupRecipient;
    output.info(`Only one distinct recipient (${only.slug ?? only.profileUrn}) — sending 1:1.`);
    await sendToOne(
      only.slug ?? only.profileUrn,
      text,
      { ...options, to: [] },
      store,
      session,
      attachment
    );
    return;
  }

  const hostRecipientUrns = recipients.map((r) => r.profileUrn);

  if (options.dryRun) {
    const preview = {
      dryRun: true,
      convId: null,
      conversationUrn: null,
      name: null,
      isGroup: true,
      participants: recipients.map((r) => r.name ?? r.slug ?? r.profileId),
      recipients: recipients.map((r) => ({
        target: r.target,
        profileUrn: r.profileUrn,
        slug: r.slug,
        name: r.name,
      })),
      hostRecipientUrns,
      isNewConversation: true,
      replyTo: null,
      text,
      ...(attachment ? attachmentPlan(attachment) : { attachment: null, upload: null }),
    };
    if (options.json) {
      output.printData(preview);
    } else {
      output.info(
        `[dry-run] Would create a new group conversation with ${recipients.length} recipients:`
      );
      for (const r of recipients) {
        const label = [r.slug ?? r.target, r.name ? `(${r.name})` : null].filter(Boolean).join(" ");
        process.stderr.write(`  - ${label}  ${r.profileUrn}\n`);
      }
      output.info(
        "  Plan: POST createMessage with hostRecipientUrns=[all of the above] and no conversationUrn"
      );
      if (text) process.stderr.write(`  ${text}\n`);
      if (attachment) printAttachmentPlan(attachment);
    }
    return;
  }

  // Send (rate limiting enforced by the API client). No pre-send sync: there
  // is no thread yet to have missed anything in.
  const renderUnits = await uploadAttachment(apiClient, attachment);

  let result: Awaited<ReturnType<typeof sendFirstMessage>>;
  try {
    output.info(`Starting new group conversation with ${recipients.length} people...`);
    result = await sendFirstMessage(apiClient, hostRecipientUrns, myProfileUrn, text, renderUnits);
  } catch (err: unknown) {
    if (err instanceof LinkedInError) {
      output.error(err.message, 1);
    } else {
      output.error(`Send failed: ${String(err)}`, 1);
    }
    return;
  }

  const storedMsg: StoredMessage = {
    urn: result.messageUrn,
    timestamp: result.deliveredAt,
    fromUrn: myProfileUrn,
    fromName: accountRecord.name ?? "",
    isFromMe: true,
    body: text,
    reactions: [],
    attachments: attachment ? [storedAttachmentFor(attachment)] : [],
    originToken: null,
  };

  // The created message names the new thread. Fetch the thread through the
  // by-recipients lookup so the stored record has LinkedIn's participant data;
  // if that fails, store what we know and let the next sync/listen fill it in.
  const sentConvUrn = result.backendConversationUrn || result.conversationUrn;
  const sentConvId = sentConvUrn ? extractBareConvId(sentConvUrn) : null;
  const knownSlugs = new Map(recipients.map((r) => [r.profileId, r.slug] as const));
  const resolveSlug = async (id: string): Promise<string | null> =>
    knownSlugs.get(id) ?? (await getProfileSlugById(apiClient, id).catch(() => null));

  let conv: ConversationData | null = null;
  try {
    const matches = await findConversationsByRecipients(apiClient, hostRecipientUrns, myProfileUrn);
    conv =
      (sentConvId
        ? matches.find((m) => extractBareConvId(m.backendUrn || m.urn) === sentConvId)
        : matches[0]) ?? null;
  } catch {
    conv = null;
  }
  if (!conv && sentConvId) {
    // Fill in the slugs we lack (URN-only targets) so the provisional record
    // is readable; the lookups are cached on the record for the next sync.
    for (const r of recipients) {
      if (r.slug) continue;
      r.slug = await resolveSlug(r.profileId);
      knownSlugs.set(r.profileId, r.slug);
    }
    conv = provisionalGroupConversation(sentConvId, result, myProfileUrn, recipients);
  }

  let convId: string | null = null;
  if (conv) {
    convId = extractBareConvId(conv.backendUrn || conv.urn);
    const existing = await conversations.read(convId);
    const record = await buildConversationRecord({
      conv,
      myProfileUrn,
      existing,
      conversations,
      resolveSlug,
    });
    if (record) {
      const at = new Date(result.deliveredAt).toISOString();
      await conversations.upsert(convId, {
        ...record,
        lastActivityAt: record.lastActivityAt ?? at,
        lastReadAt: at,
        createdAt: record.createdAt ?? at,
        read: true,
        syncState: {
          oldestMessageAt: Math.min(
            existing?.syncState.oldestMessageAt ?? result.deliveredAt,
            result.deliveredAt
          ),
          newestMessageAt: Math.max(existing?.syncState.newestMessageAt ?? 0, result.deliveredAt),
          lastSyncAt: new Date().toISOString(),
          totalSynced: (existing?.syncState.totalSynced ?? 0) + 1,
          fullyBackfilled: existing?.syncState.fullyBackfilled ?? true,
        },
      });
      await conversations.appendMessages(convId, [storedMsg]);
      if (attachment) {
        await cacheSentAttachment(store.path, profileId, convId, result.messageUrn, attachment, 0);
      }
    }
  } else {
    output.warn(
      "Sent, but LinkedIn did not identify the new thread — run `allman sync` to pick it up."
    );
  }

  await store.git.flush();

  if (options.json) {
    output.printData({
      messageUrn: result.messageUrn,
      conversationUrn: sentConvUrn || conv?.backendUrn || null,
      convId,
      deliveredAt: result.deliveredAt,
      isNewConversation: true,
      isGroup: true,
      recipients: hostRecipientUrns,
    });
  } else {
    output.success(`Message sent (${new Date(result.deliveredAt).toLocaleTimeString()})`);
    output.info(
      `  New group conversation created${convId ? ` [${convId}]` : ""} with ${recipients.length} people.`
    );
  }
}

/**
 * Resolve one group target to a person: `urn:li:fsd_profile:…` as-is, else a
 * slug/URL through the local 1:1 record (no network) and then the profile
 * lookup — the same lookups a single `send <slug>` uses. Thread ids and
 * thread URNs are rejected: a group is built from people.
 */
async function resolveGroupRecipient(
  target: string,
  apiClient: LinkedInApiClient,
  conversations: ConversationStore
): Promise<GroupRecipient | { error: string }> {
  if (isUrn(target)) {
    if (!target.startsWith("urn:li:fsd_profile:")) {
      return {
        error: `Group recipients must be people (slug, profile URL or urn:li:fsd_profile:…), got "${target}".`,
      };
    }
    const local = await conversations.findByProfileUrn(target);
    return {
      target,
      profileUrn: target,
      profileId: profileIdFromUrn(target),
      slug: local?.record.slug ?? null,
      name: local?.record.name ?? null,
    };
  }
  if (target.startsWith("2-")) {
    return {
      error: `Group recipients must be people, not conversation ids ("${target}"). Use \`send <convId>\` to message an existing group.`,
    };
  }

  let slug: string;
  try {
    slug = slugFromUrl(target);
  } catch {
    return {
      error: `Cannot resolve recipient: "${target}". Use a LinkedIn URL, profile slug, or urn:li:fsd_profile URN.`,
    };
  }

  const localConvId = await conversations.resolve(slug);
  const localRecord = localConvId ? await conversations.read(localConvId) : null;
  if (localRecord && !localRecord.isGroup && localRecord.profileUrn) {
    return {
      target,
      profileUrn: localRecord.profileUrn,
      profileId: localRecord.profileId || profileIdFromUrn(localRecord.profileUrn),
      slug: localRecord.slug ?? slug,
      name: localRecord.name || null,
    };
  }

  output.info(`Looking up profile "${slug}" on LinkedIn...`);
  const urn = await getProfileUrnBySlug(apiClient, slug);
  if (!urn) return { error: `Profile "${slug}" not found on LinkedIn.` };
  const local = await conversations.findByProfileUrn(urn);
  return {
    target,
    profileUrn: urn,
    profileId: profileIdFromUrn(urn),
    slug,
    name: local?.record.name ?? null,
  };
}

/**
 * The group as we know it from the send alone — used when the by-recipients
 * lookup cannot confirm the new thread. Participant names fall back to the
 * slug (or profile id) so the record is readable; the next sync replaces it
 * with LinkedIn's data.
 */
function provisionalGroupConversation(
  convId: string,
  result: { conversationUrn: string; backendConversationUrn: string; deliveredAt: number },
  myProfileUrn: string,
  recipients: GroupRecipient[]
): ConversationData {
  const participant = (urn: string, name: string | null): ConversationParticipantData => ({
    entityUrn: urn,
    name,
    profileUrl: null,
    imageUrl: null,
    headline: null,
    profilePictures: [],
    distance: null,
    pronoun: null,
    memberBadgeType: null,
    isPremium: false,
    isVerified: false,
    backendUrn: null,
  });
  return {
    urn: result.conversationUrn || `urn:li:msg_conversation:(${myProfileUrn},${convId})`,
    backendUrn: result.backendConversationUrn || `urn:li:messagingThread:${convId}`,
    title: null,
    isGroup: true,
    lastActivityAt: result.deliveredAt,
    unreadCount: 0,
    participants: [
      participant(myProfileUrn, null),
      ...recipients.map((r) => participant(r.profileUrn, r.name ?? r.slug ?? r.profileId)),
    ],
    createdAt: result.deliveredAt,
    lastReadAt: result.deliveredAt,
    read: true,
    notificationStatus: null,
    categories: [],
    conversationUrl: null,
    disabledFeatures: [],
  };
}

// ---------------------------------------------------------------------------
// Target resolution
// ---------------------------------------------------------------------------

interface ResolvedTarget {
  bareConvId?: string;
  contactProfileUrn?: string;
  contactSlug?: string;
  contactFirstName?: string | null;
  contactLastName?: string | null;
  isNewConversation?: boolean;
  error?: string;
}

async function resolveTarget(
  target: string,
  myProfileUrn: string,
  apiClient: LinkedInApiClient,
  conversations: ConversationStore
): Promise<ResolvedTarget> {
  // Case 1: Direct URN
  if (isUrn(target)) {
    const bare = extractBareConvId(target);
    if (await conversations.exists(bare)) return { bareConvId: bare, isNewConversation: false };
    const found = await conversations.findByUrn(target);
    return { bareConvId: found?.convId, isNewConversation: false };
  }

  // Case 2: Bare conversation id. Must keep its case (slug resolution
  // lowercases) and is the only address a group thread has (no slug alias).
  if (target.startsWith("2-") && (await conversations.exists(target))) {
    return { bareConvId: target, isNewConversation: false };
  }

  // Case 3: Slug or URL — try symlink first
  let contactSlug: string;
  try {
    contactSlug = slugFromUrl(target);
  } catch {
    return {
      error: `Cannot resolve target: "${target}". Use a LinkedIn URL, profile slug, or URN.`,
    };
  }

  // Try resolving as a conversation symlink directly
  const directBareId = await conversations.resolve(contactSlug);
  if (directBareId) return { bareConvId: directBareId, contactSlug, isNewConversation: false };

  // Try to find a conversation by profile URN via local store
  let contactUrn: string | null = null;

  // If not in local store, query LinkedIn API
  const contactFirstName: string | null = null;
  const contactLastName: string | null = null;
  if (!contactUrn) {
    output.info(`Looking up profile "${contactSlug}" on LinkedIn...`);
    const urn = await getProfileUrnBySlug(apiClient, contactSlug);
    if (!urn) {
      return { error: `Profile "${contactSlug}" not found on LinkedIn.` };
    }
    contactUrn = urn;
  }

  // Look for existing conversation with this contact
  const localConv = await conversations.findByProfileUrn(contactUrn);
  if (localConv)
    return {
      bareConvId: localConv.convId,
      contactProfileUrn: contactUrn,
      contactSlug,
      isNewConversation: false,
    };

  // Query LinkedIn API for existing conversation
  output.info("Checking for existing conversation on LinkedIn...");
  const liConv = await findConversationByRecipient(apiClient, contactUrn, myProfileUrn);
  if (liConv) {
    const bare = extractBareConvId(liConv.backendUrn || liConv.urn);
    return {
      bareConvId: bare,
      contactProfileUrn: contactUrn,
      contactSlug,
      isNewConversation: false,
    };
  }

  return {
    contactProfileUrn: contactUrn,
    contactSlug,
    contactFirstName,
    contactLastName,
    isNewConversation: true,
  };
}

// ---------------------------------------------------------------------------
// Pre-send sync
// ---------------------------------------------------------------------------

async function preSendSync(
  apiClient: LinkedInApiClient,
  conversations: ConversationStore,
  bareConvId: string,
  myProfileUrn: string
): Promise<StoredMessage[]> {
  const existing = await conversations.read(bareConvId);
  const knownNewestAt = existing?.syncState.newestMessageAt ?? 0;
  const convUrn = existing?.backendUrn ?? existing?.convUrn ?? bareConvId;

  try {
    const { messages } = await fetchMessages(apiClient, convUrn, myProfileUrn, Date.now(), 10);

    // Store all new messages (inbound + outbound) since last sync
    const newMessages = messages.filter((m) => m.deliveredAt > knownNewestAt);

    if (newMessages.length > 0) {
      const myId = profileUrnId(myProfileUrn);
      const stored: StoredMessage[] = newMessages.map((m) => ({
        urn: m.urn,
        timestamp: m.deliveredAt,
        fromUrn: m.fromUrn,
        fromName: m.fromName ?? "",
        isFromMe: m.fromUrn.includes(myId),
        body: m.body,
        reactions: m.reactions,
        attachments: m.attachments.map((a) => ({
          type: a.type as StoredMessage["attachments"][number]["type"],
          url: a.url,
          name: a.name,
          mimeType: a.mimeType,
          raw: a.raw,
        })),
        originToken: null,
      }));
      await conversations.appendMessages(bareConvId, stored);
      await conversations.updateSyncState(bareConvId, {
        newestMessageAt: Math.max(...newMessages.map((m) => m.deliveredAt)),
      });

      // Only flag inbound messages that are newer than the most recent outbound.
      // If the user already replied after the inbounds, they've seen the context.
      const newestOutboundAt = Math.max(
        knownNewestAt,
        ...newMessages.filter((m) => m.fromUrn.includes(myId)).map((m) => m.deliveredAt),
        0
      );
      const unseenInbounds = stored.filter((m) => !m.isFromMe && m.timestamp > newestOutboundAt);
      return unseenInbounds;
    }
    return [];
  } catch {
    return [];
  }
}
