import { z } from "zod";
import { fallbackCategorize, getSitePlan, normalizeItems } from "@/lib/site-plan";
import sitePlansJson from "@/config/site-plans.json";
import type { Category, QuoteItem } from "@/lib/types";

const aiResponseSchema = z.object({
  normalized_items: z.array(
    z.object({
      query: z.string().min(1),
      qty: z.number().int().positive().default(1)
    })
  ),
  category: z.enum(["electronics", "office", "restaurant", "electrical", "unknown"]),
  site_plan: z.array(z.string().min(1)),
  category_candidates: z.array(z.string()).optional(),
  query_variants: z.array(z.string()).optional(),
  confidence: z.number().min(0).max(1).optional()
});

export type ParsedPlan = {
  normalized_items: QuoteItem[];
  category: Category;
  site_plan: string[];
  category_candidates: Category[];
  query_variants: string[];
  confidence: number;
  source: "ai" | "fallback";
};

export type IntentCluster = {
  cluster_key: string;
  labels: string[];
  confidence: number;
  source: "ai" | "fallback";
};

const KNOWN_SITES = new Set(
  (sitePlansJson as Array<{ category: string; sites: string[] }>)
    .flatMap((entry) => entry.sites)
    .map((site) => site.toLowerCase())
);

function normalizeSiteId(site: string): string {
  return site
    .toLowerCase()
    .trim()
    .replace(/&/g, "and")
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_]/g, "");
}

function sanitizePlan(plan: string[]): string[] {
  return [...new Set(plan.map(normalizeSiteId).filter((site) => KNOWN_SITES.has(site)))];
}

function normalizeToken(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function fallbackClusterKey(items: QuoteItem[], category: Category): string {
  const tokenStream = items
    .flatMap((item) => item.query.split(/\s+/))
    .map((token) => normalizeToken(token))
    .filter((token) => token.length >= 3);
  const uniq = [...new Set(tokenStream)].slice(0, 4);
  return `c_${category}_${uniq.join("_") || "generic"}`;
}

export async function deriveIntentCluster(items: QuoteItem[], category: Category): Promise<IntentCluster> {
  const normalizedItems = normalizeItems(items);
  const fallbackKey = fallbackClusterKey(normalizedItems, category);
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey || normalizedItems.length === 0) {
    return { cluster_key: fallbackKey, labels: [category], confidence: 0.35, source: "fallback" };
  }

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [
                {
                  text: [
                    "Return JSON only:",
                    '{"cluster_key":"short_snake_case","labels":["..."],"confidence":0.0}',
                    "cluster_key must represent product intent family and stay stable for similar phrasing.",
                    `category=${category}`,
                    `items=${JSON.stringify(normalizedItems)}`
                  ].join("\n")
                }
              ]
            }
          ],
          generationConfig: {
            temperature: 0,
            responseMimeType: "application/json"
          }
        })
      }
    );

    if (!response.ok) throw new Error(`intent_cluster_failed_${response.status}`);
    const data = await response.json();
    const content = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!content) throw new Error("intent_cluster_no_content");

    const parsed = JSON.parse(content) as { cluster_key?: string; labels?: string[]; confidence?: number };
    const normalizedKey = normalizeToken(parsed.cluster_key ?? "");
    const labels = (parsed.labels ?? [])
      .map((label) => normalizeToken(label))
      .filter((label) => label.length > 0)
      .slice(0, 6);

    return {
      cluster_key: normalizedKey.length > 0 ? `c_${normalizedKey}` : fallbackKey,
      labels: labels.length > 0 ? labels : [category],
      confidence: typeof parsed.confidence === "number" ? Math.max(0, Math.min(1, parsed.confidence)) : 0.7,
      source: "ai"
    };
  } catch {
    return { cluster_key: fallbackKey, labels: [category], confidence: 0.4, source: "fallback" };
  }
}

export async function rerankSitePlanWithGemini(
  items: QuoteItem[],
  category: Category,
  candidateSites: string[]
): Promise<string[]> {
  const apiKey = process.env.GEMINI_API_KEY;
  const sanitizedCandidates = sanitizePlan(candidateSites);
  if (!apiKey || sanitizedCandidates.length < 2) return sanitizedCandidates;

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [
                {
                  text: [
                    "Return JSON only: {\"site_order\":[\"...\"]}",
                    "Order by likely success, relevance, and price signal quality.",
                    `category=${category}`,
                    `items=${JSON.stringify(items)}`,
                    `candidates=${JSON.stringify(sanitizedCandidates)}`
                  ].join("\n")
                }
              ]
            }
          ],
          generationConfig: {
            temperature: 0,
            responseMimeType: "application/json"
          }
        })
      }
    );
    if (!response.ok) return sanitizedCandidates;
    const data = await response.json();
    const content = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!content) return sanitizedCandidates;

    const parsed = JSON.parse(content) as { site_order?: string[] };
    const ordered = sanitizePlan(parsed.site_order ?? []).filter((site) => sanitizedCandidates.includes(site));
    const merged = [...ordered, ...sanitizedCandidates];
    return [...new Set(merged)];
  } catch {
    return sanitizedCandidates;
  }
}

export async function expandSitePlanWithGemini(
  items: QuoteItem[],
  category: Category,
  currentSites: string[],
  candidatePool: string[],
  limit = 6
): Promise<string[]> {
  const apiKey = process.env.GEMINI_API_KEY;
  const active = sanitizePlan(currentSites);
  const pool = sanitizePlan(candidatePool).filter((site) => !active.includes(site));
  if (!apiKey || pool.length === 0 || limit <= 0) return [];

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [
                {
                  text: [
                    "Return JSON only: {\"site_additions\":[\"...\"]}",
                    "Goal: increase relevant price coverage quickly when current scrape results are sparse.",
                    "Only choose from candidate_pool and do not invent site names.",
                    `category=${category}`,
                    `items=${JSON.stringify(items)}`,
                    `current_sites=${JSON.stringify(active)}`,
                    `candidate_pool=${JSON.stringify(pool)}`
                  ].join("\n")
                }
              ]
            }
          ],
          generationConfig: {
            temperature: 0,
            responseMimeType: "application/json"
          }
        })
      }
    );
    if (!response.ok) return [];
    const data = await response.json();
    const content = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!content) return [];

    const parsed = JSON.parse(content) as { site_additions?: string[] };
    const additions = sanitizePlan(parsed.site_additions ?? []).filter((site) => pool.includes(site));
    return additions.slice(0, limit);
  } catch {
    return [];
  }
}

function applyRoutingGuardrails(items: QuoteItem[], category: Category, sitePlan: string[]): { category: Category; site_plan: string[] } {
  const text = items.map((item) => item.query.toLowerCase()).join(" ");
  const groceryHints = ["sugar", "stevia", "sweetener", "coffee", "tea", "snack", "flour", "rice", "food"];
  const retailHints = ["shoe", "shoes", "sneaker", "sneakers", "boot", "puma", "nike", "adidas", "hoodie", "shirt", "jeans"];
  const hasGrocerySignal = groceryHints.some((word) => text.includes(word));
  const hasRetailSignal = retailHints.some((word) => text.includes(word));

  if (hasGrocerySignal) {
    const fallback = fallbackCategorize(items);
    const filtered = sitePlan.filter((site) => !["newegg", "microcenter", "bestbuy", "bhphotovideo", "adorama"].includes(site));
    const merged = [...filtered, ...fallback.site_plan];
    const unique = [...new Set(merged)];
    return {
      category: category === "electronics" ? "restaurant" : category,
      site_plan: unique.length > 0 ? unique : fallback.site_plan
    };
  }

  if (hasRetailSignal) {
    const unknownPlan = getSitePlan("unknown");
    const allowedRetail = new Set(["amazon", "ebay", "target", "walmart"]);
    const filtered = sitePlan.filter((site) => allowedRetail.has(site));
    const merged = [...filtered, ...unknownPlan];
    return {
      category: "unknown",
      site_plan: [...new Set(merged)]
    };
  }

  return { category, site_plan: sitePlan };
}

function ensurePlanCoverage(items: QuoteItem[], category: Category, sitePlan: string[]): string[] {
  const fallback = fallbackCategorize(items);
  const categoryDefault = getSitePlan(category);
  const unknownDefault = getSitePlan("unknown");

  const merged = [...sitePlan, ...categoryDefault, ...fallback.site_plan, ...unknownDefault];
  const unique = sanitizePlan(merged);

  // Never run too narrow plans; sparse plans make results look broken.
  return unique.slice(0, Math.max(4, Math.min(8, unique.length)));
}

function toCategoryCandidates(raw: string[] | undefined, fallback: Category): Category[] {
  const valid = new Set<Category>(["electronics", "office", "restaurant", "electrical", "unknown"]);
  const values = (raw ?? []).filter((v): v is Category => valid.has(v as Category));
  const merged = [fallback, ...values];
  return [...new Set(merged)];
}

export async function parseAndRoute(items: QuoteItem[]): Promise<ParsedPlan> {
  const normalized = normalizeItems(items);
  if (normalized.length === 0) {
    return {
      normalized_items: [],
      category: "unknown",
      site_plan: fallbackCategorize([]).site_plan,
      category_candidates: ["unknown"],
      query_variants: [],
      confidence: 0.2,
      source: "fallback"
    };
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    const fallback = fallbackCategorize(normalized);
    return {
      normalized_items: normalized,
      ...fallback,
      category_candidates: [fallback.category],
      query_variants: normalized.map((item) => item.query),
      confidence: 0.35,
      source: "fallback"
    };
  }

  try {
    const prompt = [
      "You are a strict JSON API. Classify procurement items.",
      "Return only JSON in this shape:",
      '{"normalized_items":[{"query":"...","qty":1}],"category":"electronics|office|restaurant|electrical|unknown","category_candidates":["..."],"query_variants":["..."],"confidence":0.0,"site_plan":["..."]}',
      "Use concise normalized queries.",
      "confidence is 0-1 where 1 is very certain.",
      "Provide at least 3 site_plan entries when possible."
    ].join("\n");

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [{ text: `${prompt}\n${JSON.stringify({ items: normalized })}` }]
            }
          ],
          generationConfig: {
            temperature: 0,
            responseMimeType: "application/json"
          }
        })
      }
    );

    if (!response.ok) throw new Error(`Gemini failed: ${response.status}`);
    const data = await response.json();
    const content = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!content) throw new Error("No content from AI parser");

    const parsed = aiResponseSchema.parse(JSON.parse(content));
    const fallback = fallbackCategorize(normalized);
    const safeItems = normalizeItems(parsed.normalized_items);
    const safeSitePlan = sanitizePlan(parsed.site_plan);
    const guarded = applyRoutingGuardrails(
      safeItems.length > 0 ? safeItems : normalized,
      parsed.category,
      safeSitePlan.length > 0 ? safeSitePlan : fallback.site_plan
    );
    const covered = ensurePlanCoverage(safeItems.length > 0 ? safeItems : normalized, guarded.category, guarded.site_plan);
    return {
      normalized_items: safeItems.length > 0 ? safeItems : normalized,
      category: guarded.category,
      site_plan: covered,
      category_candidates: toCategoryCandidates(parsed.category_candidates, guarded.category),
      query_variants: (parsed.query_variants ?? []).filter((q) => q.trim().length > 0).slice(0, 8),
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.7,
      source: "ai"
    };
  } catch {
    const fallback = fallbackCategorize(normalized);
    const guarded = applyRoutingGuardrails(normalized, fallback.category, fallback.site_plan);
    const covered = ensurePlanCoverage(normalized, guarded.category, guarded.site_plan);
    return {
      normalized_items: normalized,
      category: guarded.category,
      site_plan: covered,
      category_candidates: [guarded.category],
      query_variants: normalized.map((item) => item.query),
      confidence: 0.4,
      source: "fallback"
    };
  }
}
