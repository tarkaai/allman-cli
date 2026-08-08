/**
 * Full-profile fetch — turns a bare connection (id + name) into a real profile:
 * current title, company, location, "About", and (in deep mode) full work
 * history, education, and skills.
 *
 * Uses the flagship REST identity graph, which needs no Sales Navigator seat:
 *
 *   GET /voyager/api/identity/dash/profiles
 *       ?q=memberIdentity&memberIdentity=<slug|profileId>
 *       &decorationId=com.linkedin.voyager.dash.deco.identity.profile.FullProfile-<N>
 *
 * The `memberIdentity` router accepts either a public slug or a flagship
 * profile id, so callers can enrich connections that never exposed a slug.
 *
 * The decoration version (`-76`) rotates with LinkedIn deploys; override it
 * with ALLMAN_PROFILE_DECORATION if LinkedIn starts 400ing. The parser reads
 * the normalized `included[]` graph by `$type` and takes whatever fields are
 * present, so a decoration change degrades to fewer fields rather than an error.
 *
 * Reference field shape: monorepo `ContactData` / `Position`
 *   (fullName, headline, location, summary, positions[title, companyName, current]).
 */
import type { LinkedInApiClient } from "../client.js";

const REST_URL = "https://www.linkedin.com/voyager/api/identity/dash/profiles";

/** Richest no-seat decoration. Overridable via env for deploy-rotation resilience. */
export const PROFILE_DETAIL_DECORATION =
  process.env.ALLMAN_PROFILE_DECORATION ??
  "com.linkedin.voyager.dash.deco.identity.profile.FullProfile-76";

export interface ProfilePosition {
  title: string | null;
  company: string | null;
  /** True for a role with no end date (a current role). */
  current: boolean;
}

export interface ProfileEducation {
  school: string | null;
  degree: string | null;
}

export interface ProfileDetail {
  /** `urn:li:fsd_profile:<id>` */
  urn: string;
  publicIdentifier: string | null;
  firstName: string | null;
  lastName: string | null;
  headline: string | null;
  location: string | null;
  /** The profile's "About" summary. */
  about: string | null;
  /** Current role title (from the current, else first, position). */
  title: string | null;
  /** Current employer name. */
  company: string | null;
  /** Full work history (deep mode). Empty array in core mode. */
  positions: ProfilePosition[];
  /** Education history (deep mode). Empty array in core mode. */
  education: ProfileEducation[];
  /** Listed skills (deep mode). Empty array in core mode. */
  skills: string[];
}

interface RawProfileResponse {
  included?: Array<Record<string, unknown>>;
}

/**
 * Fetch a full profile by public slug or flagship profile id.
 * Returns null if the profile isn't found or the response has no profile record.
 */
export async function fetchProfileDetail(
  client: LinkedInApiClient,
  identity: string,
  opts: { deep?: boolean } = {}
): Promise<ProfileDetail | null> {
  const params = new URLSearchParams({
    q: "memberIdentity",
    memberIdentity: identity,
    decorationId: PROFILE_DETAIL_DECORATION,
  });
  const url = `${REST_URL}?${params.toString()}`;
  const resp = await client.request<RawProfileResponse>({ method: "GET", url });
  return parseProfileDetail(resp, { deep: opts.deep === true });
}

/**
 * Parse a normalized identity/dash/profiles response into a ProfileDetail.
 * Pure function — exposed for unit testing.
 */
export function parseProfileDetail(
  resp: RawProfileResponse,
  opts: { deep?: boolean } = {}
): ProfileDetail | null {
  const included = resp.included ?? [];
  const profile = included.find((i) => matchesType(i, /\.profile\.Profile$/));
  if (!profile) return null;

  const urnRaw = str(profile.entityUrn);
  const urn = urnRaw ? normalizeProfileUrn(urnRaw) : "";

  const positions = included
    .filter((i) => matchesType(i, /\.profile\.Position$/))
    .map(parsePosition);
  // Current title/company: prefer a current role, fall back to the first listed.
  const primary = positions.find((p) => p.current) ?? positions[0] ?? null;

  const detail: ProfileDetail = {
    urn,
    publicIdentifier: lowerStr(profile.publicIdentifier),
    firstName: text(profile.firstName),
    lastName: text(profile.lastName),
    headline: text(profile.headline),
    location: resolveLocation(profile, included),
    about: text(profile.summary),
    title: primary?.title ?? null,
    company: primary?.company ?? null,
    positions: opts.deep ? positions : [],
    education: opts.deep
      ? included
          .filter((i) => matchesType(i, /\.profile\.Education$/))
          .map((e) => ({ school: text(e.schoolName), degree: text(e.degreeName) }))
      : [],
    skills: opts.deep
      ? included
          .filter((i) => matchesType(i, /\.profile\.Skill$/))
          .map((s) => text(s.name))
          .filter((n): n is string => n !== null)
      : [],
  };
  return detail;
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

function parsePosition(p: Record<string, unknown>): ProfilePosition {
  // "Current" = an ongoing role. LinkedIn signals this either with an explicit
  // flag or, more commonly, a dateRange whose `end` is absent.
  const dateRange = p.dateRange as { end?: unknown } | undefined;
  const explicit = typeof p.current === "boolean" ? (p.current as boolean) : null;
  const current = explicit ?? (dateRange !== undefined && dateRange.end == null);
  return {
    title: text(p.title),
    company: text(p.companyName),
    current,
  };
}

/** Try several shapes LinkedIn uses to express location. */
function resolveLocation(
  profile: Record<string, unknown>,
  included: Array<Record<string, unknown>>
): string | null {
  // Direct string on the profile (common with lighter decorations).
  const direct = str(profile.geoLocationName) ?? str(profile.locationName);
  if (direct) return direct;
  // Nested: profile.location.basicLocation.postalCode/etc, or a defaultLocalizedName.
  const loc = profile.location as Record<string, unknown> | undefined;
  const nested = loc ? str(loc.defaultLocalizedName) : undefined;
  if (nested) return nested;
  // Resolve a *geo / *geoLocation reference into the included graph.
  const geoRef = str(profile["*geoLocation"]) ?? str(profile["*geo"]) ?? str(profile["*location"]);
  if (geoRef) {
    const geo = included.find((i) => i.entityUrn === geoRef);
    const name = geo
      ? (str(geo.defaultLocalizedName) ?? str(geo.localizedName) ?? str(geo.name))
      : undefined;
    if (name) return name;
  }
  // Last resort: any Geo record in the graph.
  const anyGeo = included.find((i) => matchesType(i, /\.(Geo|GeoLocation)$/));
  return anyGeo ? (str(anyGeo.defaultLocalizedName) ?? str(anyGeo.name) ?? null) : null;
}

function matchesType(item: Record<string, unknown>, re: RegExp): boolean {
  return typeof item.$type === "string" && re.test(item.$type);
}

/** A LinkedIn text-ish field is either a plain string or `{ text: string }`. */
function text(v: unknown): string | null {
  if (typeof v === "string") return v.length > 0 ? v : null;
  if (v && typeof v === "object") {
    const t = (v as { text?: unknown }).text;
    if (typeof t === "string" && t.length > 0) return t;
  }
  return null;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function lowerStr(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v.toLowerCase() : null;
}

/** Extract `urn:li:fsd_profile:<id>` from an entityUrn that may be composite. */
function normalizeProfileUrn(value: string): string {
  const m = value.match(/urn:li:fsd_profile:([^,)]+)/);
  return m?.[1] ? `urn:li:fsd_profile:${m[1]}` : value;
}
