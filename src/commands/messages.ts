import { Store, resolveStorePath } from "../store/index.js";
import { slugFromUrl } from "../utils/slug.js";
import { isUrn } from "../utils/urn.js";
import { printData, relativeTime, info, error } from "../utils/output.js";

export interface MessagesOptions {
  account?: string;
  store?: string;
  json?: boolean;
  limit?: number;
  since?: string;
}

export async function messagesCommand(
  target: string,
  options: MessagesOptions
): Promise<void> {
  const storePath = resolveStorePath(options.store);
  const store = new Store({ path: storePath });
  await store.init();

  await store.accounts.getDefault(options.account); // validates account exists

  // Resolve target to a conversation slug
  let conversationSlug: string | null = null;

  if (isUrn(target)) {
    const found = await store.conversations.findByUrn(target);
    conversationSlug = found?.slug ?? null;
  } else {
    let slug: string;
    try {
      slug = slugFromUrl(target);
    } catch {
      slug = target;
    }
    if (await store.conversations.exists(slug)) {
      conversationSlug = slug;
    }
  }

  if (!conversationSlug) {
    error(
      `Conversation "${target}" not found in local store. Run \`lilac sync\` to pull history.`,
      1
    );
    return;
  }

  const record = await store.conversations.read(conversationSlug);
  if (!record) {
    error(`Conversation record not found for "${conversationSlug}".`, 1);
    return;
  }

  const sinceMs = options.since ? new Date(options.since).getTime() : undefined;
  const messages = await store.conversations.readMessages(conversationSlug, {
    since: sinceMs,
    limit: options.limit ?? 50,
  });

  if (messages.length === 0) {
    info("No messages found. Try running `lilac sync` to pull history.");
    return;
  }

  if (options.json) {
    printData(messages);
    return;
  }

  // Human-readable output
  const lines = messages.map((m) => {
    const time = relativeTime(m.timestamp);
    const sender = m.isFromMe ? "You" : (m.fromName || m.fromSlug);
    const prefix = m.isFromMe ? "→" : "←";
    const attachments =
      m.attachments.length > 0 ? ` [${m.attachments.map((a) => a.type).join(", ")}]` : "";
    const reactions =
      m.reactions.length > 0
        ? ` ${m.reactions.map((r) => `${r.emoji}×${r.count}`).join(" ")}`
        : "";
    return `${prefix} ${sender.padEnd(20)} ${time.padEnd(12)} ${m.body}${attachments}${reactions}`;
  });

  process.stdout.write(`Conversation: ${record.title}\n\n`);
  process.stdout.write(lines.join("\n") + "\n");
}
