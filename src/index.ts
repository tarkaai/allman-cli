#!/usr/bin/env node
/**
 * lilac — LinkedIn messenger from the CLI
 *
 * Usage: lilac <command> [options]
 *
 * Global flags (all commands):
 *   --account <slug>   Account to use (default: first found, or $LILAC_ACCOUNT)
 *   --store <path>     Store directory (default: ./.lilac, or $LILAC_STORE)
 *   --json             Output machine-readable JSON
 *   --debug            Verbose debug output to stderr
 */

import { Command } from "commander";
import { setJsonMode, setDebugMode } from "./utils/output.js";
import { loginCommand } from "./commands/login.js";
import { logoutCommand } from "./commands/logout.js";
import { statusCommand } from "./commands/status.js";
import { syncCommand } from "./commands/sync.js";
import { listenCommand } from "./commands/listen.js";
import { conversationsCommand } from "./commands/conversations.js";
import { messagesCommand } from "./commands/messages.js";
import { sendCommand } from "./commands/send.js";
import {
  storePathCommand,
  storeCommitCommand,
  storeStatusCommand,
} from "./commands/store-cmd.js";

const program = new Command();

program
  .name("lilac")
  .description("LinkedIn messenger from the CLI")
  .version("0.1.0")
  .option("-a, --account <slug>", "account to use ($LILAC_ACCOUNT)")
  .option("-s, --store <path>", "store directory ($LILAC_STORE)")
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
  .option("--json", "output as JSON")
  .action(async (opts, cmd) => {
    const globalOpts = cmd.parent?.opts() ?? {};
    await loginCommand({
      account: opts.account ?? globalOpts.account,
      store: opts.store ?? globalOpts.store,
      proxy: opts.proxy,
      json: opts.json ?? globalOpts.json,
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
  .option("-a, --account <slug>", "account to sync")
  .option("-s, --store <path>", "store directory")
  .option("--since <duration>", "sync since this date/duration (3mo, 6mo, 1y, YYYY-MM-DD)", "3mo")
  .option("--json", "output as JSON")
  .action(async (opts, cmd) => {
    const globalOpts = cmd.parent?.opts() ?? {};
    await syncCommand({
      account: opts.account ?? globalOpts.account,
      store: opts.store ?? globalOpts.store,
      since: opts.since,
      json: opts.json ?? globalOpts.json,
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
  .action(async (conversation: string, opts, cmd) => {
    const globalOpts = cmd.parent?.opts() ?? {};
    await messagesCommand(conversation, {
      account: opts.account ?? globalOpts.account,
      store: opts.store ?? globalOpts.store,
      json: opts.json ?? globalOpts.json,
      limit: parseInt(opts.limit, 10),
      since: opts.since,
    });
  });

// ---------------------------------------------------------------------------
// send
// ---------------------------------------------------------------------------

program
  .command("send <to> <text>")
  .description(
    "Send a message\n" +
      "  <to> can be: LinkedIn profile URL, profile slug, or conversation URN"
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
// store (subcommands)
// ---------------------------------------------------------------------------

const storeCmd = program
  .command("store")
  .description("Manage the local file store");

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
// install-browsers
// ---------------------------------------------------------------------------

program
  .command("install-browsers")
  .description("Install Playwright's Chromium browser (required for login)")
  .action(async () => {
    const { execSync } = await import("child_process");
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
