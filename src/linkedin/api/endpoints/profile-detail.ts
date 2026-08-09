/**
 * Full-profile fetch — turns a bare connection (id + name) into a real profile:
 * current title, company, location, "About", and (in deep mode) full work
 * history, education, and skills.
 *
 * LinkedIn splits this across several flagship REST resources; none need a
 * Sales Navigator seat, and none is a profile-page scrape:
 *
 *   core       GET /voyager/api/identity/dash/profiles
 *                  ?q=memberIdentity&memberIdentity=<slug|profileId>
 *                  &decorationId=…identity.profile.FullProfile-<N>
 *   positions  GET /voyager/api/identity/dash/profilePositions?q=viewee&profileUrn=<urn>
 *   education  GET /voyager/api/identity/dash/profileEducations?q=viewee&profileUrn=<urn>
 *   skills     GET /voyager/api/identity/dash/profileSkills?q=viewee&profileUrn=<urn>
 *
 * The core resource carries name/headline/location/about but **no** positions,
 * education, or skills — verified against live responses — so title/company
 * always require the positions call. Core mode therefore costs 2 requests;
 * `deep` costs 4. The sub-resources take no decorationId, which keeps them
 * immune to LinkedIn's decoration-version rotation.
 *
 * (The legacy `identity/profiles/{slug}/profileView` aggregate that used to
 * return all of this in one shot now returns HTTP 410 Gone.)
 *
 * The core decoration version rotates with LinkedIn deploys; override it with
 * ALLMAN_PROFILE_DECORATION. Parsers read the normalized `included[]` graph by
 * `$type` and take whatever fields are present, so a shape change degrades to
 * fewer fields rather than an error.
 */
import type { LinkedInApiClient } from "../client.js";

const DASH = "https://www.linkedin.com/voyager/api/identity/dash";

/** Richest no-seat core decoration. Overridable via env for rotation resilience. */
export const PROFILE_DETAIL_DECORATION =
  process.env.ALLMAN_PROFILE_DECORATION ??
  "com.linkedin.voyager.dash.deco.identity.profile.FullProfile-76";

export interface ProfilePosition {
  title: string | null;
  company: string | null;
  /** True for a role with no end date (an ongoing role). */
  current: boolean;
}

export interface ProfileEducation {
  school: string | null;
  degree: string | null;
}

/** The fields carried by the core `profiles` resource. */
export interface ProfileCore {
  /** `urn:li:fsd_profile:<id>` */
  urn: string;
  publicIdentifier: string | null;
  firstName: string | null;
  lastName: string | null;
  headline: string | null;
  location: string | null;
  /** The profile's "About" summary. */
  about: string | null;
}

export interface ProfileDetail extends ProfileCore {
  /** Current role title (from the current, else most recent, position). */
  title: string | null;
  /** Current employer name. */
  company: string | null;
  /** Work history. Always fetched (it is the source of title/company). */
  positions: ProfilePosition[];
  /** Education history — deep mode only; empty otherwise. */
  education: ProfileEducation[];
  /** Listed skills — deep mode only; empty otherwise. */
  skills: string[];
}

interface RawResponse {
  data?: { ["*elements"]?: string[] };
  included?: Array<Record<string, unknown>>;
}

/**
 * Fetch a full profile by public slug or flagship profile id.
 * Returns null if the profile isn't found or carries no core record.
 */
export async function fetchProfileDetail(
  client: LinkedInApiClient,
  identity: string,
  opts: { deep?: boolean } = {}
): Promise<ProfileDetail | null> {
  const coreParams = new URLSearchParams({
    q: "memberIdentity",
    memberIdentity: identity,
    decorationId: PROFILE_DETAIL_DECORATION,
  });
  const coreResp = await client.request<RawResponse>({
    method: "GET",
    url: `${DASH}/profiles?${coreParams.toString()}`,
  });
  const core = parseProfileCore(coreResp);
  if (!core) return null;

  // Positions live on their own resource and are required for title/company.
  const positions = await fetchSub(client, "profilePositions", core.urn, parsePositions, []);
  const primary = pickPrimaryPosition(positions);

  const education = opts.deep
    ? await fetchSub(client, "profileEducations", core.urn, parseEducations, [])
    : [];
  const skills = opts.deep
    ? await fetchSub(client, "profileSkills", core.urn, parseSkills, [])
    : [];

  return {
    ...core,
    title: primary?.title ?? null,
    company: primary?.company ?? null,
    positions,
    education,
    skills,
  };
}

/**
 * GET one `?q=viewee` sub-resource and parse it. A failure here degrades the
 * profile (fewer fields) rather than failing the whole enrichment — a private
 * or empty section is normal, not an error.
 */
async function fetchSub<T>(
  client: LinkedInApiClient,
  resource: string,
  profileUrn: string,
  parse: (resp: RawResponse) => T,
  fallback: T
): Promise<T> {
  try {
    const resp = await client.request<RawResponse>({
      method: "GET",
      url: `${DASH}/${resource}?q=viewee&profileUrn=${encodeURIComponent(profileUrn)}`,
    });
    return parse(resp);
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Parsers (pure — exposed for unit testing)
// ---------------------------------------------------------------------------

/** Parse the core `identity/dash/profiles` response. */
export function parseProfileCore(resp: RawResponse): ProfileCore | null {
  const included = resp.included ?? [];
  const profile = included.find((i) => matchesType(i, /\.profile\.Profile$/));
  if (!profile) return null;

  const urnRaw = str(profile.entityUrn);
  return {
    urn: urnRaw ? normalizeProfileUrn(urnRaw) : "",
    publicIdentifier: lowerStr(profile.publicIdentifier),
    firstName: text(profile.firstName),
    lastName: text(profile.lastName),
    headline: text(profile.headline),
    location: resolveLocation(profile, included),
    about: text(profile.summary),
  };
}

/** Parse a `profilePositions` response into work history, in LinkedIn's display order. */
export function parsePositions(resp: RawResponse): ProfilePosition[] {
  return orderedByType(resp, /\.profile\.Position$/).map((p) => {
    // "Current" = an ongoing role: LinkedIn either sets an explicit flag or,
    // far more commonly, omits `dateRange.end`.
    const dateRange = p.dateRange as { end?: unknown } | undefined;
    const explicit = typeof p.current === "boolean" ? p.current : null;
    return {
      title: text(p.title),
      company: text(p.companyName),
      current: explicit ?? (dateRange != null && dateRange.end == null),
    };
  });
}

/** Parse a `profileEducations` response, in display order. */
export function parseEducations(resp: RawResponse): ProfileEducation[] {
  return orderedByType(resp, /\.profile\.Education$/).map((e) => ({
    school: text(e.schoolName),
    degree: text(e.degreeName),
  }));
}

/** Parse a `profileSkills` response, in display order. */
export function parseSkills(resp: RawResponse): string[] {
  return orderedByType(resp, /\.profile\.Skill$/)
    .map((s) => text(s.name))
    .filter((n): n is string => n !== null);
}

/**
 * Return the `included` records of a given type in LinkedIn's **display order**.
 *
 * `included[]` itself is unordered — resolving `data["*elements"]` is what
 * recovers the order the profile actually renders in. This matters: a person
 * with several concurrent roles (say CTO at one company and venture partner at
 * another) only reports the right "current" one if we respect that order.
 * Falls back to raw `included` order when the refs are absent.
 */
function orderedByType(resp: RawResponse, re: RegExp): Array<Record<string, unknown>> {
  const included = resp.included ?? [];
  const refs = resp.data?.["*elements"];
  if (!Array.isArray(refs) || refs.length === 0) {
    return included.filter((i) => matchesType(i, re));
  }
  const byUrn = new Map<string, Record<string, unknown>>();
  for (const i of included) {
    const u = i.entityUrn;
    if (typeof u === "string") byUrn.set(u, i);
  }
  const ordered = refs
    .map((ref) => byUrn.get(ref))
    .filter((i): i is Record<string, unknown> => i !== undefined && matchesType(i, re));
  // If nothing resolved (unexpected ref shape), don't silently return nothing.
  return ordered.length > 0 ? ordered : included.filter((i) => matchesType(i, re));
}

/**
 * The position that represents "what they do now": an ongoing role if there is
 * one, else the first listed (LinkedIn returns positions most-recent-first).
 */
export function pickPrimaryPosition(positions: ProfilePosition[]): ProfilePosition | null {
  return positions.find((p) => p.current) ?? positions[0] ?? null;
}

// ---------------------------------------------------------------------------
// Field helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the member's location.
 *
 * The live shape is `profile.geoLocation = { "*geo": "urn:li:fsd_geo:<id>" }`,
 * resolved against `included`. We must NOT fall back to "any Geo in the graph":
 * the graph also carries a country-level Geo, so that fallback silently
 * downgrades "Austin, Texas Metropolitan Area" to "United States".
 */
function resolveLocation(
  profile: Record<string, unknown>,
  included: Array<Record<string, unknown>>
): string | null {
  // Plain string forms, when a lighter decoration supplies them.
  const direct = str(profile.geoLocationName) ?? str(profile.locationName);
  if (direct) return direct;

  // Nested reference: geoLocation["*geo"] (current shape), or a direct ref.
  const geoLocation = profile.geoLocation as Record<string, unknown> | undefined;
  const geoRef =
    (geoLocation ? str(geoLocation["*geo"]) : undefined) ??
    str(profile["*geoLocation"]) ??
    str(profile["*geo"]);
  if (geoRef) {
    const geo = included.find((i) => i.entityUrn === geoRef);
    const name = geo
      ? (str(geo.defaultLocalizedName) ?? str(geo.localizedName) ?? str(geo.name))
      : undefined;
    if (name) return name;
  }

  // Localized name hung directly off `location`, when present.
  const loc = profile.location as Record<string, unknown> | undefined;
  return loc ? (str(loc.defaultLocalizedName) ?? null) : null;
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
