/**
 * Invite code validation for lilac private beta.
 *
 * On first run, prompts the user for an invite code. The code is validated
 * against the bundled list and stored in ~/.lilac/.invite so subsequent
 * runs skip the prompt.
 *
 * Build step: `bun scripts/invite.ts export` writes src/utils/invite-codes.json
 * which is imported at build time and embedded in the binary.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { createInterface } from "readline";

// Bundled at build time by `bun scripts/invite.ts export`
let VALID_CODES: string[] = [];
try {
  VALID_CODES = JSON.parse(
    readFileSync(new URL("./invite-codes.json", import.meta.url), "utf-8")
  );
} catch {
  // No codes file = open access (dev mode)
}

const INVITE_FILE = ".invite";

function getInvitePath(storePath?: string): string {
  const base = storePath ?? join(homedir(), ".lilac");
  return join(base, INVITE_FILE);
}

/** Check if a valid invite code is already stored. */
export function hasValidInvite(storePath?: string): boolean {
  // No codes bundled = dev mode, always valid
  if (VALID_CODES.length === 0) return true;

  const path = getInvitePath(storePath);
  if (!existsSync(path)) return false;

  try {
    const stored = readFileSync(path, "utf-8").trim();
    return VALID_CODES.includes(stored);
  } catch {
    return false;
  }
}

/** Prompt the user for an invite code and validate it. */
export async function promptInviteCode(storePath?: string): Promise<boolean> {
  // No codes bundled = dev mode, skip
  if (VALID_CODES.length === 0) return true;

  if (hasValidInvite(storePath)) return true;

  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
  });

  process.stderr.write("\n");
  process.stderr.write("  lilac is in private beta.\n");
  process.stderr.write("  Enter your invite code to continue.\n");
  process.stderr.write("  Request access at https://lilac.tarka.ai\n");
  process.stderr.write("\n");

  return new Promise((resolve) => {
    rl.question("  Invite code: ", (answer) => {
      rl.close();
      const code = answer.trim().toUpperCase();

      if (!VALID_CODES.includes(code)) {
        process.stderr.write("\n  ✗ Invalid invite code.\n\n");
        resolve(false);
        return;
      }

      // Store the validated code
      const base = storePath ?? join(homedir(), ".lilac");
      mkdirSync(base, { recursive: true });
      writeFileSync(getInvitePath(storePath), code + "\n");

      process.stderr.write("\n  ✓ Welcome to lilac!\n\n");
      resolve(true);
    });
  });
}
