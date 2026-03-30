/**
 * Account store operations.
 *
 * Manages {root}/accounts/{slug}/RECORD.json and config.json.
 * Cookies are stored inside RECORD.json as a serialized tough-cookie CookieJar.
 */

import { readFile, writeFile, mkdir, readdir, access } from "fs/promises";
import { join } from "path";
import type { StoreGit } from "./git.js";
import type { AccountRecord, AccountConfig } from "./types.js";

const RECORD_FILE = "RECORD.json";
const CONFIG_FILE = "config.json";

const DEFAULT_RECORD: AccountRecord = {
  urn: null,
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

  private dir(slug: string): string {
    return join(this.root, "accounts", slug);
  }

  async list(): Promise<string[]> {
    const accountsDir = join(this.root, "accounts");
    try {
      const entries = await readdir(accountsDir, { withFileTypes: true });
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

  async read(slug: string): Promise<AccountRecord | null> {
    try {
      const raw = await readFile(join(this.dir(slug), RECORD_FILE), "utf8");
      return JSON.parse(raw) as AccountRecord;
    } catch {
      return null;
    }
  }

  async write(slug: string, record: AccountRecord, commitMessage?: string): Promise<void> {
    const dir = this.dir(slug);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, RECORD_FILE), JSON.stringify(record, null, 2) + "\n", "utf8");
    this.git.scheduleCommit(commitMessage ?? `account: update ${slug}`);
  }

  async readConfig(slug: string): Promise<AccountConfig> {
    try {
      const raw = await readFile(join(this.dir(slug), CONFIG_FILE), "utf8");
      return JSON.parse(raw) as AccountConfig;
    } catch {
      return {};
    }
  }

  async writeConfig(slug: string, config: AccountConfig): Promise<void> {
    const dir = this.dir(slug);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, CONFIG_FILE), JSON.stringify(config, null, 2) + "\n", "utf8");
    this.git.scheduleCommit(`account: update config for ${slug}`);
  }

  /** Create a new account with default record. */
  async create(slug: string, config: AccountConfig = {}): Promise<AccountRecord> {
    const record = { ...DEFAULT_RECORD };
    await this.write(slug, record, `account: create ${slug}`);
    if (Object.keys(config).length > 0) {
      await this.writeConfig(slug, config);
    }
    return record;
  }

  /** Update specific fields of the account record. */
  async update(
    slug: string,
    updates: Partial<AccountRecord>,
    commitMessage?: string
  ): Promise<AccountRecord> {
    const existing = (await this.read(slug)) ?? { ...DEFAULT_RECORD };
    const updated = { ...existing, ...updates };
    await this.write(slug, updated, commitMessage ?? `account: update ${slug}`);
    return updated;
  }

  /**
   * Get the first available account, or throw if none exist.
   * Used when --account is not specified.
   */
  async getDefault(preferredSlug?: string): Promise<string> {
    const envSlug = process.env["LILAC_ACCOUNT"];
    const slug = preferredSlug ?? envSlug;

    if (slug) {
      if (!(await this.exists(slug))) {
        throw new Error(
          `Account "${slug}" not found. Run \`lilac login --account ${slug}\` to create it.`
        );
      }
      return slug;
    }

    const accounts = await this.list();
    if (accounts.length === 0) {
      throw new Error("No accounts found. Run `lilac login` to authenticate.");
    }

    accounts.sort();
    return accounts[0]!;
  }
}
