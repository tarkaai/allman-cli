/**
 * Store — the local file-backed store for lilac-cli.
 *
 * Directory layout:
 *   {root}/
 *   ├── .git/
 *   ├── .gitignore
 *   ├── {profileId}/                      ← account dir
 *   │   ├── AUTH.json                     ← profile info, auth status
 *   │   ├── COOKIES.json                  ← cookie jar (gitignored)
 *   │   ├── config.json                   ← proxy, rate limits
 *   │   ├── INBOX.jsonl                   ← new message notifications (gitignored)
 *   │   ├── listen.log                    ← SSE debug log (gitignored)
 *   │   ├── {convId}/                     ← conversation dir
 *   │   │   ├── RECORD.json
 *   │   │   └── messages/YYYY-MM.jsonl
 *   │   ├── {profileId} -> {convId}       ← contact profile ID symlink
 *   │   └── {slug} -> {convId}            ← LinkedIn slug symlink
 *   └── {slug} -> {profileId}             ← account symlink
 */

import { mkdir, access } from "fs/promises";
import { join, resolve } from "path";
import { StoreGit, ensureGitignore } from "./git.js";
import { AccountStore } from "./accounts.js";
import { ConversationStore } from "./conversations.js";

export interface StoreOptions {
  /** Absolute path to the store root. Defaults to ./.lilac */
  path?: string;
  /** Git commit debounce in ms. Default: 5000 */
  gitDebounceMs?: number;
}

export class Store {
  readonly root: string;
  readonly git: StoreGit;
  readonly accounts: AccountStore;

  constructor(options: StoreOptions = {}) {
    this.root = resolve(options.path ?? ".lilac");
    this.git = new StoreGit(this.root, options.gitDebounceMs);
    this.accounts = new AccountStore(this.root, this.git);
  }

  /** Initialize the store: create root dir, init git, write .gitignore. */
  async init(): Promise<void> {
    await ensureStoreDir(this.root);
    await ensureGitignore(this.root);
    await this.git.init();
  }

  /**
   * Return a conversation store scoped to a specific account.
   * The profileId must be a real profile ID (not an alias).
   */
  forAccount(profileId: string): ConversationStore {
    const accountDir = join(this.root, profileId);
    return new ConversationStore(accountDir, this.git);
  }

  /** Return the resolved store root path. */
  get path(): string {
    return this.root;
  }
}

/**
 * Resolve the store path from (in priority order):
 *   1. --store CLI flag value
 *   2. LILAC_STORE environment variable
 *   3. Default: ./.lilac
 */
export function resolveStorePath(flagValue?: string): string {
  return resolve(flagValue ?? process.env["LILAC_STORE"] ?? ".lilac");
}

async function ensureStoreDir(dirPath: string): Promise<void> {
  try {
    await access(dirPath);
  } catch {
    await mkdir(dirPath, { recursive: true });
  }
}

export { AccountStore } from "./accounts.js";
export { ConversationStore } from "./conversations.js";
export * from "./types.js";
