---
name: send-message
description: Send a LinkedIn message to a contact
user-invocable: true
disable-model-invocation: true
---

# Send LinkedIn Message

Send a message to a LinkedIn contact. Requires explicit user approval.

## Steps

1. **Find the contact** — search first if user provided a name instead of slug:
   ```bash
   bun run src/index.ts search "<name>" --json
   ```

2. **Confirm with the user** — show who you're about to message and the text. Wait for explicit approval before proceeding.

3. **Send the message**:
   ```bash
   bun run src/index.ts send "<slug>" "<message text>" --json
   ```

4. **Report the result** — show success or failure from the JSON output.

## Important

- NEVER send a message without explicit user approval for that specific send.
- The `send` command will also check for unread inbound messages and abort if there are newer inbound messages than your last outbound — this prevents accidentally ignoring someone's reply.
- Use the contact's slug (e.g., `alice-smith`) or profileId as the `<to>` argument.
