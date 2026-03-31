import { Store, resolveStorePath } from "../store/index.js";
import { slugFromUrl } from "../utils/slug.js";
import { isUrn, extractBareConvId } from "../utils/urn.js";
import { printData, relativeTime, info, error } from "../utils/output.js";

export interface MessagesOptions {
  account?: string;
  store?: string;
  json?: boolean;
  limit?: number;
  since?: string;
}

export async function messagesCommand(target: string, options: MessagesOptions): Promise<void> {
  const storePath = resolveStorePath(options.store);
  const store = new Store({ path: storePath });
  await store.init();

  const profileId = await store.accounts.getDefault(options.account);
  const { conversations } = store.forAccount(profileId);

  // Resolve target to a bare conversation ID
  let bareConvId: string | null = null;

  if (isUrn(target)) {
    // Direct URN — extract bare ID or look up by URN
    const bare = extractBareConvId(target);
    if (await conversations.exists(bare)) {
      bareConvId = bare;
    } else {
      const found = await conversations.findByUrn(target);
      bareConvId = found?.bareId ?? null;
    }
  } else {
    // Slug or URL — try resolving as symlink first
    let slug: string;
    try {
      slug = slugFromUrl(target);
    } catch {
      slug = target;
    }
    bareConvId = await conversations.resolveId(slug);
  }

  if (!bareConvId) {
    error(
      `Conversation "${target}" not found in local store. Run \`lilac sync\` to pull history.`,
      1
    );
    return;
  }

  const record = await conversations.read(bareConvId);
  if (!record) {
    error(`Conversation record not found for "${bareConvId}".`, 1);
    return;
  }

  const sinceMs = options.since ? new Date(options.since).getTime() : undefined;
  const messages = await conversations.readMessages(bareConvId, {
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

  const lines = messages.map((m) => {
    const time = relativeTime(m.timestamp);
    const sender = m.isFromMe ? "You" : (m.fromName || "Unknown");
    const prefix = m.isFromMe ? "→" : "←";
    const attachments = m.attachments.length > 0 ? ` [${m.attachments.map((a) => a.type).join(", ")}]` : "";
    const reactions = m.reactions.length > 0 ? ` ${m.reactions.map((r) => `${r.emoji}×${r.count}`).join(" ")}` : "";
    return `${prefix} ${sender.padEnd(20)} ${time.padEnd(12)} ${m.body}${attachments}${reactions}`;
  });

  process.stdout.write(`Conversation: ${record.title}\n\n`);
  process.stdout.write(lines.join("\n") + "\n");
}
