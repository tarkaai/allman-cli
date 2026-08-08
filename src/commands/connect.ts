/**
 * `allman connect` — send a LinkedIn connection request, optionally with a note.
 *
 *   allman connect <slug|url|urn>                  send a bare connection request
 *   allman connect <slug> --note "Hi — ..."        include a personalized note
 *   allman connect <slug> --note "..." --dry-run    preview without sending
 *
 * Conservative by design (see RESPONSIBLE_USE.md — allman is not a spam tool):
 *   - Pre-checks the relationship and refuses to re-invite people you're already
 *     connected to or have a pending invite with.
 *   - Caps the note at LinkedIn's 300-char limit.
 *   - Rate-limits invitations on their own slow throttle (default 1/min),
 *     persisted across runs.
 */

import { LinkedInError } from "../linkedin/api/client.js";
import { MAX_NOTE_LENGTH, sendConnectionRequest } from "../linkedin/api/endpoints/invitations.js";
import { getProfileUrnBySlug } from "../linkedin/api/endpoints/profiles.js";
import { getMemberRelationship } from "../linkedin/api/endpoints/relationships.js";
import { loadSession } from "../linkedin/api/session.js";
import { resolveStorePath, Store } from "../store/index.js";
import * as output from "../utils/output.js";
import { buildRateLimiter } from "../utils/rate-limiter.js";
import { slugFromUrl } from "../utils/slug.js";
import { isUrn, profileUrnId } from "../utils/urn.js";

/** Default minimum interval between invitations (ms). Deliberately slow. */
const DEFAULT_INVITE_INTERVAL_MS = 60_000;

export interface ConnectOptions {
  account?: string;
  store?: string;
  json?: boolean;
  note?: string;
  /** Show what would be sent without sending. */
  dryRun?: boolean;
}

export async function connectCommand(target: string, opts: ConnectOptions): Promise<void> {
  const note = opts.note?.trim() ?? "";
  if (note.length > MAX_NOTE_LENGTH) {
    output.error(
      `Note is ${note.length} chars — LinkedIn caps connection notes at ${MAX_NOTE_LENGTH}. Shorten it and retry.`,
      1
    );
    return;
  }

  const storePath = resolveStorePath(opts.store);
  const store = new Store({ path: storePath });
  await store.init();

  let session: Awaited<ReturnType<typeof loadSession>>;
  try {
    session = await loadSession(store, opts.account);
  } catch (err) {
    output.error(String((err as Error).message), 1);
    return;
  }
  const { apiClient, profileId } = session;

  // Resolve the target to a profile URN.
  let profileUrn: string;
  let slug: string | null = null;
  if (isUrn(target) && target.includes("fsd_profile")) {
    profileUrn = target;
  } else {
    try {
      slug = slugFromUrl(target);
    } catch {
      output.error(
        `Cannot resolve "${target}". Use a LinkedIn URL, profile slug, or profile URN.`,
        1
      );
      return;
    }
    output.info(`Looking up "${slug}" on LinkedIn…`);
    const urn = await getProfileUrnBySlug(apiClient, slug);
    if (!urn) {
      output.error(`Profile "${slug}" not found on LinkedIn.`, 1);
      return;
    }
    profileUrn = urn;
  }

  // Pre-check the relationship — don't re-invite existing/pending connections.
  try {
    const rel = await getMemberRelationship(apiClient, profileUrn);
    if (rel.kind === "connection") {
      output.success(`Already connected to ${slug ?? profileUrn}. Nothing to do.`);
      return;
    }
    if (rel.kind === "invitation") {
      output.success(`An invitation with ${slug ?? profileUrn} is already pending. Nothing to do.`);
      return;
    }
  } catch {
    // Relationship pre-check is best-effort; proceed if it fails.
    output.warn("Could not verify relationship state — proceeding.");
  }

  if (opts.dryRun) {
    output.info(`[dry-run] Would send a connection request to ${slug ?? profileUrn}.`);
    if (note) output.info(`[dry-run] Note (${note.length}/${MAX_NOTE_LENGTH}): ${note}`);
    else output.info("[dry-run] No note.");
    return;
  }

  // Invitation rate limit (its own slow throttle, persisted across runs).
  const config = await store.accounts.readConfig(profileId);
  const rateState = await store.accounts.readRateState(profileId);
  const limiter = buildRateLimiter({
    minIntervalMs: config.rateLimit?.minInviteIntervalMs ?? DEFAULT_INVITE_INTERVAL_MS,
    initialLastSendAt: rateState?.lastInviteSentAt,
  });
  await limiter.acquire();
  await store.accounts.writeRateState(profileId, {
    lastMessageSentAt: rateState?.lastMessageSentAt ?? 0,
    lastInviteSentAt: Date.now(),
  });

  // Send.
  let invitationUrn: string;
  try {
    const res = await sendConnectionRequest(apiClient, profileUrn, note || undefined);
    invitationUrn = res.invitationUrn;
  } catch (err) {
    output.error(inviteErrorMessage(err), 1);
    return;
  }

  // Record the sent invitation for provenance.
  const inviteeId = profileUrnId(profileUrn);
  await store.connectionsFor(profileId).recordInvitation({
    inviteeId,
    inviteeUrn: profileUrn.startsWith("urn:li:fsd_profile:")
      ? profileUrn
      : `urn:li:fsd_profile:${inviteeId}`,
    publicIdentifier: slug,
    note: note || null,
    invitationUrn,
    sentAt: new Date().toISOString(),
  });
  store.connectionsFor(profileId).git.scheduleCommit(`connect: invite ${slug ?? inviteeId}`);
  await store.git.flush();

  if (opts.json) {
    output.printData({ invitationUrn, inviteeUrn: profileUrn, note: note || null });
  } else {
    output.success(
      `Connection request sent to ${slug ?? profileUrn}${note ? " (with note)" : ""}.`
    );
  }
}

/** Map invitation failures to actionable messages (403 usually = quota). */
function inviteErrorMessage(err: unknown): string {
  if (err instanceof LinkedInError) {
    if (err.statusCode === 403) {
      return (
        "LinkedIn refused the connection request (403). This usually means you've hit an " +
        "invitation limit — free accounts cap invitations with a note (~5/month) and have " +
        "weekly invite caps. Try again later or send without a note."
      );
    }
    return err.message;
  }
  return `Connection request failed: ${String(err)}`;
}
