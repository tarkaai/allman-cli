/**
 * Connection storage — the git-versioned, symlinked record of a network export.
 *
 * Layout (per account):
 *   {profileId}/connections/
 *     {flagshipId}.json            ← one record per 1st-degree connection
 *     {slug} -> {flagshipId}.json  ← symlink by public identifier (when known)
 *   {profileId}/connections-of/
 *     {targetKey}/
 *       RECORD.json                ← the search: target, backend, total, timestamps
 *       {resultKey}.json           ← one record per result
 *       {slug} -> {resultKey}.json ← symlink by slug (flagship backend has slugs)
 *     {targetSlug} -> {targetKey}  ← symlink to the search dir by the target's slug
 *
 * Upserts are idempotent: re-running an export updates `lastSeenAt` while
 * preserving the original `firstSeenAt`, so git history shows when each
 * connection first appeared and was last confirmed.
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { forceAlias } from "./alias.js";
import type { StoreGit } from "./git.js";

/** A single role in a connection's work history. */
export interface StoredPosition {
  title: string | null;
  company: string | null;
  /** True for the person's current role(s). */
  current: boolean;
}

/** A single education entry. */
export interface StoredEducation {
  school: string | null;
  degree: string | null;
}

export interface StoredConnection {
  /** `urn:li:fsd_profile:<flagshipId>` */
  memberUrn: string;
  /** Flagship profile id (the `ACo…` filename key). */
  flagshipId: string;
  publicIdentifier: string | null;
  firstName?: string | null;
  lastName?: string | null;
  headline?: string | null;
  /** ISO timestamp the connection was made (if reported by LinkedIn). */
  connectedAt?: string | null;
  // --- Enrichment fields (populated by `allman enrich`) ---------------------
  /** Current role title (from the current/primary position). */
  title?: string | null;
  /** Current employer name. */
  company?: string | null;
  /** Human-readable location (e.g. "San Francisco Bay Area"). */
  location?: string | null;
  /** The profile's "About" summary. */
  about?: string | null;
  /** Full work history — only populated by `enrich --deep`. */
  positions?: StoredPosition[] | null;
  /** Education history — only populated by `enrich --deep`. */
  education?: StoredEducation[] | null;
  /** Listed skills — only populated by `enrich --deep`. */
  skills?: string[] | null;
  /** ISO timestamp of the last successful enrichment (null if never enriched). */
  enrichedAt?: string | null;
  /** Depth of the last enrichment. */
  enrichDepth?: "core" | "deep" | null;
  firstSeenAt: string;
  lastSeenAt: string;
}

/** The enrichable subset of a connection record — everything `enrich` may fill in. */
export type ConnectionEnrichment = Pick<
  StoredConnection,
  | "firstName"
  | "lastName"
  | "headline"
  | "title"
  | "company"
  | "location"
  | "about"
  | "positions"
  | "education"
  | "skills"
>;

/** A connection invitation we sent (via `allman connect`). */
export interface StoredInvitation {
  /** Invitee flagship profile id (the filename key). */
  inviteeId: string;
  /** `urn:li:fsd_profile:<inviteeId>` */
  inviteeUrn: string;
  publicIdentifier: string | null;
  /** The custom note sent with the invite, if any. */
  note: string | null;
  /** `urn:li:fsd_invitation:<id>` returned by LinkedIn on success. */
  invitationUrn: string;
  sentAt: string;
}

export interface ConnectionOfTargetMeta {
  /** Input the user passed (slug). */
  targetSlug: string | null;
  /** `urn:li:fsd_profile:<id>` of the target. */
  targetUrn: string;
  /** Which backend produced these results. */
  backend: "salesnav" | "flagship";
  /** Server-reported total (may exceed what we fetched). */
  total: number | null;
  fetched: number;
  capturedAt: string;
}

export interface StoredConnectionOfResult {
  salesnavId: string | null;
  /** Numeric member id (from `urn:li:member:N`). */
  memberId: string | null;
  memberUrn: string | null;
  publicIdentifier: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
}

/** Filesystem-safe key for a result row (prefer the numeric member id). */
function resultKey(r: {
  memberId: string | null;
  salesnavId: string | null;
  memberUrn: string | null;
}): string {
  if (r.memberId) return r.memberId;
  if (r.salesnavId) return r.salesnavId;
  if (r.memberUrn) return r.memberUrn.split(":").pop() ?? "unknown";
  return "unknown";
}

export class ConnectionsStore {
  constructor(
    private readonly accountDir: string,
    readonly git: StoreGit
  ) {}

  private connectionsDir(): string {
    return join(this.accountDir, "connections");
  }

  private connectionsOfRoot(): string {
    return join(this.accountDir, "connections-of");
  }

  /**
   * Upsert one 1st-degree connection record + slug symlink.
   * Preserves the existing `firstSeenAt` if the record already exists.
   */
  async upsertConnection(
    c: Omit<StoredConnection, "firstSeenAt" | "lastSeenAt">,
    nowIso: string
  ): Promise<void> {
    const dir = this.connectionsDir();
    await mkdir(dir, { recursive: true });
    const file = `${c.flagshipId}.json`;
    const path = join(dir, file);
    const firstSeenAt = (await readFirstSeen(path)) ?? nowIso;
    const rec: StoredConnection = { ...c, firstSeenAt, lastSeenAt: nowIso };
    await writeFile(path, `${JSON.stringify(rec, null, 2)}\n`, "utf8");
    if (c.publicIdentifier) await forceAlias(dir, c.publicIdentifier, file);
  }

  /**
   * List the flagship ids of every stored 1st-degree connection.
   * Reads the real record files (`{flagshipId}.json`) and skips the slug
   * symlinks (which have no `.json` suffix).
   */
  async listConnectionIds(): Promise<string[]> {
    const dir = this.connectionsDir();
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      return entries
        .filter((e) => e.isFile() && e.name.endsWith(".json"))
        .map((e) => e.name.slice(0, -".json".length));
    } catch {
      return [];
    }
  }

  /** Read one stored connection record by flagship id (null if absent). */
  async readConnection(flagshipId: string): Promise<StoredConnection | null> {
    try {
      const raw = await readFile(join(this.connectionsDir(), `${flagshipId}.json`), "utf8");
      return JSON.parse(raw) as StoredConnection;
    } catch {
      return null;
    }
  }

  /**
   * Merge enrichment data onto an existing connection record and stamp
   * `enrichedAt` / `enrichDepth`. Preserves `firstSeenAt`; refreshes
   * `lastSeenAt`. No-ops (returns false) if the record doesn't exist.
   */
  async enrichConnection(
    flagshipId: string,
    patch: ConnectionEnrichment,
    depth: "core" | "deep",
    nowIso: string
  ): Promise<boolean> {
    const existing = await this.readConnection(flagshipId);
    if (!existing) return false;
    // Only overwrite fields the enrichment actually resolved; keep prior values
    // (e.g. don't wipe deep fields when re-running a core enrich).
    const merged = { ...existing } as StoredConnection & Record<string, unknown>;
    for (const [k, v] of Object.entries(patch)) {
      if (v !== undefined && v !== null) merged[k] = v;
    }
    merged.enrichedAt = nowIso;
    merged.enrichDepth = depth;
    merged.lastSeenAt = nowIso;
    const path = join(this.connectionsDir(), `${flagshipId}.json`);
    await writeFile(path, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
    return true;
  }

  /** Record a sent connection invitation (+ slug symlink when known). */
  async recordInvitation(inv: StoredInvitation): Promise<void> {
    const dir = join(this.accountDir, "invitations");
    await mkdir(dir, { recursive: true });
    const file = `${inv.inviteeId}.json`;
    await writeFile(join(dir, file), `${JSON.stringify(inv, null, 2)}\n`, "utf8");
    if (inv.publicIdentifier) await forceAlias(dir, inv.publicIdentifier, file);
  }

  /** Write the connections-of search metadata + the by-target-slug symlink. */
  async writeConnectionOfTarget(targetKey: string, meta: ConnectionOfTargetMeta): Promise<void> {
    const dir = join(this.connectionsOfRoot(), targetKey);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "RECORD.json"), `${JSON.stringify(meta, null, 2)}\n`, "utf8");
    if (meta.targetSlug) await forceAlias(this.connectionsOfRoot(), meta.targetSlug, targetKey);
  }

  /** Upsert one connections-of result record (+ slug symlink when present). */
  async upsertConnectionOfResult(
    targetKey: string,
    r: Omit<StoredConnectionOfResult, "firstSeenAt" | "lastSeenAt">,
    nowIso: string
  ): Promise<void> {
    const dir = join(this.connectionsOfRoot(), targetKey);
    await mkdir(dir, { recursive: true });
    const file = `${resultKey(r)}.json`;
    const path = join(dir, file);
    const firstSeenAt = (await readFirstSeen(path)) ?? nowIso;
    const rec: StoredConnectionOfResult = { ...r, firstSeenAt, lastSeenAt: nowIso };
    await writeFile(path, `${JSON.stringify(rec, null, 2)}\n`, "utf8");
    if (r.publicIdentifier) await forceAlias(dir, r.publicIdentifier, file);
  }

  /** The directory key for a connections-of search (the target's flagship id). */
  static targetKeyFromUrn(targetUrn: string): string {
    return targetUrn.replace(/^urn:li:fsd_profile:/, "");
  }
}

async function readFirstSeen(path: string): Promise<string | null> {
  try {
    const prev = JSON.parse(await readFile(path, "utf8")) as { firstSeenAt?: string };
    return prev.firstSeenAt ?? null;
  } catch {
    return null;
  }
}
