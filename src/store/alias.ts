/**
 * Shared symlink utility for the allman store.
 *
 * All code paths that create symlinks (sync, listen, login) go through here.
 * Ensures consistency: if a symlink already points to the correct target, no-op.
 * If it points elsewhere, that's a hard error (mapping conflict).
 */

import { access, mkdir, readlink, symlink, unlink } from "node:fs/promises";
import { join } from "node:path";

/**
 * Ensure a directory exists for `id` inside `parentDir`.
 * Creates `{parentDir}/{id}/` if it doesn't exist.
 */
export async function ensureDir(parentDir: string, id: string): Promise<string> {
  const dir = join(parentDir, id);
  await mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Create a symlink: `{parentDir}/{alias}` → `{target}`.
 *
 * - If alias already points to same target → no-op (idempotent)
 * - If alias points to different target → throws (mapping conflict)
 * - If alias doesn't exist → creates it
 */
export async function ensureAlias(parentDir: string, alias: string, target: string): Promise<void> {
  const linkPath = join(parentDir, alias);

  try {
    const existing = await readlink(linkPath);
    if (existing === target) return; // idempotent

    throw new Error(
      `Alias conflict: "${alias}" already points to "${existing}" but expected "${target}". ` +
        `This indicates a mapping inconsistency in the store.`
    );
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      // Symlink doesn't exist — create it
      await symlink(target, linkPath);
      return;
    }
    // Re-throw conflict errors or unexpected errors
    throw err;
  }
}

/**
 * Create or update a symlink, overwriting if the target has changed.
 * Use this only when the target is expected to change (e.g., slug updated after resolution).
 */
export async function forceAlias(parentDir: string, alias: string, target: string): Promise<void> {
  const linkPath = join(parentDir, alias);
  try {
    const existing = await readlink(linkPath);
    if (existing === target) return;
    await unlink(linkPath);
  } catch {
    // doesn't exist, fine
  }
  await symlink(target, linkPath);
}

/**
 * Resolve an alias (symlink) or direct ID to the actual target.
 * Returns null if the alias doesn't exist and isn't a direct directory.
 */
export async function resolveAlias(parentDir: string, aliasOrId: string): Promise<string | null> {
  const path = join(parentDir, aliasOrId);
  try {
    // Try symlink first
    return await readlink(path);
  } catch {
    // Not a symlink — check if it's a direct directory with a RECORD.json
    try {
      await access(join(path, "RECORD.json"));
      return aliasOrId;
    } catch {
      return null;
    }
  }
}
