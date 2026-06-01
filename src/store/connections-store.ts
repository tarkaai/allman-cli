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
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { forceAlias } from "./alias.js";
import type { StoreGit } from "./git.js";

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
  firstSeenAt: string;
  lastSeenAt: string;
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
