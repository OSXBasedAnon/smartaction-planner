import { describe, expect, it } from "vitest";
import { fallbackCategorize, normalizeItems } from "@/lib/site-plan";

describe("site plan fallback", () => {
  it("routes electronics terms", () => {
    const result = fallbackCategorize([{ query: "MacBook Pro 14", qty: 1 }]);
    expect(result.category).toBe("electronics");
    expect(result.site_plan.length).toBeGreaterThan(0);
  });

  it("normalizes and removes empty items", () => {
    const normalized = normalizeItems([{ query: "  toner ", qty: 2 }, { query: "", qty: 1 }]);
    expect(normalized).toEqual([{ query: "toner", qty: 2 }]);
  });
});
