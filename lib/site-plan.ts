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
  const match = KEYWORD_MAP.find((entry) => entry.terms.some((term) => text.includes(term)));
  const category = match?.category ?? "unknown";
  return { category, site_plan: getSitePlan(category) };
}

export function normalizeItems(items: Array<Partial<QuoteItem>>): QuoteItem[] {
  return items
    .map((item) => ({
      query: (item.query ?? "").trim().toLowerCase(),
      qty: Number.isFinite(item.qty) && (item.qty ?? 0) > 0 ? Number(item.qty) : 1
    }))
    .filter((item) => item.query.length > 0);
}
