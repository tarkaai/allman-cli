/**
 * allman people — find people you can message, by name.
 *
 * Usage:
 *   allman people "jane roe" [--limit N] [--json]
 *
 * Uses the same lookup as linkedin.com's "New message" box (connections and
 * coworkers). Read-only. Slugs come from the local store when the person is
 * already known (a conversation or exported connection), else one profile
 * lookup per hit so the result is directly usable by `allman send <slug>`.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { searchMessagingTypeahead } from "../linkedin/api/endpoints/messaging-typeahead.js";
import { getProfileSlugById } from "../linkedin/api/endpoints/profiles.js";
import { loadSession } from "../linkedin/api/session.js";
import type { ConversationStore } from "../store/index.js";
import { resolveStorePath, Store } from "../store/index.js";
import * as output from "../utils/output.js";

export interface PeopleOptions {
  account?: string;
  store?: string;
  json?: boolean;
  limit?: number;
}

export interface PersonResult {
  name: string;
  slug: string | null;
  profileId: string;
  headline: string | null;
  location: string | null;
  distance: string | null;
  imageUrl: string | null;
  /** Local conversation id when a thread with this person already exists. */
  convId: string | null;
}

export async function peopleCommand(query: string, options: PeopleOptions): Promise<void> {
  const q = query.trim();
  if (!q) {
    output.error("Give me a name to search for.", 1);
    return;
  }
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
  const accountDir = join(storePath, profileId);

  let hits: Awaited<ReturnType<typeof searchMessagingTypeahead>>;
  try {
    hits = await searchMessagingTypeahead(apiClient, q);
  } catch (err) {
    output.error(`Search failed: ${(err as Error).message}`, 1);
    return;
  }
  const limit = Math.min(Math.max(options.limit ?? 10, 1), 25);

  const results: PersonResult[] = [];
  for (const h of hits.slice(0, limit)) {
    const local = await resolveLocalSlug(conversations, accountDir, h.profileId);
    let slug = local.slug;
    if (!slug) {
      slug = await getProfileSlugById(apiClient, h.profileId).catch(() => null);
    }
    results.push({
      name: h.name,
      slug,
      profileId: h.profileId,
      headline: h.headline,
      location: null,
      distance: h.distance,
      imageUrl: h.imageUrl,
      convId: local.convId,
    });
  }

  if (options.json) {
    output.printData(results);
    return;
  }
  if (results.length === 0) {
    output.info(`No one found for "${q}".`);
    return;
  }
  for (const r of results) {
    const tag = r.distance ? ` (${r.distance.replace("DISTANCE_", "")}°)` : "";
    process.stdout.write(
      `  ${(r.slug ?? r.profileId).padEnd(32)} ${r.name}${tag}${r.headline ? `  — ${r.headline}` : ""}\n`
    );
  }
}

/** Slug (and conversation id) from the local store, without any API call. */
async function resolveLocalSlug(
  conversations: ConversationStore,
  accountDir: string,
  flagshipId: string
): Promise<{ slug: string | null; convId: string | null }> {
  // {accountDir}/{profileId} -> {convId} symlink, written by sync.
  const convId = await conversations.resolve(flagshipId).catch(() => null);
  if (convId) {
    const rec = await conversations.read(convId).catch(() => null);
    if (rec?.slug) return { slug: rec.slug, convId };
  }
  // connections/{flagshipId}.json, written by `allman connections`.
  try {
    const raw = await readFile(join(accountDir, "connections", `${flagshipId}.json`), "utf8");
    const parsed = JSON.parse(raw) as { publicIdentifier?: string | null };
    if (parsed.publicIdentifier) return { slug: parsed.publicIdentifier, convId: convId ?? null };
  } catch {
    /* not a stored connection */
  }
  return { slug: null, convId: convId ?? null };
}
