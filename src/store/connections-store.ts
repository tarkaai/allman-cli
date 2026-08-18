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
import type { ProfileRaw as ProfileRawPayload } from "../linkedin/api/endpoints/profile-detail.js";
import type { SalesnavPosition, SalesnavSpotlight } from "../linkedin/api/endpoints/salesnav.js";
import { forceAlias } from "./alias.js";
import type { StoreGit } from "./git.js";

/** A single role in a connection's work history. */
export interface StoredPosition {
  title: string | null;
  company: string | null;
  /** True for the person's current role(s). */
  current: boolean;
  /** `urn:li:fsd_company:<id>` — stable company identity for joins/lookups. */
  companyUrn: string | null;
  /** `YYYY-MM` (or `YYYY` when LinkedIn omits the month). */
  startDate: string | null;
  /** `YYYY-MM`; null while the role is current. */
  endDate: string | null;
  location: string | null;
  description: string | null;
  /** `urn:li:fsd_profilePosition:(<profileId>,<posId>)` */
  positionUrn: string | null;
  /** `urn:li:fsd_employmentType:<id>` — self-employed/freelance identify solos. */
  employmentTypeUrn: string | null;
  /** `urn:li:fsd_geo:<id>` for the role's location. */
  geoUrn: string | null;
}

/** A single education entry. */
export interface StoredEducation {
  /** School name — often null; LinkedIn returns URNs rather than names here. */
  school: string | null;
  degree: string | null;
  fieldOfStudy: string | null;
  /** `urn:li:fsd_school:<id>` */
  schoolUrn: string | null;
  /** `urn:li:fsd_company:<id>` — the id `schoolFilter` searches match on. */
  companyUrn: string | null;
  /** `YYYY-MM` or `YYYY` — education dates are usually year-only. */
  startDate: string | null;
  endDate: string | null;
  activities: string | null;
  description: string | null;
  grade: string | null;
  degreeUrn: string | null;
  fieldOfStudyUrn: string | null;
  /** `urn:li:fsd_profileEducation:(<profileId>,<eduId>)` */
  educationUrn: string | null;
}

export interface StoredConnection {
  /** `urn:li:fsd_profile:<flagshipId>` */
  memberUrn: string;
  /** Flagship profile id (the `ACo…` filename key). */
  flagshipId: string;
  /**
   * `urn:li:member:<numericId>` — LinkedIn's `objectUrn`, the id Sales
   * Navigator keys on. Only the profile-detail fetch returns it, which is what
   * makes the flagship and SalesNav namespaces joinable at all. (Distinct from
   * `memberUrn` above, which is the `fsd_profile` URN.)
   */
  objectUrn?: string | null;
  /** The numeric member id alone. */
  memberId?: string | null;
  publicIdentifier: string | null;
  firstName?: string | null;
  lastName?: string | null;
  headline?: string | null;
  /** ISO timestamp the connection was made (if reported by LinkedIn). */
  connectedAt?: string | null;
  /**
   * How this record entered the store.
   *
   * `"connections"` — came from a `allman connections` sweep, so the person
   * really is a 1st-degree connection. `"enrich"` — created ad hoc by
   * `allman enrich <target>`, which can be pointed at anyone, connected or not.
   *
   * `connect`'s "already connected?" guard trusts only the former. Absent means
   * "connections" for backwards compatibility with records written before this
   * field existed.
   */
  source?: "connections" | "enrich";
  // --- Enrichment fields (populated by `allman enrich`) ---------------------
  /** Current role title (from the current/primary position). */
  title?: string | null;
  /** Current employer name. */
  company?: string | null;
  /** `urn:li:fsd_company:<id>` of the current employer. */
  companyUrn?: string | null;
  /** Human-readable location (e.g. "San Francisco Bay Area"). */
  location?: string | null;
  /** ISO-3166 alpha-2 country code. */
  country?: string | null;
  /** `urn:li:fsd_geo:<id>` — stable location identity, unlike the label. */
  geoUrn?: string | null;
  /** The profile's "About" summary. */
  about?: string | null;
  /** LinkedIn's standardized industry label, e.g. "Management Consulting". */
  industry?: string | null;
  /** `urn:li:fsd_industry:<id>` */
  industryUrn?: string | null;
  /** The profile's free-text website/address contact field — often a real URL. */
  address?: string | null;
  /** True when the member holds a Premium subscription. */
  premium?: boolean | null;
  /** True for a memorialized (deceased) member — exclude from outreach. */
  memorialized?: boolean | null;
  /** Standardized pronoun, e.g. "SHE_HER". */
  pronoun?: string | null;
  /** Largest profile photo URL. Signed and expiring — a cache, not a permalink. */
  profilePictureUrl?: string | null;
  /** Locale tag like "en_US". */
  primaryLocale?: string | null;
  /** Opaque edit stamp — differs from the stored value iff the profile changed. */
  versionTag?: string | null;
  /** Full work history — only populated by `enrich --deep`. */
  positions?: StoredPosition[] | null;
  /** Education history — only populated by `enrich --deep`. */
  education?: StoredEducation[] | null;
  /** Listed skills — only populated by `enrich --deep`. */
  skills?: string[] | null;
  /**
   * Untouched LinkedIn entity payloads, written only by `enrich --raw`.
   *
   * Opt-in on purpose: at ~8,900 connections an always-on raw copy would add
   * roughly a third of a gigabyte to a git-versioned store and rewrite all of
   * it on every re-enrichment pass. Turn it on for a sample when you suspect a
   * field is being dropped, not for the whole network.
   */
  raw?: ProfileRawPayload | null;
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
  | "objectUrn"
  | "memberId"
  | "firstName"
  | "lastName"
  | "headline"
  | "title"
  | "company"
  | "companyUrn"
  | "location"
  | "country"
  | "geoUrn"
  | "about"
  | "industry"
  | "industryUrn"
  | "address"
  | "premium"
  | "memorialized"
  | "pronoun"
  | "profilePictureUrl"
  | "primaryLocale"
  | "versionTag"
  | "positions"
  | "education"
  | "skills"
  | "raw"
>;

/**
 * A 1st-degree connection as seen through Sales Navigator.
 *
 * Kept in its own namespace (`connections-salesnav/`) rather than merged into
 * `connections/`: SalesNav identifies people by salesnav id + numeric member id
 * and never returns a flagship id or public slug, while the flagship
 * connections list returns no member id — so there is no key to join on. Merging
 * would mean two records for one person under different keys.
 */
export interface StoredSalesnavConnection {
  salesnavId: string;
  /** Numeric member id — the filename key. */
  memberId: string;
  memberUrn: string;
  firstName: string | null;
  lastName: string | null;
  fullName: string | null;
  location: string | null;
  degree: number | null;
  title: string | null;
  company: string | null;
  /** `urn:li:fs_salesCompany:<id>` of the current employer. */
  companyUrn: string | null;
  /** Standardized industry of the current employer — SalesNav-only data. */
  companyIndustry: string | null;
  /** Current employer's HQ location — SalesNav-only data. */
  companyLocation: string | null;
  about: string | null;
  pendingInvitation: boolean;
  premium: boolean;
  /** True when the member accepts InMail from outside their network. */
  openLink: boolean;
  memorialized: boolean;
  saved: boolean;
  viewed: boolean;
  profilePictureUrl: string | null;
  /** Every ongoing role, with employer industry and tenure folded in. */
  currentPositions: SalesnavPosition[];
  /** Work history SalesNav resolved for free — no per-profile fetch needed. */
  pastPositions: SalesnavPosition[];
  /** Search-hit badges: mutual connections, recent posts, job changes. */
  spotlights: SalesnavSpotlight[];
  firstSeenAt: string;
  lastSeenAt: string;
}

/**
 * A company resolved from a position's `companyUrn`.
 *
 * Lives in its own `companies/` namespace keyed by the numeric LinkedIn company
 * id, so many people can point at one record rather than each carrying a copy.
 * This is what makes employer facts (website, headcount band, industry)
 * available without guessing a domain from the company name.
 */
export interface StoredCompany {
  /** Numeric LinkedIn company id — the filename key. */
  id: string;
  companyUrn: string;
  name: string | null;
  universalName: string | null;
  /** The company's own website, straight from LinkedIn — not a guess. */
  website: string | null;
  linkedinUrl: string | null;
  tagline: string | null;
  description: string | null;
  industries: string[];
  staffCount: number | null;
  /** Banded headcount, e.g. `{ start: 2, end: 10 }`. */
  staffCountRange: { start: number | null; end: number | null } | null;
  companyType: string | null;
  foundedYear: number | null;
  specialties: string[];
  headquarters: {
    city: string | null;
    country: string | null;
    line1: string | null;
    postalCode: string | null;
    headquarters: boolean;
  } | null;
  followerCount: number | null;
  /** Signed CDN URL — expires; treat as a cache, not a permalink. */
  logoUrl: string | null;
  /** LinkedIn machine-generated stub page: weak evidence about the firm. */
  autoGenerated: boolean;
  fetchedAt: string;
  firstSeenAt: string;
  lastSeenAt: string;
}

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
  // The SalesNav backend returns decorated hits, so these come free with the
  // search. The flagship backend leaves them null.
  firstName?: string | null;
  lastName?: string | null;
  fullName?: string | null;
  headline?: string | null;
  location?: string | null;
  /** Network distance; 2 for a 2nd-degree result. */
  degree?: number | null;
  title?: string | null;
  company?: string | null;
  companyUrn?: string | null;
  companyIndustry?: string | null;
  profilePictureUrl?: string | null;
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

  private companiesDir(): string {
    return join(this.accountDir, "companies");
  }

  /** Every company id already resolved into the store. */
  async listCompanyIds(): Promise<string[]> {
    try {
      const names = await readdir(this.companiesDir());
      return names.filter((n) => n.endsWith(".json")).map((n) => n.slice(0, -5));
    } catch {
      return [];
    }
  }

  async readCompany(id: string): Promise<StoredCompany | null> {
    return readJson<StoredCompany>(join(this.companiesDir(), `${id}.json`));
  }

  /**
   * Upsert one company record (+ `{universalName} -> {id}.json` symlink).
   *
   * Merges like `upsertConnection` — a later fetch never downgrades a known
   * value to null — so a partial response can't erase good data.
   */
  async upsertCompany(c: Omit<StoredCompany, "firstSeenAt" | "lastSeenAt">): Promise<void> {
    const dir = this.companiesDir();
    await mkdir(dir, { recursive: true });
    const nowIso = new Date().toISOString();
    const file = `${c.id}.json`;
    const path = join(dir, file);
    const prev = await this.readCompany(c.id);
    const merged = { ...(prev ?? {}) } as Record<string, unknown>;
    for (const [k, v] of Object.entries(c)) {
      if (v !== undefined && v !== null) merged[k] = v;
    }
    merged.firstSeenAt = prev?.firstSeenAt ?? nowIso;
    merged.lastSeenAt = nowIso;
    await writeFile(path, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
    if (c.universalName) await forceAlias(dir, c.universalName, file);
  }

  /**
   * Upsert one 1st-degree connection record + slug symlink.
   *
   * Merges onto the existing record rather than replacing it. This matters: a
   * `connections` sweep only carries identity (ids, name, headline), so a plain
   * overwrite silently threw away every enrichment field — title, company,
   * about, positions, education, skills — on the next sweep. Re-running
   * `connections` after a long `enrich` pass used to undo the whole thing.
   *
   * Like `enrichConnection`, a writer never downgrades a known value to null;
   * it can only add or replace with something real. `firstSeenAt` is preserved.
   */
  async upsertConnection(
    c: Omit<StoredConnection, "firstSeenAt" | "lastSeenAt">,
    nowIso: string
  ): Promise<void> {
    const dir = this.connectionsDir();
    await mkdir(dir, { recursive: true });
    const file = `${c.flagshipId}.json`;
    const path = join(dir, file);
    const prev = await this.readConnection(c.flagshipId);
    const merged = { ...(prev ?? {}) } as Record<string, unknown>;
    for (const [k, v] of Object.entries(c)) {
      if (v !== undefined && v !== null) merged[k] = v;
    }
    // A confirmed connection never gets downgraded to "enrich" by a later
    // ad-hoc enrichment of the same person.
    merged.source =
      prev && (prev.source ?? "connections") === "connections" ? "connections" : c.source;
    merged.firstSeenAt = prev?.firstSeenAt ?? nowIso;
    merged.lastSeenAt = nowIso;
    await writeFile(path, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
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
   * Whether this person is a known 1st-degree connection.
   *
   * Accepts a flagship id or a slug (slugs resolve through the symlink). Only
   * as complete as the last `allman connections` run — a false here means
   * "not known locally", not "definitely not connected".
   */
  async hasConnection(idOrSlug: string): Promise<boolean> {
    for (const name of [`${idOrSlug}.json`, idOrSlug]) {
      // Slug symlinks are stored without the .json suffix; both resolve to the
      // same record, so read whichever exists.
      try {
        const raw = await readFile(join(this.connectionsDir(), name), "utf8");
        const rec = JSON.parse(raw) as StoredConnection;
        // Records created ad hoc by `enrich <target>` prove nothing about the
        // relationship — only a `connections` sweep does.
        return (rec.source ?? "connections") === "connections";
      } catch {
        // try the next name
      }
    }
    return false;
  }

  private salesnavDir(): string {
    return join(this.accountDir, "connections-salesnav");
  }

  /**
   * Upsert one SalesNav-sourced connection, keyed by numeric member id.
   * Idempotent: preserves `firstSeenAt`, refreshes `lastSeenAt`.
   */
  async upsertSalesnavConnection(
    c: Omit<StoredSalesnavConnection, "firstSeenAt" | "lastSeenAt">,
    nowIso: string
  ): Promise<void> {
    const dir = this.salesnavDir();
    await mkdir(dir, { recursive: true });
    const key = c.memberId || c.salesnavId;
    const path = join(dir, `${key}.json`);
    const firstSeenAt = (await readFirstSeen(path)) ?? nowIso;
    const rec: StoredSalesnavConnection = { ...c, firstSeenAt, lastSeenAt: nowIso };
    await writeFile(path, `${JSON.stringify(rec, null, 2)}\n`, "utf8");
  }

  /** Read a previously recorded invitation by invitee id (null if none). */
  async readInvitation(inviteeId: string): Promise<StoredInvitation | null> {
    try {
      const raw = await readFile(join(this.accountDir, "invitations", `${inviteeId}.json`), "utf8");
      return JSON.parse(raw) as StoredInvitation;
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

  /**
   * Upsert one connections-of result record (+ slug symlink when present).
   *
   * Merged, not replaced: the two backends return disjoint halves of the same
   * person (flagship has the slug, SalesNav has name/role/employer), so a
   * re-run on the other backend would otherwise null out what the first found.
   */
  async upsertConnectionOfResult(
    targetKey: string,
    r: Omit<StoredConnectionOfResult, "firstSeenAt" | "lastSeenAt">,
    nowIso: string
  ): Promise<void> {
    const dir = join(this.connectionsOfRoot(), targetKey);
    await mkdir(dir, { recursive: true });
    const file = `${resultKey(r)}.json`;
    const path = join(dir, file);
    const prev = await readJson<StoredConnectionOfResult>(path);
    const merged = { ...(prev ?? {}) } as Record<string, unknown>;
    for (const [k, v] of Object.entries(r)) {
      if (v !== undefined && v !== null) merged[k] = v;
    }
    merged.firstSeenAt = prev?.firstSeenAt ?? nowIso;
    merged.lastSeenAt = nowIso;
    await writeFile(path, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
    if (r.publicIdentifier) await forceAlias(dir, r.publicIdentifier, file);
  }

  /** The directory key for a connections-of search (the target's flagship id). */
  static targetKeyFromUrn(targetUrn: string): string {
    return targetUrn.replace(/^urn:li:fsd_profile:/, "");
  }
}

async function readFirstSeen(path: string): Promise<string | null> {
  return (await readJson<{ firstSeenAt?: string }>(path))?.firstSeenAt ?? null;
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}
