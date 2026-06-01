import { describe, expect, it } from "vitest";
import { csvEscape, csvLines, csvRow } from "../../src/utils/csv.js";

describe("csvEscape", () => {
  it("passes through plain values", () => {
    expect(csvEscape("hello")).toBe("hello");
    expect(csvEscape(123)).toBe("123");
    expect(csvEscape(true)).toBe("true");
  });
  it("empty string for null/undefined", () => {
    expect(csvEscape(null)).toBe("");
    expect(csvEscape(undefined)).toBe("");
  });
  it("quotes values containing comma", () => {
    expect(csvEscape("a,b")).toBe('"a,b"');
  });
  it("quotes values containing newline", () => {
    expect(csvEscape("a\nb")).toBe('"a\nb"');
    expect(csvEscape("a\r\nb")).toBe('"a\r\nb"');
  });
  it("quotes and doubles internal double-quotes", () => {
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
  });
});

describe("csvRow / csvLines", () => {
  it("joins fields with commas", () => {
    expect(csvRow(["a", "b", "c"])).toBe("a,b,c");
  });
  it("CRLF between rows", () => {
    expect(
      csvLines([
        ["a", "b"],
        ["c", "d"],
      ])
    ).toBe("a,b\r\nc,d");
  });
});
