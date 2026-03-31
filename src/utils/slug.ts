/**
 * LinkedIn URL / slug utilities.
 *
 * A "slug" is the path segment from a LinkedIn profile URL, e.g.:
 *   https://www.linkedin.com/in/sarah-chen/ → "sarah-chen"
 *
 * Slugs are used as directory names in the file store:
 *   .lilac/contacts/sarah-chen/RECORD.json
 *   .lilac/conversations/sarah-chen/RECORD.json
 */

const LINKEDIN_PROFILE_PATTERN =
  /(?:https?:\/\/)?(?:www\.)?linkedin\.com\/in\/([a-zA-Z0-9_-]+)\/?/;

/**
 * Extract the profile slug from a LinkedIn profile URL or return the input
 * unchanged if it already looks like a slug (no URL characters).
 *
 * Throws if the input is a LinkedIn URL but does not match the /in/ pattern.
 */
export function slugFromUrl(input: string): string {
  // Already a slug (no slashes, no dots that suggest a domain)
  if (!input.includes("/") && !input.includes(".")) {
    return input.toLowerCase();
  }

  const match = input.match(LINKEDIN_PROFILE_PATTERN);
  if (!match || !match[1]) {
    throw new Error(
      `Could not extract a LinkedIn profile slug from: "${input}". ` +
        `Expected a URL like https://linkedin.com/in/sarah-chen or just "sarah-chen".`
    );
  }
  return match[1].toLowerCase();
}

/** Return true if the input looks like a LinkedIn profile URL. */
export function isLinkedInUrl(input: string): boolean {
  return LINKEDIN_PROFILE_PATTERN.test(input);
}

/** Build a full LinkedIn profile URL from a slug. */
export function urlFromSlug(slug: string): string {
  return `https://www.linkedin.com/in/${slug}/`;
}

/**
 * Sanitize a string for use as a filesystem directory name.
 * Lowercases, replaces spaces and slashes with dashes, strips other special chars.
 */
export function sanitizeSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[\s/\\]+/g, "-")
    .replace(/[^a-z0-9_-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Build a conversation slug:
 * - 1:1: use the contact's profile slug
 * - Group: sanitize the conversation title, prefix with "group-"
 */
export function conversationSlug(title: string, isGroup: boolean): string {
  const base = sanitizeSlug(title);
  return isGroup ? `group-${base}` : base;
}

/**
 * Extract a LinkedIn profile slug from a profile URL.
 * Returns null if the URL doesn't match.
 */
export function slugFromLinkedInUrl(url: string): string | null {
  const match = url.match(LINKEDIN_PROFILE_PATTERN);
  return match?.[1]?.toLowerCase() ?? null;
}
