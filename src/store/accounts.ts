/**
 * Account store operations.
 *
 * Layout:
 *   {root}/{profileId}/RECORD.json    — account record (cookies, profile info)
 *   {root}/{profileId}/config.json    — proxy, rate limit config
 *   {root}/{slug} -> {profileId}      — symlink: friendly name → profile ID
 *
 * The profile ID is the LinkedIn fsd_profile ID (e.g. ACoAATEST000...).
 * Symlinks allow addressing accounts by LinkedIn slug (e.g. "dan-moore").
 */

import { readFile, writeFile, mkdir, readdir, access, symlink, readlink, unlink } from "fs/promises";
import { join } from "path";
import type { StoreGit } from "./git.js";
import type { AccountRecord, AccountConfig } from "./types.js";

const RECORD_FILE = "RECORD.json";
const CONFIG_FILE = "config.json";

// Profile IDs are base64-encoded strings starting with "ACo"
const PROFILE_ID_PATTERN = /^ACo/;

const DEFAULT_RECORD: AccountRecord = {
  urn: null,
  profileSlug: null,
  name: null,
  headline: null,
  profileUrl: null,
  imageUrl: null,
  userType: null,
  networkSize: null,
  status: "unauthenticated",
  cookieJar: null,
  cookiesUpdatedAt: null,
  lastSyncAt: null,
};

export class AccountStore {
  constructor(
    private readonly root: string,
    private readonly git: StoreGit
  ) {}

  private dir(profileId: string): string {
    return join(this.root, profileId);
  }

  /** List all account profile IDs (real dirs, not symlinks). */
  async list(): Promise<string[]> {
    try {
      const entries = await readdir(this.root, { withFileTypes: true });
      return entries
        .filter((e) => e.isDirectory() && PROFILE_ID_PATTERN.test(e.name))
        .map((e) => e.name);
    } catch {
      return [];
    }
  }

  /**
   * Resolve an alias (symlink or slug) or profile ID to the actual profile ID.
   * Returns null if not found.
   */
  async resolveId(aliasOrId: string): Promise<string | null> {
    const path = join(this.root, aliasOrId);
    try {
      // Try following symlink
      const target = await readlink(path);
      // Target is relative profileId
      return target;
    } catch {
      // Not a symlink — check if it's a direct profile ID dir
      try {
        await access(join(this.root, aliasOrId, RECORD_FILE));
        return aliasOrId;
      } catch {
        return null;
      }
    }
  }

  /**
   * Create a symlink: {root}/{alias} → {profileId}
   * Overwrites existing symlink if present.
   */
  async createAlias(alias: string, profileId: string): Promise<void> {
    const linkPath = join(this.root, alias);
    try {
      await unlink(linkPath);
    } catch {
      // doesn't exist yet, fine
    }
    await symlink(profileId, linkPath);
  }

  async exists(profileId: string): Promise<boolean> {
    try {
      await access(join(this.dir(profileId), RECORD_FILE));
      return true;
    } catch {
      return false;
    }
  }

  async read(profileId: string): Promise<AccountRecord | null> {
    try {
      const raw = await readFile(join(this.dir(profileId), RECORD_FILE), "utf8");
      return JSON.parse(raw) as AccountRecord;
    } catch {
      return null;
    }
  }

  async write(profileId: string, record: AccountRecord, commitMessage?: string): Promise<void> {
    const dir = this.dir(profileId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, RECORD_FILE), JSON.stringify(record, null, 2) + "\n", "utf8");
    this.git.scheduleCommit(commitMessage ?? `account: update ${profileId.slice(0, 12)}`);
  }

  async update(
    profileId: string,
    updates: Partial<AccountRecord>,
    commitMessage?: string
  ): Promise<AccountRecord> {
    const existing = (await this.read(profileId)) ?? { ...DEFAULT_RECORD };
    const updated = { ...existing, ...updates };
    await this.write(profileId, updated, commitMessage);
    return updated;
  }

  async readConfig(profileId: string): Promise<AccountConfig> {
    try {
      const raw = await readFile(join(this.dir(profileId), CONFIG_FILE), "utf8");
      return JSON.parse(raw) as AccountConfig;
    } catch {
      return {};
    }
  }

  async writeConfig(profileId: string, config: AccountConfig): Promise<void> {
    const dir = this.dir(profileId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, CONFIG_FILE), JSON.stringify(config, null, 2) + "\n", "utf8");
    this.git.scheduleCommit(`account: update config for ${profileId.slice(0, 12)}`);
  }

  /**
   * Resolve the account to use.
   * Returns the profile ID (not a slug/alias).
   */
  async getDefault(aliasOrId?: string): Promise<string> {
    const input = aliasOrId ?? process.env["LILAC_ACCOUNT"];

    if (input) {
      const resolved = await this.resolveId(input);
      if (!resolved) {
        throw new Error(
          `Account "${input}" not found. Run \`lilac login\` to authenticate.`
        );
      }
      return resolved;
    }

    const accounts = await this.list();
    if (accounts.length === 0) {
      throw new Error("No accounts found. Run `lilac login` to authenticate.");
    }
    if (accounts.length === 1) return accounts[0]!;

    // Multiple accounts — require explicit selection
    throw new Error(
      `Multiple accounts found. Specify one with --account or LILAC_ACCOUNT.\nAccounts: ${accounts.join(", ")}`
    );
  }
}
