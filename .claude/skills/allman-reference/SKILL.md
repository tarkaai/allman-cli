---
name: allman-reference
description: Reference guide for allman store layout, URNs, and event shapes
user-invocable: false
---

# Allman Reference

## Store Layout

```
.allman/
├── {myProfileId}/                    # one dir per logged-in account
│   ├── AUTH.json                     # profile info, auth status (committed)
│   ├── COOKIES.json                  # cookie jar (gitignored)
│   ├── config.json                   # proxy, rate limits (committed)
│   ├── rate-state.json               # last send timestamp (gitignored)
│   ├── INBOX.jsonl                   # inbound message notifications (gitignored)
│   │
│   ├── {convId}/                     # one dir per conversation
│   │   ├── RECORD.json              # contact + conversation data
│   │   └── messages/YYYY-MM.jsonl   # message history
│   │
│   ├── {profileId} -> {convId}      # symlink: profile ID → conversation
│   └── {slug} -> {convId}           # symlink: LinkedIn slug → conversation
│
└── {accountSlug} -> {myProfileId}   # symlink: account name → profile dir
```

## Key URN Formats

- Profile: `urn:li:fsd_profile:{profileId}`
- Conversation (frontend): `urn:li:msg_conversation:{convId}`
- Conversation (backend): `urn:li:messagingThread:{threadId}`
- Message: `urn:li:fsd_message:(urn:li:msg_conversation:{convId},{messageId})`
- Member: `urn:li:member:{numericId}`

## Three Canonical IDs (per conversation)

1. `convId` — directory name (starts with `2-`)
2. `profileId` — contact's LinkedIn profile ID (starts with `ACo`)
3. `slug` — real LinkedIn `publicIdentifier` (e.g., `alice-smith`), or null if unresolved

## SSE Event Shape (listen)

```json
{
  "type": "MESSAGE_RECEIVED",
  "conversationUrn": "urn:li:msg_conversation:...",
  "from": "Alice Smith",
  "fromProfileId": "ACoAAB...",
  "text": "message content",
  "timestamp": 1711800000000
}
```

## Message Shape (stored JSONL)

```json
{
  "urn": "urn:li:fsd_message:(...)",
  "text": "message content",
  "timestamp": 1711800000000,
  "sender": "urn:li:fsd_profile:ACoAAB...",
  "direction": "inbound",
  "deliveredAt": "2024-03-30T12:00:00.000Z"
}
```
