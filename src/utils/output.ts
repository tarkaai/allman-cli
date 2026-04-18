/**
 * Output helpers.
 *
 * All user-visible output goes through these helpers so that:
 *   - `--json` mode is consistently handled
 *   - NDJSON events (for `allman listen`) go to stdout
 *   - Logs, warnings, and errors always go to stderr
 *
 * This separation is critical: AI agents parse stdout; logs must not pollute it.
 */

import { inspect } from "node:util";

let _jsonMode = false;
let _debugMode = false;

export function setJsonMode(enabled: boolean): void {
  _jsonMode = enabled;
}

export function setDebugMode(enabled: boolean): void {
  _debugMode = enabled;
}

export function isJsonMode(): boolean {
  return _jsonMode;
}

/** Print structured data to stdout — either as pretty table or JSON. */
export function printData(data: unknown): void {
  if (_jsonMode) {
    process.stdout.write(`${JSON.stringify(data)}\n`);
  } else {
    process.stdout.write(`${formatHuman(data)}\n`);
  }
}

/** Emit a single NDJSON event to stdout (used by `allman listen`). */
export function emitEvent(event: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

/** Print an informational message to stderr. */
export function info(message: string): void {
  process.stderr.write(`${message}\n`);
}

/** Print a warning to stderr. */
export function warn(message: string): void {
  process.stderr.write(`⚠ ${message}\n`);
}

/** Print an error to stderr and optionally exit. */
export function error(message: string, exit?: number): void {
  process.stderr.write(`✗ ${message}\n`);
  if (exit !== undefined) {
    process.exit(exit);
  }
}

/** Print a debug message to stderr (only in --debug mode). */
export function debug(message: string): void {
  if (_debugMode) {
    process.stderr.write(`[debug] ${message}\n`);
  }
}

/** Print a success message to stderr. */
export function success(message: string): void {
  process.stderr.write(`✓ ${message}\n`);
}

function formatHuman(data: unknown): string {
  if (typeof data === "string") return data;
  if (Array.isArray(data)) {
    return data.map((item) => formatHuman(item)).join("\n");
  }
  if (data !== null && typeof data === "object") {
    return inspect(data, { depth: 4, colors: process.stderr.isTTY });
  }
  return String(data);
}

/** Format a timestamp (ms) as a human-readable relative string. */
export function relativeTime(timestampMs: number): string {
  const diff = Date.now() - timestampMs;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/** Format a timestamp (ms) as ISO date string. */
export function isoTime(timestampMs: number): string {
  return new Date(timestampMs).toISOString();
}
