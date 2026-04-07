/**
 * lilac grep — full-text search across all stored messages.
 */

import { createReadStream } from "fs";
import { readdir } from "fs/promises";
import { join } from "path";
import { createInterface } from "readline";
import { Store, resolveStorePath } from "../store/index.js";
import { printData, relativeTime } from "../utils/output.js";
import type { StoredMessage } from "../store/types.js";

export interface GrepOptions {
  account?: string;
  store?: string;
  since?: string;
  limit?: number;
  json?: boolean;
}

export interface GrepMatch {
  name: string;
  slug: string | null;
  convId: string;
  message: StoredMessage;
}

export async function grepCommand(query: string, options: GrepOptions): Promise<void> {
  const storePath = resolveStorePath(options.store);
  const store = new Store({ path: storePath });
  await store.init();

  const profileId = await store.accounts.getDefault(options.account);
  const conversations = store.forAccount(profileId);
  const accountDir = join(store.root, profileId);

  const sinceMs = options.since ? parseSince(options.since) : 0;
  const limit = options.limit ?? 50;
  const lowerQuery = query.toLowerCase();

  const convIds = await conversations.list();
  const matches: GrepMatch[] = [];

  outer: for (const convId of convIds) {
    const record = await conversations.read(convId);
    if (!record) continue;

    const messagesDir = join(accountDir, convId, "messages");
    let files: string[];
    try {
      files = (await readdir(messagesDir)).filter((f) => f.endsWith(".jsonl")).sort();
    } catch {
      continue;
    }

    for (const file of files) {
      const rl = createInterface({
        input: createReadStream(join(messagesDir, file)),
        crlfDelay: Infinity,
      });
      for await (const line of rl) {
        if (!line.trim()) continue;
        let msg: StoredMessage;
        try {
          msg = JSON.parse(line) as StoredMessage;
        } catch {
          continue;
        }
        if (sinceMs && msg.timestamp < sinceMs) continue;
        if (msg.body.toLowerCase().includes(lowerQuery)) {
          matches.push({ name: record.name, slug: record.slug, convId, message: msg });
          if (matches.length >= limit) break outer;
        }
      }
    }
  }

  // Sort newest first
  matches.sort((a, b) => b.message.timestamp - a.message.timestamp);

  if (options.json) {
    printData(matches);
    return;
  }

  if (matches.length === 0) {
    process.stdout.write(`No messages matching "${query}"\n`);
    return;
  }

  for (const { name, message: m } of matches) {
    const dir = m.isFromMe ? "→" : "←";
    const sender = m.isFromMe ? "You" : (m.fromName || name);
    const time = relativeTime(m.timestamp);
    const body = m.body.length > 200 ? m.body.slice(0, 200) + "…" : m.body;
    process.stdout.write(`${name.padEnd(25)} ${dir} ${sender.padEnd(18)} ${time.padEnd(12)} ${body}\n`);
  }
}

function parseSince(value: string): number {
  const durationMatch = value.match(/^(\d+)(h|d|w|mo)$/);
  if (durationMatch) {
    const n = parseInt(durationMatch[1]!, 10);
    const unit = durationMatch[2]!;
    const ms = unit === "h" ? n * 60 * 60 * 1000
      : unit === "d" ? n * 24 * 60 * 60 * 1000
      : unit === "w" ? n * 7 * 24 * 60 * 60 * 1000
      : n * 30 * 24 * 60 * 60 * 1000;
    return Date.now() - ms;
  }
  const ts = Date.parse(value);
  if (!isNaN(ts)) return ts;
  throw new Error(`Cannot parse --since value: "${value}". Use a duration (1h, 3d, 1w) or ISO date.`);
}
