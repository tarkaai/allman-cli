/**
 * Unified conversation store.
 *
 * Layout (inside account dir):
 *   {accountDir}/{convId}/RECORD.json         — conversation + contact data
 *   {accountDir}/{convId}/messages/YYYY-MM.jsonl
 *   {accountDir}/{profileId} -> {convId}      — symlink
 *   {accountDir}/{slug} -> {convId}           — symlink (real LinkedIn publicIdentifier)
 *
 * Every 1:1 conversation maps to exactly one contact.
 * The convId is the canonical key (directory name).
 */

import { readFile, writeFile, mkdir, readdir, appendFile } from "fs/promises";
import { createReadStream as fsCreateReadStream } from "fs";
import { createInterface } from "readline";
import { join } from "path";
import { ensureDir, ensureAlias, forceAlias, resolveAlias } from "./alias.js";
import type { StoreGit } from "./git.js";
import type { ConversationRecord, StoredMessage, SyncState } from "./types.js";

const RECORD_FILE = "RECORD.json";
// Conv IDs always start with "2-"
const CONV_ID_PATTERN = /^2-/;

/**
 * Extract the bare message ID from any LinkedIn message URN format.
 * - urn:li:fs_event:(convId,msgId) → msgId (strip trailing paren)
 * - urn:li:messagingMessage:msgId → msgId
 * The msgId is identical across both formats (e.g. "2-MTc3NDkz...").
 */
function extractMsgId(urn: string): string {
  // fs_event format: everything after the last comma, strip trailing )
  if (urn.includes("fs_event")) {
    const lastComma = urn.lastIndexOf(",");
    if (lastComma !== -1) return urn.slice(lastComma + 1).replace(/\)$/, "");
  }
  // messagingMessage format: everything after the last colon
  const lastColon = urn.lastIndexOf(":");
  return lastColon !== -1 ? urn.slice(lastColon + 1) : urn;
}

const DEFAULT_SYNC_STATE: SyncState = {
  oldestMessageAt: null,
  newestMessageAt: null,
  lastSyncAt: null,
  totalSynced: 0,
  fullyBackfilled: false,
};

export class ConversationStore {
  private writeLocks = new Map<string, Promise<void>>();

  constructor(
    private readonly accountDir: string,
    private readonly git: StoreGit
  ) {}

  private dir(convId: string): string {
    return join(this.accountDir, convId);
  }

  private messagesDir(convId: string): string {
    return join(this.dir(convId), "messages");
  }

  private messageFile(convId: string, timestampMs: number): string {
    const d = new Date(timestampMs);
    const month = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    return join(this.messagesDir(convId), `${month}.jsonl`);
  }

  /** List all convIds (real dirs with 2- prefix, not symlinks). */
  async list(): Promise<string[]> {
    try {
      const entries = await readdir(this.accountDir, { withFileTypes: true });
      return entries
        .filter((e) => e.isDirectory() && CONV_ID_PATTERN.test(e.name))
        .map((e) => e.name);
    } catch {
      return [];
    }
  }

  async exists(convId: string): Promise<boolean> {
    try {
      await readFile(join(this.dir(convId), RECORD_FILE), "utf8");
      return true;
    } catch {
      return false;
    }
  }

  async read(convId: string): Promise<ConversationRecord | null> {
    try {
      const raw = await readFile(join(this.dir(convId), RECORD_FILE), "utf8");
      return JSON.parse(raw) as ConversationRecord;
    } catch {
      return null;
    }
  }

  /**
   * Resolve any identifier (slug, profileId, or convId) to a convId.
   * Follows symlinks for slug/profileId, direct lookup for convId.
   */
  async resolve(input: string): Promise<string | null> {
    // Direct convId
    if (CONV_ID_PATTERN.test(input)) {
      if (await this.exists(input)) return input;
    }
    // Try symlink (slug or profileId)
    return resolveAlias(this.accountDir, input);
  }

  /**
   * Write or update a conversation record.
   * Also creates/validates profileId and slug symlinks.
   */
  async upsert(convId: string, record: ConversationRecord): Promise<void> {
    await ensureDir(this.accountDir, convId);

    const existing = await this.read(convId);
    // Preserve existing syncState if incoming has no tracked data
    const incomingSyncHasData =
      record.syncState.oldestMessageAt !== null ||
      record.syncState.newestMessageAt !== null ||
      record.syncState.totalSynced > 0;
    const merged: ConversationRecord = existing
      ? { ...existing, ...record, syncState: incomingSyncHasData ? record.syncState : existing.syncState }
      : record;

    await writeFile(
      join(this.dir(convId), RECORD_FILE),
      JSON.stringify(merged, null, 2) + "\n",
      "utf8"
    );

    // Create profileId symlink → convId
    if (merged.profileId) {
      await ensureAlias(this.accountDir, merged.profileId, convId).catch(() => {});
    }

    // Create slug symlink → convId (only if slug is resolved)
    if (merged.slug) {
      // Use forceAlias for slug since it may be newly resolved
      await forceAlias(this.accountDir, merged.slug, convId).catch(() => {});
    }

    this.git.scheduleCommit(`conversation: update ${convId.slice(0, 20)}`);
  }

  /** Find a conversation by its frontend or backend URN. Scans all records. */
  async findByUrn(urn: string): Promise<{ convId: string; record: ConversationRecord } | null> {
    const ids = await this.list();
    for (const convId of ids) {
      const record = await this.read(convId);
      if (record && (record.convUrn === urn || record.backendUrn === urn)) {
        return { convId, record };
      }
    }
    return null;
  }

  /** Find a 1:1 conversation by the contact's profile URN. Scans all records. */
  async findByProfileUrn(profileUrn: string): Promise<{ convId: string; record: ConversationRecord } | null> {
    const ids = await this.list();
    for (const convId of ids) {
      const record = await this.read(convId);
      if (record && record.profileUrn === profileUrn) {
        return { convId, record };
      }
    }
    return null;
  }

  /**
   * Append messages to the JSONL store. Deduplicates by URN within each month file.
   * Returns the number of new messages actually written.
   */
  async appendMessages(convId: string, messages: StoredMessage[]): Promise<number> {
    if (messages.length === 0) return 0;


    const byFile = new Map<string, StoredMessage[]>();
    for (const msg of messages) {
      const file = this.messageFile(convId, msg.timestamp);
      if (!byFile.has(file)) byFile.set(file, []);
      byFile.get(file)!.push(msg);
    }

    let totalAdded = 0;
    for (const [file, msgs] of byFile) {
      // Serialize writes to the same file to prevent race conditions
      const prev = this.writeLocks.get(file) ?? Promise.resolve();
      const work = prev.then(async () => {
        await mkdir(join(file, ".."), { recursive: true });

        const existingMsgIds = new Set<string>();
        try {
          const content = await readFile(file, "utf8");
          for (const line of content.split("\n")) {
            if (!line.trim()) continue;
            try {
              const m = JSON.parse(line) as StoredMessage;
              if (m.urn) existingMsgIds.add(extractMsgId(m.urn));
            } catch { /* skip malformed */ }
          }
        } catch { /* file doesn't exist yet */ }

        const newMsgs = msgs.filter((m) => !existingMsgIds.has(extractMsgId(m.urn)));
        if (newMsgs.length > 0) {
          const lines = newMsgs.map((m) => JSON.stringify(m)).join("\n") + "\n";
          await appendFile(file, lines, "utf8");
          totalAdded += newMsgs.length;
        }
      });
      this.writeLocks.set(file, work);
      await work;
    }
    return totalAdded;
  }

  async readMessages(
    convId: string,
    opts: { since?: number; limit?: number } = {}
  ): Promise<StoredMessage[]> {
    const dir = this.messagesDir(convId);
    let files: string[];
    try {
      files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl")).sort();
    } catch {
      return [];
    }

    const messages: StoredMessage[] = [];
    for (const file of files) {
      const rl = createInterface({
        input: fsCreateReadStream(join(dir, file)),
        crlfDelay: Infinity,
      });
      for await (const line of rl) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line) as StoredMessage;
          if (opts.since && msg.timestamp < opts.since) continue;
          messages.push(msg);
        } catch { /* skip malformed lines */ }
      }
    }

    messages.sort((a, b) => a.timestamp - b.timestamp);
    if (opts.limit && messages.length > opts.limit) {
      return messages.slice(messages.length - opts.limit);
    }
    return messages;
  }

  async updateSyncState(convId: string, updates: Partial<SyncState>): Promise<void> {
    const record = await this.read(convId);
    if (!record) return;
    const syncState: SyncState = { ...DEFAULT_SYNC_STATE, ...record.syncState, ...updates };
    await this.upsert(convId, { ...record, syncState });
  }
}
