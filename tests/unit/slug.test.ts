import { describe, it, expect } from "vitest";
import {
  slugFromUrl,
  isLinkedInUrl,
  urlFromSlug,
  sanitizeSlug,
  conversationSlug,
} from "@/utils/slug.js";

describe("slugFromUrl", () => {
  it("extracts slug from a full LinkedIn URL", () => {
    expect(slugFromUrl("https://www.linkedin.com/in/sarah-chen/")).toBe("sarah-chen");
    expect(slugFromUrl("https://linkedin.com/in/john-doe")).toBe("john-doe");
    expect(slugFromUrl("http://www.linkedin.com/in/Jane-Smith/")).toBe("jane-smith");
  });

  it("passes through a plain slug unchanged", () => {
    expect(slugFromUrl("sarah-chen")).toBe("sarah-chen");
    expect(slugFromUrl("john123")).toBe("john123");
  });

  it("lowercases the result", () => {
    expect(slugFromUrl("Sarah-Chen")).toBe("sarah-chen");
  });

  it("throws for a non-LinkedIn URL", () => {
    expect(() => slugFromUrl("https://twitter.com/sarah")).toThrow(
      "Could not extract a LinkedIn profile slug"
    );
  });
});

describe("isLinkedInUrl", () => {
  it("returns true for LinkedIn URLs", () => {
    expect(isLinkedInUrl("https://www.linkedin.com/in/sarah-chen/")).toBe(true);
    expect(isLinkedInUrl("linkedin.com/in/john")).toBe(true);
  });

  it("returns false for non-LinkedIn strings", () => {
    expect(isLinkedInUrl("sarah-chen")).toBe(false);
    expect(isLinkedInUrl("https://twitter.com/sarah")).toBe(false);
  });
});

describe("urlFromSlug", () => {
  it("builds a full LinkedIn profile URL", () => {
    expect(urlFromSlug("sarah-chen")).toBe("https://www.linkedin.com/in/sarah-chen/");
  });
});

describe("sanitizeSlug", () => {
  it("lowercases and removes special chars", () => {
    expect(sanitizeSlug("Sarah Chen")).toBe("sarah-chen");
    expect(sanitizeSlug("John O'Brien")).toBe("john-obrien");
    expect(sanitizeSlug("  spaces  ")).toBe("spaces");
  });

  it("collapses multiple dashes", () => {
    expect(sanitizeSlug("a--b---c")).toBe("a-b-c");
  });

  it("trims leading/trailing dashes", () => {
    expect(sanitizeSlug("-test-")).toBe("test");
  });
});

describe("conversationSlug", () => {
  it("returns the slug for a 1:1 conversation", () => {
    expect(conversationSlug("Sarah Chen", false)).toBe("sarah-chen");
  });

  it("prefixes group conversations with group-", () => {
    expect(conversationSlug("Engineering Team", true)).toBe("group-engineering-team");
  });
});
