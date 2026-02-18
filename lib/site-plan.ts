import sitePlansJson from "@/config/site-plans.json";
import type { Category, QuoteItem } from "@/lib/types";

type SitePlanEntry = {
  category: Category;
  sites: string[];
};

const sitePlans = sitePlansJson as SitePlanEntry[];

const KEYWORD_MAP: Array<{ category: Category; terms: string[] }> = [
  { category: "electronics", terms: ["macbook", "laptop", "monitor", "ssd", "gpu", "iphone", "router"] },
  { category: "office", terms: ["paper", "staple", "toner", "printer", "notebook", "pen", "folder"] },
  { category: "restaurant", terms: ["food", "pan", "fryer", "cutlery", "table", "napkin", "restaurant"] },
  { category: "electrical", terms: ["breaker", "wire", "conduit", "switch", "outlet", "electrical", "voltage"] }
];

export function getSitePlan(category: Category): string[] {
  return sitePlans.find((entry) => entry.category === category)?.sites ?? getSitePlan("unknown");
}

export function fallbackCategorize(items: QuoteItem[]): { category: Category; site_plan: string[] } {
  const text = items.map((item) => item.query.toLowerCase()).join(" ");
  const scores = KEYWORD_MAP.map((entry) => ({
    category: entry.category,
    score: entry.terms.reduce((acc, term) => (text.includes(term) ? acc + 1 : acc), 0)
  }));

  const top = scores.sort((a, b) => b.score - a.score)[0];
  if (!top || top.score === 0) {
    return { category: "unknown", site_plan: getSitePlan("unknown") };
  }

  // Deterministic fallback: use the detected category, but blend unknown sites when confidence is weak.
  if (top.score <= 1) {
    const blended = [...getSitePlan(top.category), ...getSitePlan("unknown")];
    return { category: top.category, site_plan: [...new Set(blended)].slice(0, 7) };
  }

  return { category: top.category, site_plan: getSitePlan(top.category) };
}

export function normalizeItems(items: Array<Partial<QuoteItem>>): QuoteItem[] {
  return items
    .map((item) => ({
      query: (item.query ?? "").trim().toLowerCase(),
      qty: Number.isFinite(item.qty) && (item.qty ?? 0) > 0 ? Number(item.qty) : 1
    }))
    .filter((item) => item.query.length > 0);
}
