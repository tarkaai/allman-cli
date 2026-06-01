#!/usr/bin/env node
/**
 * allman — LinkedIn messenger from the CLI
 *
 * Usage: allman <command> [options]
 *
 * Global flags (all commands):
 *   --account <slug>   Account to use (default: first found, or $ALLMAN_ACCOUNT)
 *   --store <path>     Store directory (default: ./.allman, or $ALLMAN_STORE)
 *   --json             Output machine-readable JSON
 *   --debug            Verbose debug output to stderr
 */

import { Command } from "commander";
import { connectionsCommand } from "./commands/connections.js";
import { connectionsOfCommand } from "./commands/connections-of.js";
import { conversationsCommand } from "./commands/conversations.js";
import { grepCommand } from "./commands/grep.js";
import { inboxCommand } from "./commands/inbox.js";
import { listenCommand } from "./commands/listen.js";
import { loginCommand } from "./commands/login.js";
import { logoutCommand } from "./commands/logout.js";
import { messagesCommand } from "./commands/messages.js";
import { reactCommand } from "./commands/react.js";
import { searchCommand } from "./commands/search.js";
import { sendCommand } from "./commands/send.js";
import { startCommand } from "./commands/start.js";
import { statusCommand } from "./commands/status.js";
import { storeCommitCommand, storePathCommand, storeStatusCommand } from "./commands/store-cmd.js";
import { syncCommand } from "./commands/sync.js";
import { setDebugMode, setJsonMode } from "./utils/output.js";

const program = new Command();

program
  .name("allman")
  .description("LinkedIn messenger from the CLI")
  .version("0.2.0")
  .option("-a, --account <slug>", "account to use ($ALLMAN_ACCOUNT)")
  .option("-s, --store <path>", "store directory ($ALLMAN_STORE)")
  .option("--json", "output as JSON")
  .option("--debug", "enable debug output")
  .hook("preAction", (thisCommand) => {
    const opts = thisCommand.opts();
    if (opts.json) setJsonMode(true);
    if (opts.debug) setDebugMode(true);
  });

// ---------------------------------------------------------------------------
// login
// ---------------------------------------------------------------------------

program
  .command("login")
  .description("Authenticate with LinkedIn (opens a browser window)")
  .option("-a, --account <slug>", "account name to create or re-authenticate")
  .option("-s, --store <path>", "store directory")
  .option("--proxy <host:port[:user:pass]>", "HTTP proxy for this account")
  .option("--no-salesnav", "skip the optional Sales Navigator seat capture")
  .option("--json", "output as JSON")
  .action(async (opts, cmd) => {
    const globalOpts = cmd.parent?.opts() ?? {};
    await loginCommand({
      account: opts.account ?? globalOpts.account,
      store: opts.store ?? globalOpts.store,
      proxy: opts.proxy,
      salesnav: opts.salesnav,
      json: opts.json ?? globalOpts.json,
    });
  });

// ---------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------

program
  .command("start")
  .description("Verify auth (login if needed), sync from last sync date, then listen")
  .option("-a, --account <slug>", "account to use")
  .option("-s, --store <path>", "store directory")
  .action(async (opts, cmd) => {
    const globalOpts = cmd.parent?.opts() ?? {};
    await startCommand({
      account: opts.account ?? globalOpts.account,
      store: opts.store ?? globalOpts.store,
    });
  });

// ---------------------------------------------------------------------------
// logout
// ---------------------------------------------------------------------------

program
  .command("logout")
  .description("Clear session cookies for an account")
  .option("-a, --account <slug>", "account to log out")
  .option("-s, --store <path>", "store directory")
  .action(async (opts, cmd) => {
    const globalOpts = cmd.parent?.opts() ?? {};
    await logoutCommand({
      account: opts.account ?? globalOpts.account,
      store: opts.store ?? globalOpts.store,
    });
  });

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

program
  .command("status")
  .description("Show authentication status for accounts")
  .option("-a, --account <slug>", "show only this account")
  .option("-s, --store <path>", "store directory")
  .option("--json", "output as JSON")
  .action(async (opts, cmd) => {
    const globalOpts = cmd.parent?.opts() ?? {};
    await statusCommand({
      account: opts.account ?? globalOpts.account,
      store: opts.store ?? globalOpts.store,
      json: opts.json ?? globalOpts.json,
    });
  });

// ---------------------------------------------------------------------------
// sync
// ---------------------------------------------------------------------------

program
  .command("sync")
  .description("Pull conversation history from LinkedIn into the local store")
  .argument("[conversation]", "sync a single conversation (slug, profileId, or convId)")
  .option("-a, --account <slug>", "account to sync")
  .option("-s, --store <path>", "store directory")
  .option(
    "--from <duration>",
    "older boundary — oldest message to fetch (3mo, 6mo, 1y, YYYY-MM-DD)"
  )
  .option("--to <duration>", "newer boundary — newest message to fetch (defaults to now)")
  .option("--since <duration>", "[deprecated] alias for --from")
  .option("-n, --limit <n>", "max conversations (inbox sync) or messages (single-conv sync)")
  .option("--json", "output as JSON")
  .option(
    "--resync",
    "full re-sync: upsert all fetched messages (fixes stale reactions, parser changes)"
  )
  .action(async (conversation: string | undefined, opts, cmd) => {
    const globalOpts = cmd.parent?.opts() ?? {};
    await syncCommand({
      conversation,
      account: opts.account ?? globalOpts.account,
      store: opts.store ?? globalOpts.store,
      since: opts.since,
      from: opts.from,
      to: opts.to,
      limit: opts.limit ? parseInt(opts.limit, 10) : undefined,
      json: opts.json ?? globalOpts.json,
      resync: opts.resync,
    });
  });

// ---------------------------------------------------------------------------
// listen
// ---------------------------------------------------------------------------

program
  .command("listen")
  .description("Stream real-time LinkedIn events to stdout as NDJSON")
  .option("-a, --account <slug>", "account to listen on")
  .option("-s, --store <path>", "store directory")
  .action(async (opts, cmd) => {
    const globalOpts = cmd.parent?.opts() ?? {};
    await listenCommand({
      account: opts.account ?? globalOpts.account,
      store: opts.store ?? globalOpts.store,
    });
  });

// ---------------------------------------------------------------------------
// conversations
// ---------------------------------------------------------------------------

program
  .command("conversations")
  .alias("convs")
  .description("List conversations from the local store")
  .option("-a, --account <slug>", "filter by account")
  .option("-s, --store <path>", "store directory")
  .option("--json", "output as JSON")
  .option("-n, --limit <n>", "max conversations to show", "50")
  .action(async (opts, cmd) => {
    const globalOpts = cmd.parent?.opts() ?? {};
    await conversationsCommand({
      account: opts.account ?? globalOpts.account,
      store: opts.store ?? globalOpts.store,
      json: opts.json ?? globalOpts.json,
      limit: parseInt(opts.limit, 10),
    });
  });

// ---------------------------------------------------------------------------
// messages
// ---------------------------------------------------------------------------

program
  .command("messages <conversation>")
  .alias("msgs")
  .description(
    "Show messages for a conversation\n" +
      "  <conversation> can be: slug, LinkedIn URL, or conversation URN"
  )
  .option("-a, --account <slug>", "account")
  .option("-s, --store <path>", "store directory")
  .option("--json", "output as JSON")
  .option("-n, --limit <n>", "max messages to show", "50")
  .option("--since <date>", "show messages since this date (ISO format)")
  .option("--no-sync", "don't auto-sync if conversation not found")
  .action(async (conversation: string, opts, cmd) => {
    const globalOpts = cmd.parent?.opts() ?? {};
    await messagesCommand(conversation, {
      account: opts.account ?? globalOpts.account,
      store: opts.store ?? globalOpts.store,
      json: opts.json ?? globalOpts.json,
      limit: parseInt(opts.limit, 10),
      since: opts.since,
      noSync: opts.sync === false,
    });
  });

// ---------------------------------------------------------------------------
// send
// ---------------------------------------------------------------------------

program
  .command("send <to> <text>")
  .description(
    "Send a message\n" + "  <to> can be: LinkedIn profile URL, profile slug, or conversation URN"
  )
  .option("-a, --account <slug>", "account to send from")
  .option("-s, --store <path>", "store directory")
  .option("--json", "output as JSON")
  .action(async (to: string, text: string, opts, cmd) => {
    const globalOpts = cmd.parent?.opts() ?? {};
    await sendCommand(to, text, {
      account: opts.account ?? globalOpts.account,
      store: opts.store ?? globalOpts.store,
      json: opts.json ?? globalOpts.json,
    });
  });

// ---------------------------------------------------------------------------
// react
// ---------------------------------------------------------------------------

program
  .command("react <target> <emoji>")
  .description(
    "Add an emoji reaction to a message\n" +
      "  <target> can be: slug, LinkedIn URL, or conversation URN\n" +
      "  Defaults to the most recent message (use --message to pick one)"
  )
  .option("-a, --account <slug>", "account to react from")
  .option("-s, --store <path>", "store directory")
  .option("-m, --message <urn>", "message URN to react to (defaults to most recent)")
  .option("--unreact", "remove your reaction instead of adding")
  .option("--json", "output as JSON")
  .action(async (target: string, emoji: string, opts, cmd) => {
    const globalOpts = cmd.parent?.opts() ?? {};
    await reactCommand(target, emoji, {
      account: opts.account ?? globalOpts.account,
      store: opts.store ?? globalOpts.store,
      json: opts.json ?? globalOpts.json,
      message: opts.message,
      unreact: opts.unreact,
    });
  });

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

program
  .command("search <query>")
  .description("Search contacts and conversations by name")
  .option("-a, --account <slug>", "account to search")
  .option("-s, --store <path>", "store directory")
  .option("--json", "output as JSON")
  .option("-n, --limit <n>", "max results (default: 10)", "10")
  .action(async (query: string, opts, cmd) => {
    const globalOpts = cmd.parent?.opts() ?? {};
    await searchCommand(query, {
      account: opts.account ?? globalOpts.account,
      store: opts.store ?? globalOpts.store,
      json: opts.json ?? globalOpts.json,
      limit: parseInt(opts.limit, 10),
    });
  });

// ---------------------------------------------------------------------------
// inbox
// ---------------------------------------------------------------------------

program
  .command("inbox")
  .description("Show new messages since last check (watermark-based)")
  .option("-a, --account <slug>", "account to check")
  .option("-s, --store <path>", "store directory")
  .option("--since <duration>", "override watermark (1h, 3d, 1w, or ISO date)")
  .option("--no-mark", "don't advance the watermark after viewing")
  .option("-n, --limit <n>", "max conversations to show")
  .option("--json", "output as JSON")
  .action(async (opts, cmd) => {
    const globalOpts = cmd.parent?.opts() ?? {};
    await inboxCommand({
      account: opts.account ?? globalOpts.account,
      store: opts.store ?? globalOpts.store,
      since: opts.since,
      noMark: opts.mark === false,
      limit: opts.limit ? parseInt(opts.limit, 10) : undefined,
      json: opts.json ?? globalOpts.json,
    });
  });

// ---------------------------------------------------------------------------
// grep
// ---------------------------------------------------------------------------

program
  .command("grep <query>")
  .description("Full-text search across all stored messages")
  .option("-a, --account <slug>", "account to search")
  .option("-s, --store <path>", "store directory")
  .option("--since <duration>", "only search messages after this date/duration")
  .option("-n, --limit <n>", "max results (default: 50)", "50")
  .option("--json", "output as JSON")
  .action(async (query: string, opts, cmd) => {
    const globalOpts = cmd.parent?.opts() ?? {};
    await grepCommand(query, {
      account: opts.account ?? globalOpts.account,
      store: opts.store ?? globalOpts.store,
      since: opts.since,
      limit: parseInt(opts.limit, 10),
      json: opts.json ?? globalOpts.json,
    });
  });

// ---------------------------------------------------------------------------
// store (subcommands)
// ---------------------------------------------------------------------------

const storeCmd = program.command("store").description("Manage the local file store");

storeCmd
  .command("path")
  .description("Print the store path")
  .option("-s, --store <path>", "store directory")
  .action(async (opts, cmd) => {
    const globalOpts = cmd.parent?.parent?.opts() ?? {};
    await storePathCommand({ store: opts.store ?? globalOpts.store });
  });

storeCmd
  .command("commit [message]")
  .description("Manually trigger a git commit")
  .option("-s, --store <path>", "store directory")
  .action(async (message: string | undefined, opts, cmd) => {
    const globalOpts = cmd.parent?.parent?.opts() ?? {};
    await storeCommitCommand(message, { store: opts.store ?? globalOpts.store });
  });

storeCmd
  .command("status")
  .description("Show store statistics")
  .option("-s, --store <path>", "store directory")
  .action(async (opts, cmd) => {
    const globalOpts = cmd.parent?.parent?.opts() ?? {};
    await storeStatusCommand({ store: opts.store ?? globalOpts.store });
  });

// ---------------------------------------------------------------------------
// connections — export 1st-degree connections to CSV/NDJSON
// ---------------------------------------------------------------------------

program
  .command("connections")
  .description(
    "Export your 1st-degree LinkedIn connections into the store (per-connection files + slug symlinks)"
  )
  .option("-a, --account <slug>", "account to use")
  .option("-s, --store <path>", "store directory")
  .option("--csv <path>", "also export a CSV to this path")
  .option("--no-save", "don't write to the store (use with --csv for a pure export)")
  .option("-n, --limit <n>", "max connections to fetch (default: all)")
  .option("--page-size <n>", "results per request (default: 100, max: 500)", "100")
  .option("--include-headline", "include the LinkedIn headline in stored records / CSV")
  .option("--json", "stream NDJSON to stdout (ephemeral — does not write the store)")
  .action(async (opts, cmd) => {
    const globalOpts = cmd.parent?.opts() ?? {};
    await connectionsCommand({
      account: opts.account ?? globalOpts.account,
      store: opts.store ?? globalOpts.store,
      json: opts.json ?? globalOpts.json,
      csv: opts.csv,
      noStore: opts.save === false,
      limit: opts.limit ? parseInt(opts.limit, 10) : undefined,
      pageSize: opts.pageSize ? parseInt(opts.pageSize, 10) : undefined,
      includeHeadline: opts.includeHeadline === true,
    });
  });

// ---------------------------------------------------------------------------
// connections-of — list people connected to <input> via Sales Navigator
// ---------------------------------------------------------------------------

program
  .command("connections-of <slug>")
  .description(
    "List the 1st-degree connections of <slug> (a LinkedIn slug or profile URL). Uses Sales Navigator when a seat is present and falls back to flagship otherwise; --flagship/--salesnav force a backend (no fallback)."
  )
  .option("-a, --account <slug>", "account to use")
  .option("-s, --store <path>", "store directory")
  .option("--csv <path>", "also export a CSV to this path")
  .option("--no-save", "don't write to the store (use with --csv for a pure export)")
  .option("-n, --limit <n>", "max results to fetch")
  .option("--flagship", "force the flagship people-search backend (no fallback)")
  .option("--salesnav", "force the Sales Navigator backend (no fallback; errors without a seat)")
  .option("--json", "stream NDJSON to stdout (ephemeral — does not write the store)")
  .action(async (slug: string, opts, cmd) => {
    const globalOpts = cmd.parent?.opts() ?? {};
    await connectionsOfCommand(slug, {
      account: opts.account ?? globalOpts.account,
      store: opts.store ?? globalOpts.store,
      json: opts.json ?? globalOpts.json,
      csv: opts.csv,
      noStore: opts.save === false,
      limit: opts.limit ? parseInt(opts.limit, 10) : undefined,
      flagship: opts.flagship === true,
      salesnav: opts.salesnav === true,
    });
  });

// ---------------------------------------------------------------------------
// install-browsers
// ---------------------------------------------------------------------------

program
  .command("install-browsers")
  .description("Install Playwright's Chromium browser (required for login)")
  .action(async () => {
    const { execSync } = await import("node:child_process");
    process.stderr.write("Installing Chromium via Playwright...\n");
    execSync("npx playwright install chromium", { stdio: "inherit" });
    process.stderr.write("Done.\n");
  });

// ---------------------------------------------------------------------------
// Parse & run
// ---------------------------------------------------------------------------

program.parseAsync(process.argv).catch((err: unknown) => {
  process.stderr.write(`Error: ${String(err)}\n`);
  process.exit(1);
});
