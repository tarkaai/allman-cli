---
name: read-conversation
description: Read message history for a LinkedIn conversation
user-invocable: true
---

# Read Conversation

View message history for a LinkedIn conversation.

## Steps

1. **Find the contact** if needed:
   ```bash
   bun run src/index.ts search "<name>" --json
   ```

2. **Read messages**:
   ```bash
   bun run src/index.ts messages "<slug>" --json --limit <N>
   ```
   Default limit is 50. Use `--since YYYY-MM-DD` to filter by date.

3. **Format the thread** — present messages chronologically with:
   - Sender name
   - Timestamp (human-readable)
   - Message text

## Arguments

- `<slug>` — LinkedIn slug, profileId, or convId
- `--limit N` — max messages to show (default: 50)
- `--since YYYY-MM-DD` — only show messages after this date
