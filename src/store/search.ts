/**
 * Fuzzy search across conversations by contact name, slug, or profileId.
 * Returns results with confidence scores for agent use.
 */

import type { ConversationStore } from "./conversations.js";
import type { ConversationRecord } from "./types.js";

export interface SearchResult {
  name: string;
  slug: string | null;
  profileId: string;
  convId: string;
  confidence: number; // 0-100
}

export interface SearchOptions {
  limit?: number;
}

/**
 * Search conversations by query string.
 * Scoring tiers:
 *   100: exact slug or profileId match
 *    95: exact name match (case-insensitive)
 *    80: name starts with query
 *    70: every query word matches start of a word in name
 *    60: name contains query substring
 *    40: any query word found in name
 */
export async function search(
  query: string,
  conversations: ConversationStore,
  options: SearchOptions = {}
): Promise<SearchResult[]> {
  const limit = options.limit ?? 10;
  if (!query.trim()) return [];

  const q = query.trim().toLowerCase();
  const qWords = q.split(/\s+/);

  const convIds = await conversations.list();
  const results: SearchResult[] = [];

  for (const convId of convIds) {
    const record = await conversations.read(convId);
    if (!record) continue;

    const score = scoreMatch(q, qWords, record);
    if (score > 0) {
      results.push({
        name: record.name,
        slug: record.slug,
        profileId: record.profileId,
        convId: record.convId,
        confidence: score,
      });
    }
  }

  results.sort((a, b) => b.confidence - a.confidence);
  return results.slice(0, limit);
}

function scoreMatch(
  query: string,
  queryWords: string[],
  record: ConversationRecord
): number {
  const slug = record.slug?.toLowerCase() ?? "";
  const profileId = record.profileId.toLowerCase();
  const name = record.name.toLowerCase();
  const nameWords = name.split(/\s+/);

  // Exact slug or profileId match
  if (query === slug || query === profileId) return 100;

  // Exact name match
  if (query === name) return 95;

  // Name starts with query
  if (name.startsWith(query)) return 80;

  // Every query word matches start of a word in name
  // e.g. "ali smi" matches "Alice Smith"
  if (queryWords.length > 1) {
    const allMatch = queryWords.every((qw) =>
      nameWords.some((nw) => nw.startsWith(qw))
    );
    if (allMatch) return 70;
  }

  // Name or slug contains query as substring
  if (name.includes(query) || slug.includes(query)) return 60;

  // Any query word found in name
  const anyMatch = queryWords.some(
    (qw) => name.includes(qw) || slug.includes(qw)
  );
  if (anyMatch) return 40;

  return 0;
}
