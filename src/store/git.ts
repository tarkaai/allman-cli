/**
 * Git auto-commit for the file store.
 *
 * Commits are debounced: multiple writes within `debounceMs` (default 5s)
 * are batched into a single commit. This keeps the git history clean while
 * still providing near-realtime versioning during `lilac listen`.
 */

import simpleGit, { type SimpleGit } from "simple-git";
import { join } from "path";
import * as output from "../utils/output.js";

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

    await git.add("-A");
    await git.commit(this.pendingMessage);
    output.debug(`Git: committed "${this.pendingMessage}" (${status.files.length} files)`);
    this.pendingMessage = "chore: update store";
  }

  /** Return the path to the git-managed store directory. */
  getPath(): string {
    return this.storePath;
  }
}

/** Create a .gitignore in the store root if one doesn't exist. */
export async function ensureGitignore(storePath: string): Promise<void> {
  const { writeFile, access } = await import("fs/promises");
  const gitignorePath = join(storePath, ".gitignore");
  try {
    await access(gitignorePath);
  } catch {
    await writeFile(
      gitignorePath,
      [
        "# lilac-cli store gitignore",
        "*.lock",
        "COOKIES.json",
        "INBOX.jsonl",
        "listen.log",
        "",
      ].join("\n"),
      "utf8"
    );
  }
}
