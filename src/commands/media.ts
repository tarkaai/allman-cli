/**
 * allman media — download a conversation's attachments into the store.
 *
 * Usage:
 *   allman media <conversation> [--message <urn>] [--limit N] [--json]
 *
 * Files land in {accountDir}/{convId}/media/{messageId}-{index}.{ext}
 * (gitignored). Already-downloaded attachments are skipped, so front-ends can
 * call this every time a thread opens. Output lists every attachment with its
 * local path (or why it has none).
 */

import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { downloadMedia, extensionFor } from "../linkedin/api/endpoints/media.js";
import { loadSession } from "../linkedin/api/session.js";
import type { ConversationStore } from "../store/index.js";
import { resolveStorePath, Store } from "../store/index.js";
import * as output from "../utils/output.js";
import { slugFromUrl } from "../utils/slug.js";
import { extractBareConvId, isUrn } from "../utils/urn.js";

export interface MediaOptions {
  account?: string;
  store?: string;
  json?: boolean;
  /** Only this message (any URN form). */
  message?: string;
  /** Max messages to scan, newest first. Default 200. */
  limit?: number;
}

export interface MediaResult {
  messageUrn: string;
  index: number;
  type: string;
  name: string | null;
  mimeType: string | null;
  /** Absolute local path, or null when the attachment has nothing to fetch. */
  path: string | null;
  bytes: number | null;
  status: "downloaded" | "cached" | "no-url" | "failed";
  error?: string;
}

const DOWNLOADABLE = new Set(["image", "gif", "file", "audio", "voice", "video"]);

export async function mediaCommand(target: string, options: MediaOptions): Promise<void> {
  const storePath = resolveStorePath(options.store);
  const store = new Store({ path: storePath });
  await store.init();

  let session: Awaited<ReturnType<typeof loadSession>>;
  try {
    session = await loadSession(store, options.account);
  } catch (err) {
    output.error(String((err as Error).message), 1);
    return;
  }
  const { apiClient, profileId } = session;
  const conversations = store.forAccount(profileId);

  const convId = await resolveConversation(target, conversations);
  if (!convId) {
    output.error(`Conversation "${target}" not found locally. Run \`allman sync\` first.`, 1);
    return;
  }

  const limit = options.limit ?? 200;
  let messages = await conversations.readMessages(convId, { limit });
  if (options.message) {
    const wanted = bareMessageId(options.message);
    messages = messages.filter((m) => bareMessageId(m.urn) === wanted);
  }

  const mediaDir = join(storePath, profileId, convId, "media");
  await mkdir(mediaDir, { recursive: true });
  const existing = new Set(await readdir(mediaDir).catch(() => [] as string[]));

  const results: MediaResult[] = [];
  for (const m of messages) {
    for (const [index, a] of m.attachments.entries()) {
      if (!DOWNLOADABLE.has(a.type)) continue;
      const base = `${bareMessageId(m.urn)}-${index}`;
      const cachedName = [...existing].find((f) => f.startsWith(`${base}.`));
      const common = {
        messageUrn: m.urn,
        index,
        type: a.type,
        name: a.name ?? null,
        mimeType: a.mimeType ?? null,
      };
      if (cachedName) {
        results.push({
          ...common,
          path: join(mediaDir, cachedName),
          bytes: null,
          status: "cached",
        });
        continue;
      }
      const url = a.url ?? urlFromRaw(a.raw);
      if (!url) {
        results.push({ ...common, path: null, bytes: null, status: "no-url" });
        continue;
      }
      try {
        const dl = await downloadMedia(apiClient, url);
        const ext = extensionFor(dl.contentType, a.mimeType, a.name);
        const fileName = `${base}.${ext}`;
        await writeFile(join(mediaDir, fileName), dl.data);
        existing.add(fileName);
        results.push({
          ...common,
          path: join(mediaDir, fileName),
          bytes: dl.bytes,
          status: "downloaded",
        });
      } catch (err) {
        results.push({
          ...common,
          path: null,
          bytes: null,
          status: "failed",
          error: String((err as Error).message ?? err),
        });
      }
    }
  }

  if (options.json) {
    output.printData(results);
    return;
  }
  const downloaded = results.filter((r) => r.status === "downloaded").length;
  const cached = results.filter((r) => r.status === "cached").length;
  const failed = results.filter((r) => r.status === "failed");
  output.success(`${downloaded} downloaded, ${cached} already present → ${mediaDir}`);
  for (const f of failed) output.warn(`  ${f.type} on ${f.messageUrn.slice(-24)}: ${f.error}`);
}

/**
 * Records synced before the parser captured media URLs still carry the raw
 * renderContent; dig the download URL out of it so old threads work too.
 */
export function urlFromRaw(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const get = (o: unknown, k: string): unknown =>
    o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined;
  const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
  const vector = r.vectorImage;
  if (vector) {
    const root = str(get(vector, "rootUrl"));
    const artifacts = get(vector, "artifacts");
    if (Array.isArray(artifacts) && artifacts.length > 0 && root) {
      const best = [...artifacts].sort(
        (x, y) => (Number(get(y, "width")) || 0) - (Number(get(x, "width")) || 0)
      )[0];
      const seg = str(get(best, "fileIdentifyingUrlPathSegment"));
      if (seg) return `${root.replace(/\/$/, "")}/${seg}`;
    }
    if (root) return root;
  }
  for (const key of ["file", "audio", "video", "externalMedia"]) {
    const node = r[key];
    const direct = str(get(node, "url")) ?? str(get(node, "downloadUrl"));
    if (direct) return direct;
    const media = get(node, "media");
    const nested = str(get(media, "url"));
    if (nested) return nested;
  }
  return str(r.url) ?? str(r.downloadUrl);
}

function bareMessageId(urn: string): string {
  const comma = urn.lastIndexOf(",");
  if (comma !== -1) return urn.slice(comma + 1).replace(/\)$/, "");
  const colon = urn.lastIndexOf(":");
  return colon !== -1 ? urn.slice(colon + 1) : urn;
}

async function resolveConversation(
  target: string,
  conversations: ConversationStore
): Promise<string | null> {
  if (isUrn(target)) {
    const bare = extractBareConvId(target);
    if (await conversations.exists(bare)) return bare;
    const found = await conversations.findByUrn(target);
    return found?.convId ?? null;
  }
  // A bare conversation id must keep its case (slug resolution lowercases).
  if (target.startsWith("2-") && (await conversations.exists(target))) return target;
  let slug: string;
  try {
    slug = slugFromUrl(target);
  } catch {
    slug = target;
  }
  return conversations.resolve(slug);
}
