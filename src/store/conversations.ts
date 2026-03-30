/**
 * Conversation store operations.
 *
 * Manages {root}/conversations/{slug}/RECORD.json and messages/YYYY-MM.jsonl.
 * Messages are partitioned by month for efficient access and small file sizes.
 */

import { readFile, writeFile, mkdir, readdir, access, appendFile } from "fs/promises";
import { createReadStream } from "fs";
import { createInterface } from "readline";
import { join } from "path";
import type { StoreGit } from "./git.js";
import type { ConversationRecord, StoredMessage, SyncState } from "./types.js";

const RECORD_FILE = "RECORD.json";

const DEFAULT_SYNC_STATE: SyncState = {
  oldestMessageAt: null,
  newestMessageAt: null,
  lastSyncAt: null,
  totalSynced: 0,
  fullyBackfilled: false,
};

export class ConversationStore {
  constructor(
    private readonly root: string,
    private readonly git: StoreGit
  ) {}

  private dir(slug: string): string {
    return join(this.root, "conversations", slug);
  }

  private messagesDir(slug: string): string {
    return join(this.dir(slug), "messages");
  }

  private messageFile(slug: string, timestampMs: number): string {
    const d = new Date(timestampMs);
    const month = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    return join(this.messagesDir(slug), `${month}.jsonl`);
  }

  async list(accountSlug?: string): Promise<string[]> {
    const dir = join(this.root, "conversations");
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      const slugs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
      if (!accountSlug) return slugs;

      // Filter by account
      const result: string[] = [];
      for (const slug of slugs) {
        const record = await this.read(slug);
        if (record?.account === accountSlug) result.push(slug);
      }
      return result;
    } catch {
      return [];
    }
  }

  async exists(slug: string): Promise<boolean> {
    try {
      await access(join(this.dir(slug), RECORD_FILE));
      return true;
    } catch {
      return false;
    }
  }

  async read(slug: string): Promise<ConversationRecord | null> {
    try {
      const raw = await readFile(join(this.dir(slug), RECORD_FILE), "utf8");
      return JSON.parse(raw) as ConversationRecord;
    } catch {
      return null;
    }
  }

  async write(slug: string, record: ConversationRecord, commitMessage?: string): Promise<void> {
    const dir = this.dir(slug);
    await mkdir(dir, { recursive: true });
    await mkdir(this.messagesDir(slug), { recursive: true });
    await writeFile(join(dir, RECORD_FILE), JSON.stringify(record, null, 2) + "\n", "utf8");
    this.git.scheduleCommit(commitMessage ?? `conversation: update ${slug}`);
  }

  async upsert(slug: string, record: ConversationRecord): Promise<void> {
    const existing = await this.read(slug);
    if (existing) {
      const updated: ConversationRecord = {
        ...existing,
        ...record,
        syncState: {
          ...DEFAULT_SYNC_STATE,
          ...existing.syncState,
          ...record.syncState,
        },
      };
      await this.write(slug, updated, `conversation: update ${slug}`);
    } else {
      const withDefaults: ConversationRecord = {
        ...record,
        syncState: { ...DEFAULT_SYNC_STATE, ...record.syncState },
      };
      await this.write(slug, withDefaults, `conversation: add ${slug}`);
    }
  }

  /** Update sync state fields only, preserving everything else. */
  async updateSyncState(
    slug: string,
    updates: Partial<SyncState>,
    commitMessage?: string
  ): Promise<void> {
    const existing = await this.read(slug);
    if (!existing) throw new Error(`Conversation not found: ${slug}`);
    const updated: ConversationRecord = {
      ...existing,
      syncState: { ...DEFAULT_SYNC_STATE, ...existing.syncState, ...updates },
    };
    await this.write(slug, updated, commitMessage ?? `sync: update ${slug}`);
  }

  /**
   * Append messages to the monthly JSONL file.
   * Deduplicates by URN: skips any message whose URN is already stored in that month's file.
   * Returns the count of actually written messages.
   */
  async appendMessages(slug: string, messages: StoredMessage[]): Promise<number> {
    if (messages.length === 0) return 0;

    // Group messages by month file
    const byFile = new Map<string, StoredMessage[]>();
    for (const msg of messages) {
      const file = this.messageFile(slug, msg.timestamp);
      const group = byFile.get(file) ?? [];
      group.push(msg);
      byFile.set(file, group);
    }

    let written = 0;
    for (const [file, msgs] of byFile) {
      await mkdir(join(file, ".."), { recursive: true });

      // Load existing URNs from this file for dedup
      const existingUrns = await this.readMessageUrns(file);

      const newLines: string[] = [];
      for (const msg of msgs) {
        if (!existingUrns.has(msg.urn)) {
          newLines.push(JSON.stringify(msg));
          written++;
        }
      }

      if (newLines.length > 0) {
        await appendFile(file, newLines.join("\n") + "\n", "utf8");
      }
    }

    if (written > 0) {
      this.git.scheduleCommit(`messages: add ${written} to ${slug}`);
    }

    return written;
  }

  /** Read messages from a conversation, optionally filtered by time range. */
  async readMessages(
    slug: string,
    opts: {
      since?: number; // Unix ms
      until?: number; // Unix ms
      limit?: number;
    } = {}
  ): Promise<StoredMessage[]> {
    const messagesDir = this.messagesDir(slug);
    let files: string[];
    try {
      const entries = await readdir(messagesDir);
      files = entries.filter((f) => f.endsWith(".jsonl")).sort();
    } catch {
      return [];
    }

    const results: StoredMessage[] = [];

    for (const file of files) {
      const messages = await this.readJsonlFile(join(messagesDir, file));
      for (const msg of messages) {
        if (opts.since !== undefined && msg.timestamp < opts.since) continue;
        if (opts.until !== undefined && msg.timestamp > opts.until) continue;
        results.push(msg);
        if (opts.limit !== undefined && results.length >= opts.limit) return results;
      }
    }

    return results;
  }

  /** Find a conversation by its LinkedIn conversation URN. */
  async findByUrn(urn: string): Promise<{ slug: string; record: ConversationRecord } | null> {
    const slugs = await this.list();
    for (const slug of slugs) {
      const record = await this.read(slug);
      if (record && (record.urn === urn || record.backendUrn === urn)) {
        return { slug, record };
      }
    }
    return null;
  }

  /** Find a 1:1 conversation with a specific contact URN. */
  async findByParticipantUrn(
    contactUrn: string,
    accountSlug: string
  ): Promise<{ slug: string; record: ConversationRecord } | null> {
    const slugs = await this.list(accountSlug);
    for (const slug of slugs) {
      const record = await this.read(slug);
      if (
        record &&
        !record.isGroup &&
        record.participants.some((p) => p.urn === contactUrn)
      ) {
        return { slug, record };
      }
    }
    return null;
  }

  private async readJsonlFile(filePath: string): Promise<StoredMessage[]> {
    const messages: StoredMessage[] = [];
    try {
      const stream = createReadStream(filePath, "utf8");
      const rl = createInterface({ input: stream, crlfDelay: Infinity });
      for await (const line of rl) {
        const trimmed = line.trim();
        if (trimmed) {
          try {
            messages.push(JSON.parse(trimmed) as StoredMessage);
          } catch {
            // Skip malformed lines
          }
        }
      }
    } catch {
      // File doesn't exist yet
    }
    return messages;
  }

  private async readMessageUrns(filePath: string): Promise<Set<string>> {
    const urns = new Set<string>();
    const messages = await this.readJsonlFile(filePath);
    for (const msg of messages) urns.add(msg.urn);
    return urns;
  }
}
