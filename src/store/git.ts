/**
 * Git auto-commit for the file store.
 *
 * Commits are debounced: multiple writes within `debounceMs` (default 5s)
 * are batched into a single commit. This keeps the git history clean while
 * still providing near-realtime versioning during `allman listen`.
 */

import { stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import simpleGit, { type SimpleGit } from "simple-git";
import * as output from "../utils/output.js";

/**
 * An `index.lock` older than this has no live owner: git holds the lock for
 * the length of one `add`/`commit`, which is seconds even on a large store.
 * A crash or force-quit mid-commit leaves the file behind, and every later
 * commit then fails until someone deletes it by hand.
 */
export const STALE_LOCK_MS = 5 * 60 * 1000;

export class StoreGit {
  private git: SimpleGit | null = null;
  private readonly storePath: string;
  private debounceMs: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pendingMessage: string = "chore: update store";

  constructor(storePath: string, debounceMs = 5000) {
    this.storePath = storePath;
    this.debounceMs = debounceMs;
  }

  private getGit(): SimpleGit {
    if (!this.git) {
      this.git = simpleGit(this.storePath);
    }
    return this.git;
  }

  /** Initialize git repo if not already initialized. */
  async init(): Promise<void> {
    // Reset the cached instance to ensure it points to the (now-existing) dir
    this.git = simpleGit(this.storePath);
    const isRepo = await this.git.checkIsRepo().catch(() => false);
    if (!isRepo) {
      await this.git.init();
      output.debug("Initialized git repo in store");
    }
  }

  /**
   * Schedule a debounced commit with the given message.
   * If a commit is already pending, the message is upgraded if the new one
   * is more specific (longer).
   */
  scheduleCommit(message: string): void {
    if (message.length > this.pendingMessage.length) {
      this.pendingMessage = message;
    }
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.flush().catch((err: unknown) => {
        output.debug(`Git auto-commit failed: ${String(err)}`);
      });
    }, this.debounceMs);
  }

  /** Flush any pending commit immediately. */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    const git = this.getGit();
    const status = await git.status();
    if (status.files.length === 0) {
      output.debug("Git: nothing to commit");
      return;
    }

    // Two allman processes (e.g. `react` while `listen` persists a message) can
    // race on .git/index.lock. Back off briefly and retry instead of surfacing
    // a raw git error to the caller.
    const maxAttempts = 6;
    for (let attempt = 1; ; attempt++) {
      try {
        await git.add("-A");
        await git.commit(this.pendingMessage);
        break;
      } catch (err: unknown) {
        const msg = String(err);
        const locked = /index\.lock|\.lock['"]?: File exists|another git process/i.test(msg);
        if (!locked || attempt >= maxAttempts) throw err;
        await this.clearStaleLock();
        const delay = 150 * attempt;
        output.debug(
          `Git: index locked, retrying in ${delay}ms (attempt ${attempt}/${maxAttempts})`
        );
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    output.debug(`Git: committed "${this.pendingMessage}" (${status.files.length} files)`);
    this.pendingMessage = "chore: update store";
  }

  /**
   * `flush` for a command whose remote write has already happened (a message
   * sent, a reaction added, a thread marked read). The data is on disk either
   * way; a failed commit must not turn a delivered message into a non-zero
   * exit that a caller (the Mac app, a script) would retry — that is how one
   * send became four. Warns and returns false instead of throwing.
   */
  async flushOrWarn(context: string): Promise<boolean> {
    try {
      await this.flush();
      return true;
    } catch (err: unknown) {
      const msg = String((err as Error).message ?? err).split("\n")[0];
      output.warn(
        `${context}, but the store commit failed: ${msg}. Run \`allman store commit\` to retry.`
      );
      return false;
    }
  }

  /**
   * Remove `.git/index.lock` when it is older than `STALE_LOCK_MS` — left by a
   * git that died mid-commit, not held by anyone now. A fresh lock belongs to
   * a concurrent allman process and is left alone for the retry loop.
   */
  async clearStaleLock(now = Date.now()): Promise<boolean> {
    const lockPath = join(this.storePath, ".git", "index.lock");
    try {
      const st = await stat(lockPath);
      if (now - st.mtimeMs < STALE_LOCK_MS) return false;
      await unlink(lockPath);
      output.warn(
        `Removed stale ${lockPath} (untouched for ${Math.round((now - st.mtimeMs) / 60000)} min)`
      );
      return true;
    } catch {
      return false;
    }
  }

  /** Return the path to the git-managed store directory. */
  getPath(): string {
    return this.storePath;
  }
}

/** Files that must never be committed to the store repo. */
const STORE_GITIGNORE: readonly string[] = [
  "# allman-cli store gitignore",
  "*.lock",
  "COOKIES.json",
  "COOKIES.json.*.tmp",
  "INBOX.jsonl",
  "media/",
  "inbox-state.json",
  "rate-state.json",
  "query-cache.json",
  "listen.log",
  "",
];

/**
 * Create a .gitignore in the store root, or append any required entry an
 * existing one lacks (older stores predate e.g. the cookie temp file).
 */
export async function ensureGitignore(storePath: string): Promise<void> {
  const { writeFile, readFile, appendFile } = await import("node:fs/promises");
  const gitignorePath = join(storePath, ".gitignore");
  let existing: string | null = null;
  try {
    existing = await readFile(gitignorePath, "utf8");
  } catch {
    existing = null;
  }
  if (existing === null) {
    await writeFile(gitignorePath, `${STORE_GITIGNORE.join("\n")}\n`, "utf8");
    return;
  }
  const have = new Set(existing.split("\n").map((l) => l.trim()));
  const missing = STORE_GITIGNORE.filter((l) => l !== "" && !l.startsWith("#") && !have.has(l));
  if (missing.length === 0) return;
  const sep = existing.endsWith("\n") || existing === "" ? "" : "\n";
  await appendFile(gitignorePath, `${sep}${missing.join("\n")}\n`, "utf8");
}
