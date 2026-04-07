/**
 * Account store operations.
 *
 * Layout:
 *   {root}/{profileId}/AUTH.json       — profile info, auth status (committed)
 *   {root}/{profileId}/COOKIES.json    — cookie jar (gitignored, sensitive)
 *   {root}/{profileId}/config.json     — proxy, rate limit config
 *   {root}/{slug} -> {profileId}       — symlink: friendly name → profile ID
 */

import { readFile, writeFile, readdir } from "fs/promises";
import { join } from "path";
import { ensureDir, forceAlias, resolveAlias } from "./alias.js";
import type { StoreGit } from "./git.js";
import type { AccountAuth, AccountCookies, AccountRecord, AccountConfig, AccountRateState, AccountInboxState } from "./types.js";

const AUTH_FILE = "AUTH.json";
const COOKIES_FILE = "COOKIES.json";
const CONFIG_FILE = "config.json";
const RATE_STATE_FILE = "rate-state.json";
const INBOX_STATE_FILE = "inbox-state.json";

// Profile IDs are base64-encoded strings starting with "ACo"
const PROFILE_ID_PATTERN = /^ACo/;

const DEFAULT_AUTH: AccountAuth = {
  urn: null,
  profileSlug: null,
  name: null,
  headline: null,
  profileUrl: null,
  imageUrl: null,
  userType: null,
  networkSize: null,
  status: "unauthenticated",
  lastSyncAt: null,
};

const DEFAULT_COOKIES: AccountCookies = {
  cookieJar: null,
  cookiesUpdatedAt: null,
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

  /** Resolve an alias (symlink or slug) or profile ID to the actual profile ID. */
  async resolveId(aliasOrId: string): Promise<string | null> {
    // Direct profile ID check
    if (PROFILE_ID_PATTERN.test(aliasOrId)) {
      try {
        await readFile(join(this.dir(aliasOrId), AUTH_FILE), "utf8");
        return aliasOrId;
      } catch { /* not found */ }
    }
    // Try symlink
    return resolveAlias(this.root, aliasOrId);
  }

  /** Create a symlink: {root}/{alias} → {profileId} */
  async createAlias(alias: string, profileId: string): Promise<void> {
    await forceAlias(this.root, alias, profileId);
  }

  async exists(profileId: string): Promise<boolean> {
    try {
      await readFile(join(this.dir(profileId), AUTH_FILE), "utf8");
      return true;
    } catch {
      return false;
    }
  }

  /** Read merged AUTH + COOKIES as a single AccountRecord. */
  async read(profileId: string): Promise<AccountRecord | null> {
    const auth = await this.readAuth(profileId);
    if (!auth) return null;
    const cookies = await this.readCookies(profileId);
    return { ...auth, ...(cookies ?? DEFAULT_COOKIES) };
  }

  async readAuth(profileId: string): Promise<AccountAuth | null> {
    try {
      const raw = await readFile(join(this.dir(profileId), AUTH_FILE), "utf8");
      return JSON.parse(raw) as AccountAuth;
    } catch {
      return null;
    }
  }

  async readCookies(profileId: string): Promise<AccountCookies | null> {
    try {
      const raw = await readFile(join(this.dir(profileId), COOKIES_FILE), "utf8");
      return JSON.parse(raw) as AccountCookies;
    } catch {
      return null;
    }
  }

  /** Write AUTH.json (profile info, status). */
  async writeAuth(profileId: string, auth: AccountAuth, commitMessage?: string): Promise<void> {
    await ensureDir(this.root, profileId);
    await writeFile(join(this.dir(profileId), AUTH_FILE), JSON.stringify(auth, null, 2) + "\n", "utf8");
    this.git.scheduleCommit(commitMessage ?? `account: update ${profileId.slice(0, 12)}`);
  }

  /** Write COOKIES.json (cookie jar). No git commit — cookies are gitignored. */
  async writeCookies(profileId: string, cookies: AccountCookies): Promise<void> {
    await ensureDir(this.root, profileId);
    await writeFile(join(this.dir(profileId), COOKIES_FILE), JSON.stringify(cookies, null, 2) + "\n", "utf8");
  }

  /** Write both AUTH + COOKIES (convenience for login). */
  async write(profileId: string, record: AccountRecord, commitMessage?: string): Promise<void> {
    const { cookieJar, cookiesUpdatedAt, ...auth } = record;
    await this.writeAuth(profileId, auth, commitMessage);
    await this.writeCookies(profileId, { cookieJar, cookiesUpdatedAt });
  }

  /** Update specific fields across AUTH and/or COOKIES. */
  async update(
    profileId: string,
    updates: Partial<AccountRecord>,
    commitMessage?: string
  ): Promise<AccountRecord> {
    const existing = (await this.read(profileId)) ?? { ...DEFAULT_AUTH, ...DEFAULT_COOKIES };
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
    await ensureDir(this.root, profileId);
    await writeFile(join(this.dir(profileId), CONFIG_FILE), JSON.stringify(config, null, 2) + "\n", "utf8");
    this.git.scheduleCommit(`account: update config for ${profileId.slice(0, 12)}`);
  }

  async readRateState(profileId: string): Promise<AccountRateState | null> {
    try {
      const raw = await readFile(join(this.dir(profileId), RATE_STATE_FILE), "utf8");
      return JSON.parse(raw) as AccountRateState;
    } catch {
      return null;
    }
  }

  async writeRateState(profileId: string, state: AccountRateState): Promise<void> {
    await ensureDir(this.root, profileId);
    await writeFile(join(this.dir(profileId), RATE_STATE_FILE), JSON.stringify(state) + "\n", "utf8");
  }

  async readInboxState(profileId: string): Promise<AccountInboxState | null> {
    try {
      const raw = await readFile(join(this.dir(profileId), INBOX_STATE_FILE), "utf8");
      return JSON.parse(raw) as AccountInboxState;
    } catch {
      return null;
    }
  }

  async writeInboxState(profileId: string, state: AccountInboxState): Promise<void> {
    await ensureDir(this.root, profileId);
    await writeFile(join(this.dir(profileId), INBOX_STATE_FILE), JSON.stringify(state) + "\n", "utf8");
  }

  /**
   * Resolve the account to use. Returns the profile ID (not a slug/alias).
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

    throw new Error(
      `Multiple accounts found. Specify one with --account or LILAC_ACCOUNT.\nAccounts: ${accounts.join(", ")}`
    );
  }
}
