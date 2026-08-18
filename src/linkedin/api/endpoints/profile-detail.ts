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
  /** `urn:li:fsd_company:<id>` — canonical company identity, unlike the name. */
  companyUrn: string | null;
  /** `YYYY-MM` (or `YYYY` when LinkedIn omits the month). */
  startDate: string | null;
  /** `YYYY-MM`; null for a current role. */
  endDate: string | null;
  location: string | null;
  /** Free-text role description, when the member wrote one. */
  description: string | null;
  /** `urn:li:fsd_profilePosition:(<profileId>,<posId>)` — stable per-role id. */
  positionUrn: string | null;
  /**
   * `urn:li:fsd_employmentType:<id>` — full-time / part-time / self-employed /
   * freelance / contract / internship. LinkedIn does not send the label on this
   * resource, so we keep the id; "self-employed" and "freelance" are the ones
   * that identify a solo operator.
   */
  employmentTypeUrn: string | null;
  /** `urn:li:fsd_geo:<id>` for the role's location. */
  geoUrn: string | null;
}

export interface ProfileEducation {
  /**
   * School name. Often null: the `profileEducations` resource returns URNs
   * rather than names, so `schoolUrn`/`companyUrn` are the reliable identity.
   */
  school: string | null;
  degree: string | null;
  fieldOfStudy: string | null;
  /** `urn:li:fsd_school:<id>` */
  schoolUrn: string | null;
  /** `urn:li:fsd_company:<id>` — schools are also companies; this is the id
   *  people-search's `schoolFilter` matches on. */
  companyUrn: string | null;
  /** `YYYY-MM` or `YYYY` — education dates are usually year-only. */
  startDate: string | null;
  endDate: string | null;
  /** Clubs, societies, sports — free text. */
  activities: string | null;
  description: string | null;
  grade: string | null;
  /** `urn:li:fsd_degree:<id>` */
  degreeUrn: string | null;
  /** `urn:li:fsd_fieldOfStudy:<id>` */
  fieldOfStudyUrn: string | null;
  /** `urn:li:fsd_profileEducation:(<profileId>,<eduId>)` */
  educationUrn: string | null;
}

/** The fields carried by the core `profiles` resource. */
export interface ProfileCore {
  /** `urn:li:fsd_profile:<id>` */
  urn: string;
  /**
   * `urn:li:member:<numericId>` — LinkedIn's own `objectUrn` field.
   *
   * This is the one identifier both LinkedIn backends agree on: Sales Navigator
   * hits carry it as `objectUrn` while the flagship connections list does not,
   * so capturing it here is what makes flagship <-> SalesNav records joinable.
   */
  objectUrn: string | null;
  /** The numeric member id alone. */
  memberId: string | null;
  publicIdentifier: string | null;
  firstName: string | null;
  lastName: string | null;
  headline: string | null;
  location: string | null;
  /** ISO-3166 alpha-2 country code (from `location.countryCode`). */
  country: string | null;
  /** `urn:li:fsd_geo:<id>` — stable location identity, unlike the label. */
  geoUrn: string | null;
  /** The profile's "About" summary. */
  about: string | null;
  /** LinkedIn's standardized industry label, e.g. "Management Consulting". */
  industry: string | null;
  /** `urn:li:fsd_industry:<id>` */
  industryUrn: string | null;
  /**
   * The profile's free-text "website / address" contact field. In practice
   * members put a booking link or a site URL here, so it is often the only
   * first-party URL on the profile.
   */
  address: string | null;
  /** True when the member holds a Premium subscription. */
  premium: boolean;
  /** True for a memorialized (deceased) member — never contact these. */
  memorialized: boolean;
  /** Standardized pronoun, e.g. "SHE_HER". Null when unset or custom. */
  pronoun: string | null;
  /** Largest available profile photo URL, or null when there is no photo. */
  profilePictureUrl: string | null;
  /** Locale tag like "en_US" — the language the profile is authored in. */
  primaryLocale: string | null;
  /**
   * Opaque stamp LinkedIn bumps when the member edits their profile. Comparing
   * it against the stored value tells you whether a re-fetch would change
   * anything, without diffing every field.
   */
  versionTag: string | null;
}

/**
 * The untouched entity payloads behind a ProfileDetail, kept only when the
 * caller asks for them (`{ raw: true }`). Opt-in because they are ~10x the size
 * of the parsed record — see `ConnectionsStore` for the storage trade-off.
 */
export interface ProfileRaw {
  profile: Record<string, unknown> | null;
  positions: Array<Record<string, unknown>>;
  educations: Array<Record<string, unknown>>;
  skills: Array<Record<string, unknown>>;
}

export interface ProfileDetail extends ProfileCore {
  /** Current role title (from the current, else most recent, position). */
  title: string | null;
  /** Current employer name. */
  company: string | null;
  /** `urn:li:fsd_company:<id>` of the current employer. */
  companyUrn: string | null;
  /** Work history. Always fetched (it is the source of title/company). */
  positions: ProfilePosition[];
  /** Education history — deep mode only; empty otherwise. */
  education: ProfileEducation[];
  /** Listed skills — deep mode only; empty otherwise. */
  skills: string[];
  /** Untouched payloads — present only when fetched with `{ raw: true }`. */
  raw?: ProfileRaw;
}

interface RawResponse {
  data?: { ["*elements"]?: string[] };
  included?: Array<Record<string, unknown>>;
}

/**
 * Page size for the `?q=viewee` sub-resources.
 *
 * LinkedIn defaults these collections to 20 and silently truncates — a member
 * with 50 listed skills returned only the first 20 (`paging.total` gave the lie
 * away). 100 covers every real profile: LinkedIn caps skills at 50, and
 * positions/educations never approach it.
 */
const SUB_RESOURCE_COUNT = 100;

/**
 * Fetch a full profile by public slug or flagship profile id.
 * Returns null if the profile isn't found or carries no core record.
 */
export async function fetchProfileDetail(
  client: LinkedInApiClient,
  identity: string,
  opts: { deep?: boolean; raw?: boolean } = {}
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
  const positionsResp = await fetchSub(client, "profilePositions", core.urn);
  const positions = parsePositions(positionsResp);
  const primary = pickPrimaryPosition(positions);

  const educationResp = opts.deep ? await fetchSub(client, "profileEducations", core.urn) : {};
  const skillsResp = opts.deep ? await fetchSub(client, "profileSkills", core.urn) : {};

  const detail: ProfileDetail = {
    ...core,
    title: primary?.title ?? null,
    company: primary?.company ?? null,
    companyUrn: primary?.companyUrn ?? null,
    positions,
    education: parseEducations(educationResp),
    skills: parseSkills(skillsResp),
  };

  if (opts.raw) {
    detail.raw = {
      profile: pruneRaw(
        (coreResp.included ?? []).find((i) => matchesType(i, /\.profile\.Profile$/)) ?? null
      ),
      positions: orderedByType(positionsResp, /\.profile\.Position$/).map(
        (p) => pruneRaw(p) as Record<string, unknown>
      ),
      educations: orderedByType(educationResp, /\.profile\.Education$/).map(
        (e) => pruneRaw(e) as Record<string, unknown>
      ),
      skills: orderedByType(skillsResp, /\.profile\.Skill$/).map(
        (k) => pruneRaw(k) as Record<string, unknown>
      ),
    };
  }

  return detail;
}

/**
 * GET one `?q=viewee` sub-resource. A failure here degrades the profile (fewer
 * fields) rather than failing the whole enrichment — a private or empty section
 * is normal, not an error.
 */
async function fetchSub(
  client: LinkedInApiClient,
  resource: string,
  profileUrn: string
): Promise<RawResponse> {
  try {
    return await client.request<RawResponse>({
      method: "GET",
      url:
        `${DASH}/${resource}?q=viewee&profileUrn=${encodeURIComponent(profileUrn)}` +
        `&count=${SUB_RESOURCE_COUNT}`,
    });
  } catch {
    return {};
  }
}

/**
 * Strip the parts of a raw entity that carry no information: `$recipeTypes`
 * (decoration bookkeeping) and the `multiLocale*` mirrors, which repeat a field
 * we already have once per supported locale. Roughly halves the stored bytes.
 *
 * `$type` is deliberately kept, so a stored payload stays self-describing and
 * can be fed straight back through these parsers.
 */
export function pruneRaw<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => pruneRaw(v)) as unknown as T;
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k === "$recipeTypes" || k.startsWith("multiLocale")) continue;
    out[k] = pruneRaw(v);
  }
  return out as unknown as T;
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
  const objectUrn = str(profile.objectUrn) ?? null;
  const geo = resolveGeo(profile, included);
  const location = profile.location as Record<string, unknown> | undefined;

  return {
    urn: urnRaw ? normalizeProfileUrn(urnRaw) : "",
    objectUrn,
    memberId: objectUrn ? (/urn:li:member:(\d+)/.exec(objectUrn)?.[1] ?? null) : null,
    publicIdentifier: lowerStr(profile.publicIdentifier),
    firstName: text(profile.firstName),
    lastName: text(profile.lastName),
    headline: text(profile.headline),
    location: geo.name,
    country: str(location?.countryCode) ?? null,
    geoUrn: geo.urn,
    about: text(profile.summary),
    industry: resolveIndustry(profile, included),
    industryUrn: str(profile.industryUrn) ?? str(profile["*industry"]) ?? null,
    address: text(profile.address),
    premium: profile.premium === true,
    memorialized: profile.memorialized === true,
    pronoun: resolvePronoun(profile.pronounUnion),
    profilePictureUrl: bestImageUrl(profile.profilePicture),
    primaryLocale: localeTag(profile.primaryLocale),
    versionTag: str(profile.versionTag) ?? null,
  };
}

/** `{month, year}` -> `YYYY-MM`, or `YYYY` when the month is absent. */
function ymd(d: unknown): string | null {
  const o = d as { month?: unknown; year?: unknown } | null | undefined;
  const y = typeof o?.year === "number" ? o.year : null;
  if (y == null) return null;
  const m = typeof o?.month === "number" ? o.month : null;
  return m == null ? String(y) : `${y}-${String(m).padStart(2, "0")}`;
}

/** Parse a `profilePositions` response into work history, in LinkedIn's display order. */
export function parsePositions(resp: RawResponse): ProfilePosition[] {
  return orderedByType(resp, /\.profile\.Position$/).map((p) => {
    // "Current" = an ongoing role: LinkedIn either sets an explicit flag or,
    // far more commonly, omits `dateRange.end`.
    const dateRange = p.dateRange as { start?: unknown; end?: unknown } | undefined;
    const explicit = typeof p.current === "boolean" ? p.current : null;
    return {
      title: text(p.title),
      company: text(p.companyName),
      current: explicit ?? (dateRange != null && dateRange.end == null),
      companyUrn: str(p.companyUrn) ?? null,
      startDate: ymd(dateRange?.start),
      endDate: ymd(dateRange?.end),
      location: text(p.locationName) ?? text(p.geoLocationName),
      description: text(p.description),
      positionUrn: str(p.entityUrn) ?? null,
      employmentTypeUrn: str(p.employmentTypeUrn) ?? null,
      geoUrn: str(p.geoUrn) ?? null,
    };
  });
}

/** Parse a `profileEducations` response, in display order. */
export function parseEducations(resp: RawResponse): ProfileEducation[] {
  return orderedByType(resp, /\.profile\.Education$/).map((e) => {
    const dateRange = e.dateRange as { start?: unknown; end?: unknown } | undefined;
    return {
      school: text(e.schoolName),
      degree: text(e.degreeName),
      fieldOfStudy: text(e.fieldOfStudy),
      schoolUrn: str(e.schoolUrn) ?? null,
      companyUrn: str(e.companyUrn) ?? null,
      startDate: ymd(dateRange?.start),
      endDate: ymd(dateRange?.end),
      activities: text(e.activities),
      description: text(e.description),
      grade: text(e.grade),
      degreeUrn: str(e.degreeUrn) ?? null,
      fieldOfStudyUrn: str(e.fieldOfStudyUrn) ?? str(e.standardizedFieldOfStudyUrn) ?? null,
      educationUrn: str(e.entityUrn) ?? null,
    };
  });
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
 * Resolve the member's location label and the `fsd_geo` URN behind it.
 *
 * The live shape is `profile.geoLocation = { "*geo": "urn:li:fsd_geo:<id>" }`,
 * resolved against `included`. We must NOT fall back to "any Geo in the graph":
 * the graph also carries a country-level Geo, so that fallback silently
 * downgrades "Austin, Texas Metropolitan Area" to "United States".
 */
function resolveGeo(
  profile: Record<string, unknown>,
  included: Array<Record<string, unknown>>
): { name: string | null; urn: string | null } {
  // Nested reference: geoLocation["*geo"] (current shape), or a direct ref.
  const geoLocation = profile.geoLocation as Record<string, unknown> | undefined;
  const geoRef =
    (geoLocation ? (str(geoLocation["*geo"]) ?? str(geoLocation.geoUrn)) : undefined) ??
    str(profile["*geoLocation"]) ??
    str(profile["*geo"]);

  // Plain string forms, when a lighter decoration supplies them.
  const direct = str(profile.geoLocationName) ?? str(profile.locationName);
  if (direct) return { name: direct, urn: geoRef ?? null };

  if (geoRef) {
    const geo = included.find((i) => i.entityUrn === geoRef);
    const name = geo
      ? (str(geo.defaultLocalizedName) ?? str(geo.localizedName) ?? str(geo.name))
      : undefined;
    if (name) return { name, urn: geoRef };
  }

  // Localized name hung directly off `location`, when present.
  const loc = profile.location as Record<string, unknown> | undefined;
  return { name: loc ? (str(loc.defaultLocalizedName) ?? null) : null, urn: geoRef ?? null };
}

/**
 * Resolve the member's standardized industry label.
 *
 * `profile["*industry"]` (or `industryUrn`) points at a `common.Industry`
 * entity in the same `included[]` graph that carries the human name — the
 * profile record itself only carries the URN.
 */
function resolveIndustry(
  profile: Record<string, unknown>,
  included: Array<Record<string, unknown>>
): string | null {
  const ref = str(profile["*industry"]) ?? str(profile.industryUrn) ?? str(profile.industryV2Urn);
  if (!ref) return null;
  const hit = included.find((i) => i.entityUrn === ref && matchesType(i, /\.common\.Industry$/));
  return hit ? (str(hit.name) ?? null) : null;
}

/** `pronounUnion` is a tagged union; we only keep the standardized member. */
function resolvePronoun(v: unknown): string | null {
  if (!v || typeof v !== "object") return null;
  return str((v as { standardizedPronoun?: unknown }).standardizedPronoun) ?? null;
}

/** `{ language, country }` -> `en_US`. */
function localeTag(v: unknown): string | null {
  if (!v || typeof v !== "object") return null;
  const l = v as { language?: unknown; country?: unknown };
  const lang = str(l.language);
  if (!lang) return null;
  const country = str(l.country);
  return country ? `${lang}_${country}` : lang;
}

/**
 * Compose the highest-resolution URL out of a LinkedIn VectorImage.
 *
 * The image is split into a `rootUrl` prefix plus per-size
 * `fileIdentifyingUrlPathSegment` suffixes; neither half is a usable URL alone.
 * The segments carry a signed expiry, so a stored URL eventually 403s — it is a
 * cache, not a permalink.
 */
export function bestImageUrl(picture: unknown): string | null {
  if (!picture || typeof picture !== "object") return null;
  const p = picture as Record<string, unknown>;
  const vector = ((p.displayImageReference as Record<string, unknown> | undefined)?.vectorImage ??
    p.vectorImage ??
    p) as Record<string, unknown> | undefined;
  const rootUrl = str(vector?.rootUrl);
  const artifacts = vector?.artifacts;
  if (!rootUrl || !Array.isArray(artifacts) || artifacts.length === 0) return null;
  let best: { width: number; seg: string } | null = null;
  for (const a of artifacts as Array<Record<string, unknown>>) {
    const seg = str(a.fileIdentifyingUrlPathSegment);
    if (!seg) continue;
    const width = typeof a.width === "number" ? a.width : 0;
    if (!best || width > best.width) best = { width, seg };
  }
  return best ? `${rootUrl}${best.seg}` : null;
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
