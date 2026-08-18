import { describe, expect, it } from "vitest";
import type { LinkedInApiClient } from "../../src/linkedin/api/client.js";
import {
  companyId,
  fetchCompany,
  parseCompany,
  parseUniversalNameLookup,
} from "../../src/linkedin/api/endpoints/companies.js";

describe("companyId", () => {
  it("extracts the numeric id from an fsd_company urn", () => {
    expect(companyId("urn:li:fsd_company:99112930")).toBe("99112930");
  });

  it("accepts a bare numeric id", () => {
    expect(companyId("11850")).toBe("11850");
  });

  it("returns null for anything without an id", () => {
    // A vanity slug is not an id; `fetchCompany` resolves those over the wire.
    expect(companyId("etymonai")).toBeNull();
    expect(companyId("")).toBeNull();
  });
});

describe("parseUniversalNameLookup", () => {
  it("reads the id out of a flat elements[] response", () => {
    const resp = { elements: [{ entityUrn: "urn:li:fs_normalized_company:11850" }] };
    expect(parseUniversalNameLookup(resp)).toBe("11850");
  });

  it("reads the id out of a normalized data.elements[] response", () => {
    const resp = { data: { elements: [{ entityUrn: "urn:li:company:99112930" }] } };
    expect(parseUniversalNameLookup(resp)).toBe("99112930");
  });

  it("falls back to included[], ignoring non-company entities", () => {
    const resp = {
      data: {},
      included: [{ entityUrn: "urn:li:fsd_industry:96" }, { entityUrn: "urn:li:fsd_company:42" }],
    };
    expect(parseUniversalNameLookup(resp)).toBe("42");
  });

  it("returns null when nothing in the response names a company", () => {
    expect(parseUniversalNameLookup({})).toBeNull();
    expect(parseUniversalNameLookup({ elements: [] })).toBeNull();
    expect(
      parseUniversalNameLookup({ elements: [{ entityUrn: "urn:li:fsd_industry:96" }] })
    ).toBeNull();
  });
});

describe("fetchCompany", () => {
  /** Records every URL requested so we can assert how many round trips happen. */
  function stubClient(handler: (url: string) => unknown): {
    client: LinkedInApiClient;
    urls: string[];
  } {
    const urls: string[] = [];
    const client = {
      request: async ({ url }: { url: string }) => {
        urls.push(url);
        return handler(url);
      },
    } as unknown as LinkedInApiClient;
    return { client, urls };
  }

  const byId = { data: { name: "Marketbridge", universalName: "marketbridge" } };

  it("fetches a numeric id directly, with no lookup round trip", async () => {
    const { client, urls } = stubClient(() => byId);
    const c = await fetchCompany(client, "11850");
    expect(c?.id).toBe("11850");
    expect(urls).toEqual(["https://www.linkedin.com/voyager/api/organization/companies/11850"]);
  });

  it("resolves a vanity slug through the universalName query first", async () => {
    const { client, urls } = stubClient((url) =>
      url.includes("q=universalName")
        ? { elements: [{ entityUrn: "urn:li:fs_normalized_company:11850" }] }
        : byId
    );
    const c = await fetchCompany(client, "marketbridge");
    expect(c?.id).toBe("11850");
    expect(c?.name).toBe("Marketbridge");
    expect(urls).toEqual([
      "https://www.linkedin.com/voyager/api/organization/companies?q=universalName&universalName=marketbridge",
      "https://www.linkedin.com/voyager/api/organization/companies/11850",
    ]);
  });

  it("lower-cases the slug the user typed", async () => {
    const { client, urls } = stubClient((url) =>
      url.includes("q=universalName") ? { elements: [{ entityUrn: "urn:li:company:7" }] } : byId
    );
    await fetchCompany(client, " MarketBridge ");
    expect(urls[0]).toContain("universalName=marketbridge");
  });

  it("returns null without a second request when the slug resolves to nothing", async () => {
    const { client, urls } = stubClient(() => ({ elements: [] }));
    expect(await fetchCompany(client, "no-such-company")).toBeNull();
    expect(urls).toHaveLength(1);
  });

  it("returns null rather than throwing when the lookup fails", async () => {
    const { client } = stubClient(() => {
      throw new Error("403");
    });
    expect(await fetchCompany(client, "marketbridge")).toBeNull();
  });

  it("never requests anything for a target that cannot be a slug", async () => {
    const { client, urls } = stubClient(() => byId);
    expect(await fetchCompany(client, "Not A Slug!")).toBeNull();
    expect(urls).toEqual([]);
  });
});

describe("parseCompany", () => {
  // Shaped after a real /organization/companies/<id> response.
  const resp = {
    data: {
      name: "Marketbridge",
      universalName: "marketbridge",
      companyPageUrl: "https://marketbridge.com",
      url: "https://www.linkedin.com/company/marketbridge",
      tagline: "Go-to-Market systems",
      description: "Marketbridge partners with B2B leaders.",
      staffCount: 375,
      staffCountRange: { start: 201, end: 500 },
      companyType: { localizedName: "Privately Held", code: "PRIVATELY_HELD" },
      foundedOn: { year: 1991 },
      specialities: ["ABM/ABX", "Advertising"],
      autoGenerated: false,
      headquarter: {
        city: "Bethesda",
        country: "US",
        line1: "3 Bethesda Metro Center",
        postalCode: "20814",
      },
      logos: {
        logo: {
          artifacts: [
            { width: 100, fileIdentifyingUrlPathSegment: "small.png" },
            { width: 400, fileIdentifyingUrlPathSegment: "large.png" },
          ],
        },
      },
    },
    included: [
      { $type: "com.linkedin.voyager.common.Industry", localizedName: "Advertising Services" },
      { $type: "com.linkedin.voyager.common.FollowingInfo", followerCount: 22580 },
    ],
  };

  it("prefers the company's own site over the LinkedIn page", () => {
    const c = parseCompany(resp, "11850");
    expect(c?.website).toBe("https://marketbridge.com");
    expect(c?.linkedinUrl).toBe("https://www.linkedin.com/company/marketbridge");
  });

  it("captures headcount, both exact and banded", () => {
    const c = parseCompany(resp, "11850");
    expect(c?.staffCount).toBe(375);
    expect(c?.staffCountRange).toEqual({ start: 201, end: 500 });
  });

  it("pulls industry and follower count out of included[]", () => {
    const c = parseCompany(resp, "11850");
    expect(c?.industries).toEqual(["Advertising Services"]);
    expect(c?.followerCount).toBe(22580);
  });

  it("captures type, founding year, specialties and headquarters", () => {
    const c = parseCompany(resp, "11850");
    expect(c?.companyType).toBe("Privately Held");
    expect(c?.foundedYear).toBe(1991);
    expect(c?.specialties).toEqual(["ABM/ABX", "Advertising"]);
    expect(c?.headquarters?.city).toBe("Bethesda");
    expect(c?.headquarters?.headquarters).toBe(true);
  });

  it("picks the largest logo artifact", () => {
    expect(parseCompany(resp, "11850")?.logoUrl).toContain("large.png");
  });

  it("sets the urn from the id and keeps them consistent", () => {
    const c = parseCompany(resp, "11850");
    expect(c?.id).toBe("11850");
    expect(c?.companyUrn).toBe("urn:li:fsd_company:11850");
  });

  it("degrades to nulls rather than throwing on a sparse response", () => {
    const c = parseCompany({ data: { name: "Tiny Co" } }, "1");
    expect(c?.name).toBe("Tiny Co");
    expect(c?.website).toBeNull();
    expect(c?.staffCountRange).toBeNull();
    expect(c?.industries).toEqual([]);
    expect(c?.headquarters).toBeNull();
  });

  it("returns null when the response carries no company", () => {
    expect(parseCompany({}, "1")).toBeNull();
    expect(parseCompany({ data: {} }, "1")).toBeNull();
  });
});
