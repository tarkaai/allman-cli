/**
 * Store — the local file-backed store for lilac-cli.
 *
 * Directory layout:
 *   {root}/
 *   ├── .git/
 *   ├── .gitignore
 *   ├── {profileId}/                      ← account dir
 *   │   ├── RECORD.json                   ← cookies + profile
 *   │   ├── config.json                   ← proxy, rate limits
 *   │   ├── listen.log                    ← SSE event log
 *   │   ├── contacts/
 *   │   │   ├── {contactProfileId}/RECORD.json
 *   │   │   └── {slug} -> {profileId}     ← symlink
 *   │   └── {bareConvId}/                 ← conversation dir
 *   │       ├── RECORD.json
 *   │       └── messages/YYYY-MM.jsonl
 *   │   (+ {slug} -> {bareConvId} symlinks for conversations)
 *   └── {slug} -> {profileId}             ← account symlink
 */

import { mkdir, access, writeFile } from "fs/promises";
import { join, resolve } from "path";
import { StoreGit, ensureGitignore } from "./git.js";
import { AccountStore } from "./accounts.js";
import { ContactStore } from "./contacts.js";
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
    await ensureDir(this.root);
    await ensureGitignore(this.root);
    await this.git.init();
  }

  /**
   * Return conversation and contact stores scoped to a specific account.
   * The profileId must be a real profile ID (not an alias).
   */
  forAccount(profileId: string): { conversations: ConversationStore; contacts: ContactStore } {
    const accountDir = join(this.root, profileId);
    return {
      conversations: new ConversationStore(accountDir, this.git),
      contacts: new ContactStore(accountDir, this.git),
    };
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

async function ensureDir(dirPath: string): Promise<void> {
  try {
    await access(dirPath);
  } catch {
    await mkdir(dirPath, { recursive: true });
  }
}

export { AccountStore } from "./accounts.js";
export { ContactStore } from "./contacts.js";
export { ConversationStore } from "./conversations.js";
export * from "./types.js";
