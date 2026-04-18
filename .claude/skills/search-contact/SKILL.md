---
name: search-contact
description: Find LinkedIn contacts by name, slug, or profile ID
user-invocable: true
---

# Search LinkedIn Contacts

Find contacts in the allman store using fuzzy search.

## Steps

1. Run the search:
   ```bash
   bun run src/index.ts search "<query>" --json
   ```

2. Parse the JSON output. Each result includes:
   - `name` — full name
   - `slug` — LinkedIn public identifier (for URLs)
   - `profileId` — LinkedIn profile ID
   - `convId` — conversation directory ID
   - `confidence` — match score (0-100)

3. Present results to the user in a readable format.

## Scoring tiers

- **100**: exact slug or profileId match
- **95**: exact name (case-insensitive)
- **80**: name starts with query
- **70**: all query words match word-starts in name ("ali smi" → "Alice Smith")
- **60**: name/slug contains query as substring
- **40**: any query word found in name/slug
