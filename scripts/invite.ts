#!/usr/bin/env bun
/**
 * Invite code management script for lilac private beta.
 *
 * Usage:
 *   bun scripts/invite.ts generate [count]   — generate invite codes (default: 1)
 *   bun scripts/invite.ts list               — list all codes with status
 *   bun scripts/invite.ts revoke <code>       — revoke a code
 *
 * Codes are stored in scripts/invite-codes.json (gitignored — keep a backup).
 * The valid codes are embedded in the CLI binary at build time via
 * scripts/invite-codes.json → src/utils/invite.ts reads at runtime.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { randomBytes } from "crypto";

const CODES_PATH = join(dirname(new URL(import.meta.url).pathname), "invite-codes.json");

interface InviteCode {
  code: string;
  createdAt: string;
  status: "active" | "revoked";
  note?: string;
}

function loadCodes(): InviteCode[] {
  if (!existsSync(CODES_PATH)) return [];
  return JSON.parse(readFileSync(CODES_PATH, "utf-8"));
}

function saveCodes(codes: InviteCode[]): void {
  writeFileSync(CODES_PATH, JSON.stringify(codes, null, 2) + "\n");
}

function generateCode(): string {
  // Format: LILAC-XXXX-XXXX (readable, easy to share)
  const bytes = randomBytes(4);
  const hex = bytes.toString("hex").toUpperCase();
  return `LILAC-${hex.slice(0, 4)}-${hex.slice(4, 8)}`;
}

const [, , command, ...args] = process.argv;

switch (command) {
  case "generate": {
    const count = parseInt(args[0] || "1", 10);
    const codes = loadCodes();
    const newCodes: InviteCode[] = [];

    for (let i = 0; i < count; i++) {
      let code: string;
      do {
        code = generateCode();
      } while (codes.some((c) => c.code === code));

      const entry: InviteCode = {
        code,
        createdAt: new Date().toISOString(),
        status: "active",
        ...(args[1] ? { note: args.slice(1).join(" ") } : {}),
      };
      codes.push(entry);
      newCodes.push(entry);
    }

    saveCodes(codes);
    console.log(`Generated ${count} invite code(s):\n`);
    for (const c of newCodes) {
      console.log(`  ${c.code}`);
    }
    console.log(`\nTotal active codes: ${codes.filter((c) => c.status === "active").length}`);
    break;
  }

  case "list": {
    const codes = loadCodes();
    if (codes.length === 0) {
      console.log("No invite codes. Run: bun scripts/invite.ts generate");
      break;
    }
    console.log(`${"CODE".padEnd(16)} ${"STATUS".padEnd(10)} ${"CREATED".padEnd(24)} NOTE`);
    console.log("─".repeat(70));
    for (const c of codes) {
      const status = c.status === "active" ? "✓ active" : "✗ revoked";
      console.log(
        `${c.code.padEnd(16)} ${status.padEnd(10)} ${c.createdAt.slice(0, 19).padEnd(24)} ${c.note ?? ""}`
      );
    }
    console.log(`\nTotal: ${codes.length} (${codes.filter((c) => c.status === "active").length} active)`);
    break;
  }

  case "revoke": {
    const target = args[0];
    if (!target) {
      console.error("Usage: bun scripts/invite.ts revoke <code>");
      process.exit(1);
    }
    const codes = loadCodes();
    const entry = codes.find((c) => c.code === target.toUpperCase());
    if (!entry) {
      console.error(`Code not found: ${target}`);
      process.exit(1);
    }
    entry.status = "revoked";
    saveCodes(codes);
    console.log(`Revoked: ${entry.code}`);
    break;
  }

  case "export": {
    // Export active codes as a JSON array for embedding in the CLI binary
    const codes = loadCodes();
    const active = codes.filter((c) => c.status === "active").map((c) => c.code);
    const outPath = join(dirname(new URL(import.meta.url).pathname), "..", "src", "utils", "invite-codes.json");
    writeFileSync(outPath, JSON.stringify(active) + "\n");
    console.log(`Exported ${active.length} active codes to src/utils/invite-codes.json`);
    break;
  }

  default:
    console.log(`lilac invite code manager

Usage:
  bun scripts/invite.ts generate [count] [note]  — generate invite code(s)
  bun scripts/invite.ts list                      — list all codes
  bun scripts/invite.ts revoke <code>             — revoke a code
  bun scripts/invite.ts export                    — export active codes for build
`);
}
