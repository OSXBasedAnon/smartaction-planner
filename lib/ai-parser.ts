import { z } from "zod";
import { fallbackCategorize, normalizeItems } from "@/lib/site-plan";
import type { Category, QuoteItem } from "@/lib/types";

const aiResponseSchema = z.object({
  normalized_items: z.array(
    z.object({
      query: z.string().min(1),
      qty: z.number().int().positive().default(1)
    })
  ),
  category: z.enum(["electronics", "office", "restaurant", "electrical", "unknown"]),
  site_plan: z.array(z.string().min(1))
});

export type ParsedPlan = {
  normalized_items: QuoteItem[];
  category: Category;
  site_plan: string[];
  source: "ai" | "fallback";
};

export async function parseAndRoute(items: QuoteItem[]): Promise<ParsedPlan> {
  const normalized = normalizeItems(items);
  if (normalized.length === 0) {
    return {
      normalized_items: [],
      category: "unknown",
      site_plan: fallbackCategorize([]).site_plan,
      source: "fallback"
    };
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    const fallback = fallbackCategorize(normalized);
    return { normalized_items: normalized, ...fallback, source: "fallback" };
  }

  try {
    const prompt = [
      "You are a strict JSON API. Classify procurement items.",
      "Return only JSON in this shape:",
      '{"normalized_items":[{"query":"...","qty":1}],"category":"electronics|office|restaurant|electrical|unknown","site_plan":["..."]}',
      "Use concise normalized queries."
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
    const safeSitePlan = parsed.site_plan.filter((site) => site.trim().length > 0);
    return {
      normalized_items: safeItems.length > 0 ? safeItems : normalized,
      category: parsed.category,
      site_plan: safeSitePlan.length > 0 ? safeSitePlan : fallback.site_plan,
      source: "ai"
    };
  } catch {
    const fallback = fallbackCategorize(normalized);
    return { normalized_items: normalized, ...fallback, source: "fallback" };
  }
}
