/**
 * Contact store operations.
 *
 * Layout:
 *   {accountDir}/contacts/{contactProfileId}/RECORD.json
 *   {accountDir}/contacts/{slug} -> {contactProfileId}   (symlink)
 */

import { readFile, writeFile, mkdir, readdir, access, symlink, readlink, unlink } from "fs/promises";
import { join } from "path";
import type { StoreGit } from "./git.js";
import type { ContactRecord } from "./types.js";

const RECORD_FILE = "RECORD.json";
const PROFILE_ID_PATTERN = /^ACo/;

export class ContactStore {
  private readonly contactsDir: string;

  constructor(
    accountDir: string,
    private readonly git: StoreGit
  ) {
    this.contactsDir = join(accountDir, "contacts");
  }

  private dir(profileId: string): string {
    return join(this.contactsDir, profileId);
  }

  async list(): Promise<string[]> {
    try {
      const entries = await readdir(this.contactsDir, { withFileTypes: true });
      return entries
        .filter((e) => e.isDirectory() && PROFILE_ID_PATTERN.test(e.name))
        .map((e) => e.name);
    } catch {
      return [];
    }
  }

  async read(profileId: string): Promise<ContactRecord | null> {
    try {
      const raw = await readFile(join(this.dir(profileId), RECORD_FILE), "utf8");
      return JSON.parse(raw) as ContactRecord;
    } catch {
      return null;
    }
  }

  async write(profileId: string, record: ContactRecord): Promise<void> {
    const dir = this.dir(profileId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, RECORD_FILE), JSON.stringify(record, null, 2) + "\n", "utf8");
    this.git.scheduleCommit(`contact: update ${profileId.slice(0, 12)}`);
  }

  async upsert(profileId: string, record: ContactRecord): Promise<void> {
    const existing = await this.read(profileId);
    await this.write(profileId, existing ? { ...existing, ...record } : record);
  }

  /** Create a symlink: contacts/{slug} → {profileId} */
  async createAlias(slug: string, profileId: string): Promise<void> {
    await mkdir(this.contactsDir, { recursive: true });
    const linkPath = join(this.contactsDir, slug);
    try { await unlink(linkPath); } catch { /* ok */ }
    await symlink(profileId, linkPath);
  }

  /** Resolve a slug/alias to a profile ID via symlink, or return the input if it's a direct ID. */
  async resolveId(slugOrId: string): Promise<string | null> {
    const path = join(this.contactsDir, slugOrId);
    try {
      return await readlink(path);
    } catch {
      try {
        await access(join(this.contactsDir, slugOrId, RECORD_FILE));
        return slugOrId;
      } catch {
        return null;
      }
    }
  }

  /** Find a contact by their LinkedIn profile URN. */
  async findByUrn(urn: string): Promise<{ profileId: string; record: ContactRecord } | null> {
    const ids = await this.list();
    for (const profileId of ids) {
      const record = await this.read(profileId);
      if (record?.urn === urn) return { profileId, record };
    }
    return null;
  }
}
