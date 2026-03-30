/**
 * Store — the local file-backed store for lilac-cli.
 *
 * Directory layout:
 *   {root}/
 *   ├── .git/
 *   ├── .gitignore
 *   ├── accounts/{slug}/
 *   │   ├── RECORD.json
 *   │   └── config.json
 *   ├── contacts/{slug}/
 *   │   └── RECORD.json
 *   └── conversations/{slug}/
 *       ├── RECORD.json
 *       └── messages/
 *           └── YYYY-MM.jsonl
 */

import { mkdir, access } from "fs/promises";
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
  readonly contacts: ContactStore;
  readonly conversations: ConversationStore;

  constructor(options: StoreOptions = {}) {
    this.root = resolve(options.path ?? ".lilac");
    this.git = new StoreGit(this.root, options.gitDebounceMs);
    this.accounts = new AccountStore(this.root, this.git);
    this.contacts = new ContactStore(this.root, this.git);
    this.conversations = new ConversationStore(this.root, this.git);
  }

  /** Initialize the store: create directories, init git, write .gitignore. */
  async init(): Promise<void> {
    await ensureDir(this.root);
    await ensureDir(join(this.root, "accounts"));
    await ensureDir(join(this.root, "contacts"));
    await ensureDir(join(this.root, "conversations"));
    await ensureGitignore(this.root);
    await this.git.init();
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
