import { describe, expect, it } from "vitest";
import { DEFAULT_PAGE_DELAY, pickDelayMs } from "../../src/utils/random-delay.js";

describe("pickDelayMs", () => {
  it("returns a value within the configured range", () => {
    for (let i = 0; i < 100; i++) {
      const ms = pickDelayMs({ minMs: 2000, maxMs: 8000 });
      expect(ms).toBeGreaterThanOrEqual(2000);
      expect(ms).toBeLessThanOrEqual(8000);
    }
  });
  it("defaults to 2000–8000", () => {
    expect(DEFAULT_PAGE_DELAY).toEqual({ minMs: 2000, maxMs: 8000 });
  });
  it("returns min when min === max", () => {
    expect(pickDelayMs({ minMs: 100, maxMs: 100 })).toBe(100);
  });
});
