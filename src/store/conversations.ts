/**
 * Conversation store operations.
 *
 * Layout:
 *   {accountDir}/{bareConvId}/RECORD.json
 *   {accountDir}/{bareConvId}/messages/YYYY-MM.jsonl
 *   {accountDir}/{slug} -> {bareConvId}   (symlink, e.g. "example-user-1" -> "2-OTg0N2Nk...")
 *
 * Bare conv ID = the ID portion of urn:li:messagingThread:{bareId}
 * e.g. "2-OTg0N2NkZmMtNTViZC00N2I4LWI3YTYtODdhYmU0YzAzNzhjXzEwMA=="
 */

import { readFile, writeFile, mkdir, readdir, access, appendFile, symlink, readlink, unlink, createReadStream } from "fs/promises";
import { createReadStream as fsCreateReadStream } from "fs";
import { createInterface } from "readline";
import { join } from "path";
import type { StoreGit } from "./git.js";
import type { ConversationRecord, StoredMessage, SyncState } from "./types.js";

const RECORD_FILE = "RECORD.json";
// Bare conv IDs always start with "2-"
const CONV_ID_PATTERN = /^2-/;

const DEFAULT_SYNC_STATE: SyncState = {
  oldestMessageAt: null,
  newestMessageAt: null,
  lastSyncAt: null,
  totalSynced: 0,
  fullyBackfilled: false,
};

export class ConversationStore {
  constructor(
    private readonly accountDir: string,
    private readonly git: StoreGit
  ) {}

  private dir(bareConvId: string): string {
    return join(this.accountDir, bareConvId);
  }

  private messagesDir(bareConvId: string): string {
    return join(this.dir(bareConvId), "messages");
  }

  private messageFile(bareConvId: string, timestampMs: number): string {
    const d = new Date(timestampMs);
    const month = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    return join(this.messagesDir(bareConvId), `${month}.jsonl`);
  }

  /** List all bare conversation IDs (real dirs only, not symlinks). */
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

  async exists(bareConvId: string): Promise<boolean> {
    try {
      await access(join(this.dir(bareConvId), RECORD_FILE));
      return true;
    } catch {
      return false;
    }
  }

  async read(bareConvId: string): Promise<ConversationRecord | null> {
    try {
      const raw = await readFile(join(this.dir(bareConvId), RECORD_FILE), "utf8");
      return JSON.parse(raw) as ConversationRecord;
    } catch {
      return null;
    }
  }

  async upsert(bareConvId: string, record: ConversationRecord): Promise<void> {
    const dir = this.dir(bareConvId);
    await mkdir(dir, { recursive: true });
    const existing = await this.read(bareConvId);
    // Preserve existing syncState when incoming record has no tracked data (e.g. fresh API fetch).
    // If the incoming syncState has actual data, it wins (e.g. updateSyncState calls).
    const incomingSyncHasData =
      record.syncState.oldestMessageAt !== null ||
      record.syncState.newestMessageAt !== null ||
      record.syncState.totalSynced > 0;
    const merged: ConversationRecord = existing
      ? { ...existing, ...record, syncState: incomingSyncHasData ? record.syncState : existing.syncState }
      : record;
    await writeFile(join(dir, RECORD_FILE), JSON.stringify(merged, null, 2) + "\n", "utf8");
    this.git.scheduleCommit(`conversation: update ${bareConvId.slice(0, 20)}`);
  }

  /** Create a symlink: {accountDir}/{slug} → {bareConvId} */
  async createAlias(slug: string, bareConvId: string): Promise<void> {
    const linkPath = join(this.accountDir, slug);
    try { await unlink(linkPath); } catch { /* ok */ }
    await symlink(bareConvId, linkPath);
  }

  /**
   * Resolve a slug/alias to a bare conversation ID.
   * Follows symlink if present, otherwise returns input if it's an existing dir.
   */
  async resolveId(slugOrId: string): Promise<string | null> {
    const path = join(this.accountDir, slugOrId);
    try {
      return await readlink(path);
    } catch {
      if (CONV_ID_PATTERN.test(slugOrId)) {
        try {
          await access(join(this.accountDir, slugOrId, RECORD_FILE));
          return slugOrId;
        } catch {
          return null;
        }
      }
      return null;
    }
  }

  /** Find a conversation by its frontend or backend URN. */
  async findByUrn(urn: string): Promise<{ bareId: string; record: ConversationRecord } | null> {
    const ids = await this.list();
    for (const bareId of ids) {
      const record = await this.read(bareId);
      if (record && (record.urn === urn || record.backendUrn === urn || record.bareId === bareId)) {
        return { bareId, record };
      }
    }
    return null;
  }

  /** Find a 1:1 conversation with a specific contact by their profile URN. */
  async findByParticipantUrn(
    contactUrn: string
  ): Promise<{ bareId: string; record: ConversationRecord } | null> {
    const ids = await this.list();
    for (const bareId of ids) {
      const record = await this.read(bareId);
      if (!record || record.isGroup) continue;
      if (record.participants.some((p) => p.urn === contactUrn)) {
        return { bareId, record };
      }
    }
    return null;
  }

  async appendMessages(bareConvId: string, messages: StoredMessage[]): Promise<number> {
    if (messages.length === 0) return 0;

    // Group by month file
    const byFile = new Map<string, StoredMessage[]>();
    for (const msg of messages) {
      const file = this.messageFile(bareConvId, msg.timestamp);
      if (!byFile.has(file)) byFile.set(file, []);
      byFile.get(file)!.push(msg);
    }

    let totalAdded = 0;
    for (const [file, msgs] of byFile) {
      await mkdir(join(file, ".."), { recursive: true });

      // Deduplicate: skip messages whose URN already exists in this file
      const existingUrns = new Set<string>();
      try {
        const content = await readFile(file, "utf8");
        for (const line of content.split("\n")) {
          if (!line.trim()) continue;
          try {
            const m = JSON.parse(line) as StoredMessage;
            if (m.urn) existingUrns.add(m.urn);
          } catch { /* skip malformed */ }
        }
      } catch { /* file doesn't exist yet */ }

      const newMsgs = msgs.filter((m) => !existingUrns.has(m.urn));
      if (newMsgs.length > 0) {
        const lines = newMsgs.map((m) => JSON.stringify(m)).join("\n") + "\n";
        await appendFile(file, lines, "utf8");
        totalAdded += newMsgs.length;
      }
    }
    return totalAdded;
  }

  async readMessages(
    bareConvId: string,
    opts: { since?: number; limit?: number } = {}
  ): Promise<StoredMessage[]> {
    const dir = this.messagesDir(bareConvId);
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

    // Sort ascending, return last N
    messages.sort((a, b) => a.timestamp - b.timestamp);
    if (opts.limit && messages.length > opts.limit) {
      return messages.slice(messages.length - opts.limit);
    }
    return messages;
  }

  async updateSyncState(bareConvId: string, updates: Partial<SyncState>): Promise<void> {
    const record = await this.read(bareConvId);
    if (!record) return;
    const syncState: SyncState = { ...DEFAULT_SYNC_STATE, ...record.syncState, ...updates };
    await this.upsert(bareConvId, { ...record, syncState });
  }
}
