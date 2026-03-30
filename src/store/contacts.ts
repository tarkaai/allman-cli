/**
 * Contact store operations.
 *
 * Manages {root}/contacts/{slug}/RECORD.json.
 * A contact slug is the LinkedIn URL path segment (e.g. "sarah-chen").
 * The RECORD.json is the source of truth for URN↔slug mapping.
 */

import { readFile, writeFile, mkdir, readdir, access } from "fs/promises";
import { join } from "path";
import type { StoreGit } from "./git.js";
import type { ContactRecord } from "./types.js";

const RECORD_FILE = "RECORD.json";

export class ContactStore {
  constructor(
    private readonly root: string,
    private readonly git: StoreGit
  ) {}

  private dir(slug: string): string {
    return join(this.root, "contacts", slug);
  }

  async list(): Promise<string[]> {
    const dir = join(this.root, "contacts");
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      return entries.filter((e) => e.isDirectory()).map((e) => e.name);
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

  async read(slug: string): Promise<ContactRecord | null> {
    try {
      const raw = await readFile(join(this.dir(slug), RECORD_FILE), "utf8");
      return JSON.parse(raw) as ContactRecord;
    } catch {
      return null;
    }
  }

  async write(slug: string, record: ContactRecord, commitMessage?: string): Promise<void> {
    const dir = this.dir(slug);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, RECORD_FILE), JSON.stringify(record, null, 2) + "\n", "utf8");
    this.git.scheduleCommit(commitMessage ?? `contact: update ${slug}`);
  }

  async upsert(slug: string, record: ContactRecord): Promise<void> {
    const existing = await this.read(slug);
    if (existing) {
      // Preserve fetchedAt unless explicitly overridden
      await this.write(slug, { ...existing, ...record }, `contact: update ${slug}`);
    } else {
      await this.write(slug, record, `contact: add ${slug}`);
    }
  }

  /** Find a contact by their LinkedIn profile URN. */
  async findByUrn(urn: string): Promise<{ slug: string; record: ContactRecord } | null> {
    const slugs = await this.list();
    for (const slug of slugs) {
      const record = await this.read(slug);
      if (record?.urn === urn) {
        return { slug, record };
      }
    }
    return null;
  }

  /** Search contacts by partial name match (case-insensitive). */
  async search(query: string): Promise<Array<{ slug: string; record: ContactRecord }>> {
    const slugs = await this.list();
    const results: Array<{ slug: string; record: ContactRecord }> = [];
    const q = query.toLowerCase();
    for (const slug of slugs) {
      const record = await this.read(slug);
      if (record && (record.name.toLowerCase().includes(q) || slug.includes(q))) {
        results.push({ slug, record });
      }
    }
    return results;
  }
}
