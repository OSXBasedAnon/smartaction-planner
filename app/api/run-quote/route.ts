import { randomUUID } from "crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import sitePlansJson from "@/config/site-plans.json";
import { deriveIntentCluster, parseAndRoute, rerankSitePlanWithGemini } from "@/lib/ai-parser";
import { createSupabaseServerClient } from "@/lib/supabase-server";
import { createSupabaseServiceClient } from "@/lib/supabase-service";

const inputSchema = z.object({
  items: z.array(
    z.object({
      query: z.string().min(1),
      qty: z.number().int().positive().default(1)
    })
  ),
  input_type: z.enum(["text", "sku", "csv"]).default("text")
});

type SiteMatch = {
  site: string;
  title?: string;
  price?: number;
  currency?: string;
  url?: string;
  status: string;
  message?: string;
  latency_ms?: number;
};

type RustEvent =
  | { type: "started"; run_id: string; started_at: string }
  | { type: "match"; item_index: number; query: string; match: SiteMatch }
  | { type: "item_done"; item_index: number; query: string; best?: { site: string; price: number; url: string } }
  | { type: "done"; duration_ms: number }
  | { type: "error"; message: string };

type SiteCatalogRow = {
  site: string;
  category?: string;
  search_url_template?: string;
  enabled?: boolean;
  priority?: number;
  reliability_score?: number;
  avg_latency_ms?: number;
  js_heavy?: boolean;
  block_rate?: number;
  runs_count?: number;
  success_count?: number;
  blocked_count?: number;
  unsupported_count?: number;
  error_count?: number;
  not_found_count?: number;
};

type SiteStats = {
  runs: number;
  ok: number;
  blocked: number;
  unsupported: number;
  error: number;
  notFound: number;
  latencySum: number;
  latencyCount: number;
};

type IntentSiteRow = {
  site: string;
  runs_count?: number;
  success_count?: number;
  blocked_count?: number;
  unsupported_count?: number;
  error_count?: number;
  not_found_count?: number;
  avg_latency_ms?: number;
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

function sanitizeSitePlan(plan: string[]): string[] {
  return [...new Set(plan.map(normalizeSiteId).filter((site) => KNOWN_SITES.has(site)))];
}

function seededFloat(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10000) / 10000;
}

function toNdjson(event: RustEvent) {
  return `${JSON.stringify(event)}\n`;
}

function canPersist() {
  return Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && (process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY));
}

async function resolveSitePlanFromSupabase(category: string, fallback: string[]): Promise<string[]> {
  if (!canPersist()) return fallback;

  try {
    const service = createSupabaseServiceClient();
    const { data, error } = await service.from("site_plans").select("sites").eq("category", category).maybeSingle();
    if (error || !data?.sites || !Array.isArray(data.sites)) return fallback;
    const sites = sanitizeSitePlan(data.sites.filter((s: unknown): s is string => typeof s === "string" && s.trim().length > 0));
    return sites.length > 0 ? sites : fallback;
  } catch {
    return fallback;
  }
}

async function resolveExpandedBasePlan(primaryCategory: string, categoryCandidates: string[], aiPlan: string[]): Promise<string[]> {
  const plans: string[][] = [aiPlan];
  plans.push(await resolveSitePlanFromSupabase(primaryCategory, aiPlan));

  for (const candidate of categoryCandidates.slice(0, 3)) {
    plans.push(await resolveSitePlanFromSupabase(candidate, []));
  }

  plans.push(await resolveSitePlanFromSupabase("unknown", []));

  return sanitizeSitePlan(plans.flat().filter((site) => site.trim().length > 0));
}

function intentFromSignals(
  category: string,
  labels: string[]
): "consumer" | "industrial" | "restaurant" | "office" | "unknown" {
  const joined = labels.join(" ");
  if (joined.includes("industrial") || joined.includes("electrical") || joined.includes("mro")) return "industrial";
  if (joined.includes("restaurant") || joined.includes("foodservice")) return "restaurant";
  if (joined.includes("office")) return "office";
  if (joined.includes("consumer") || joined.includes("gaming") || joined.includes("electronics")) return "consumer";

  if (category === "restaurant") return "restaurant";
  if (category === "office") return "office";
  if (category === "electrical") return "industrial";
  if (category === "electronics") return "consumer";
  return "unknown";
}

function filterSitesByIntent(sitePlan: string[], intent: "consumer" | "industrial" | "restaurant" | "office" | "unknown"): string[] {
  const industrialSites = new Set(["grainger", "zoro", "platt", "cityelectricsupply", "mcmaster", "lowes", "homedepot"]);
  const restaurantSites = new Set(["webstaurantstore", "katom", "centralrestaurant", "therestaurantstore", "restaurantdepot", "ace_mart"]);
  const officeSites = new Set(["staples", "officedepot", "quill", "uline"]);
  const consumerSites = new Set([
    "amazon",
    "amazon_business",
    "walmart",
    "walmart_business",
    "target",
    "ebay",
    "bestbuy",
    "newegg",
    "microcenter",
    "bhphotovideo",
    "adorama"
  ]);

  if (intent === "consumer") {
    const filtered = sitePlan.filter((site) => consumerSites.has(site) || officeSites.has(site));
    return filtered.length > 0 ? filtered : sitePlan;
  }

  if (intent === "industrial") {
    const filtered = sitePlan.filter((site) => industrialSites.has(site) || consumerSites.has(site));
    return filtered.length > 0 ? filtered : sitePlan;
  }

  if (intent === "restaurant") {
    const filtered = sitePlan.filter((site) => restaurantSites.has(site) || consumerSites.has(site));
    return filtered.length > 0 ? filtered : sitePlan;
  }

  if (intent === "office") {
    const filtered = sitePlan.filter((site) => officeSites.has(site) || consumerSites.has(site));
    return filtered.length > 0 ? filtered : sitePlan;
  }

  return sitePlan;
}

async function loadSiteCatalog(sitePlan: string[]): Promise<Map<string, SiteCatalogRow>> {
  if (!canPersist() || sitePlan.length === 0) return new Map();

  const service = createSupabaseServiceClient();

  try {
    const { data, error } = await service
      .from("site_catalog")
      .select(
        "site,category,search_url_template,enabled,priority,reliability_score,avg_latency_ms,js_heavy,block_rate,runs_count,success_count,blocked_count,unsupported_count,error_count,not_found_count"
      )
      .in("site", sitePlan);

    if (!error && data) {
      return new Map(data.map((row) => [row.site, row as SiteCatalogRow]));
    }
  } catch {
    // Fall through to lightweight query.
  }

  try {
    const { data, error } = await service.from("site_catalog").select("site,category,search_url_template,enabled,priority").in("site", sitePlan);
    if (error || !data) return new Map();
    return new Map(data.map((row) => [row.site, row as SiteCatalogRow]));
  } catch {
    return new Map();
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

async function persistSiteLearning(
  service: ReturnType<typeof createSupabaseServiceClient>,
  stats: Map<string, SiteStats>,
  catalog: Map<string, SiteCatalogRow>
) {
  if (stats.size === 0) return;

  const now = new Date().toISOString();
  for (const [site, entry] of stats) {
    const current = catalog.get(site);
    const prevRuns = current?.runs_count ?? 0;
    const prevSuccess = current?.success_count ?? 0;
    const prevBlocked = current?.blocked_count ?? 0;
    const prevUnsupported = current?.unsupported_count ?? 0;
    const prevError = current?.error_count ?? 0;
    const prevNotFound = current?.not_found_count ?? 0;

    const newRuns = prevRuns + entry.runs;
    const newSuccess = prevSuccess + entry.ok;
    const newBlocked = prevBlocked + entry.blocked;
    const newUnsupported = prevUnsupported + entry.unsupported;
    const newError = prevError + entry.error;
    const newNotFound = prevNotFound + entry.notFound;

    const prevLatency = current?.avg_latency_ms ?? 2200;
    const blendedLatency =
      entry.latencyCount > 0
        ? Math.round((prevLatency * Math.max(prevRuns, 1) + entry.latencySum) / (Math.max(prevRuns, 1) + entry.latencyCount))
        : prevLatency;

    const blockRate = newRuns > 0 ? clamp((newBlocked + newUnsupported) / newRuns, 0, 1) : current?.block_rate ?? 0.35;
    const reliability = newRuns > 0 ? clamp(newSuccess / newRuns, 0.02, 0.99) : current?.reliability_score ?? 0.62;

    await service
      .from("site_catalog")
      .update({
        runs_count: newRuns,
        success_count: newSuccess,
        blocked_count: newBlocked,
        unsupported_count: newUnsupported,
        error_count: newError,
        not_found_count: newNotFound,
        avg_latency_ms: blendedLatency,
        block_rate: Number(blockRate.toFixed(4)),
        reliability_score: Number(reliability.toFixed(4)),
        last_seen_at: now
      })
      .eq("site", site);
  }
}

async function persistIntentLearning(
  service: ReturnType<typeof createSupabaseServiceClient>,
  clusterKey: string,
  stats: Map<string, SiteStats>,
  currentIntentStats: Map<string, IntentSiteRow>
) {
  if (clusterKey.length === 0 || stats.size === 0) return;

  const now = new Date().toISOString();
  for (const [site, entry] of stats) {
    const current = currentIntentStats.get(site);
    const prevRuns = current?.runs_count ?? 0;
    const prevSuccess = current?.success_count ?? 0;
    const prevBlocked = current?.blocked_count ?? 0;
    const prevUnsupported = current?.unsupported_count ?? 0;
    const prevError = current?.error_count ?? 0;
    const prevNotFound = current?.not_found_count ?? 0;
    const prevLatency = current?.avg_latency_ms ?? 2200;

    const nextRuns = prevRuns + entry.runs;
    const nextSuccess = prevSuccess + entry.ok;
    const nextBlocked = prevBlocked + entry.blocked;
    const nextUnsupported = prevUnsupported + entry.unsupported;
    const nextError = prevError + entry.error;
    const nextNotFound = prevNotFound + entry.notFound;

    const nextLatency =
      entry.latencyCount > 0
        ? Math.round((prevLatency * Math.max(prevRuns, 1) + entry.latencySum) / (Math.max(prevRuns, 1) + entry.latencyCount))
        : prevLatency;

    await service.from("query_intent_site_stats").upsert(
      {
        cluster_key: clusterKey,
        site,
        runs_count: nextRuns,
        success_count: nextSuccess,
        blocked_count: nextBlocked,
        unsupported_count: nextUnsupported,
        error_count: nextError,
        not_found_count: nextNotFound,
        avg_latency_ms: nextLatency,
        last_seen_at: now
      },
      { onConflict: "cluster_key,site" }
    );
  }
}

function scoreSites(sitePlan: string[], catalog: Map<string, SiteCatalogRow>) {
  return sitePlan
    .map((site) => {
      const row = catalog.get(site);
      if (row?.enabled === false) {
        return { site, score: Number.NEGATIVE_INFINITY };
      }

      const priority = row?.priority ?? 100;
      const reliability = row?.reliability_score ?? 0.62;
      const latency = row?.avg_latency_ms ?? 2200;
      const blockRate = row?.block_rate ?? 0.35;
      const jsPenalty = row?.js_heavy ? 180 : 0;

      const score = 1000 - priority * 3 + reliability * 420 - blockRate * 240 - latency / 45 - jsPenalty;
      return { site, score };
    })
    .filter((row) => Number.isFinite(row.score) && row.score > -1e9);
}

async function loadIntentSiteStats(
  service: ReturnType<typeof createSupabaseServiceClient>,
  clusterKey: string,
  sites: string[]
): Promise<Map<string, IntentSiteRow>> {
  if (sites.length === 0) return new Map();
  try {
    const { data, error } = await service
      .from("query_intent_site_stats")
      .select("site,runs_count,success_count,blocked_count,unsupported_count,error_count,not_found_count,avg_latency_ms")
      .eq("cluster_key", clusterKey)
      .in("site", sites);

    if (error || !data) return new Map();
    return new Map(data.map((row) => [row.site, row as IntentSiteRow]));
  } catch {
    return new Map();
  }
}

function rankWithBandit(
  runId: string,
  baseScores: Array<{ site: string; score: number }>,
  intentStats: Map<string, IntentSiteRow>
): string[] {
  const totalRuns = Array.from(intentStats.values()).reduce((acc, row) => acc + (row.runs_count ?? 0), 0);

  const scored = baseScores.map((entry) => {
    const stat = intentStats.get(entry.site);
    const runs = stat?.runs_count ?? 0;
    const success = stat?.success_count ?? 0;
    const blocked = (stat?.blocked_count ?? 0) + (stat?.unsupported_count ?? 0);
    const latency = stat?.avg_latency_ms ?? 2200;

    const successRate = runs > 0 ? success / runs : 0.55;
    const blockRate = runs > 0 ? blocked / runs : 0.35;
    const intentSignal = successRate * 260 - blockRate * 200 - latency / 80;
    const exploreBonus = 95 * Math.sqrt(Math.log(totalRuns + 2) / (runs + 1));

    return {
      site: entry.site,
      score: entry.score + intentSignal + exploreBonus,
      runs
    };
  });

  scored.sort((a, b) => b.score - a.score);

  const exploreChance = 0.16;
  if (scored.length > 4 && seededFloat(`${runId}:explore`) < exploreChance) {
    const cold = scored
      .filter((row) => row.runs < 3)
      .sort((a, b) => b.score - a.score)
      .slice(0, 2)
      .map((row) => row.site);
    const warm = scored.map((row) => row.site).filter((site) => !cold.includes(site));
    return [...warm.slice(0, 3), ...cold, ...warm.slice(3)];
  }

  return scored.map((row) => row.site);
}

function buildSiteOverrides(sitePlan: string[], catalog: Map<string, SiteCatalogRow>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const site of sitePlan) {
    const template = catalog.get(site)?.search_url_template;
    if (typeof template === "string" && template.includes("{q}")) {
      out[site] = template;
    }
  }
  return out;
}

function shouldExpand(itemCount: number, itemHasOk: Set<number>, totalOk: number, remainingCount: number) {
  if (remainingCount <= 0) return false;
  if (totalOk === 0) return true;
  if (itemHasOk.size < itemCount) return true;
  return totalOk < Math.min(itemCount * 2, 4);
}

export async function POST(request: Request) {
  const rawBody = await request.json();
  const parsedInput = inputSchema.safeParse(rawBody);

  if (!parsedInput.success) {
    return NextResponse.json({ error: "Invalid payload", details: parsedInput.error.flatten() }, { status: 400 });
  }

  const runId = randomUUID();
  const parsed = await parseAndRoute(parsedInput.data.items);

  if (parsed.normalized_items.length === 0) {
    return NextResponse.json({ error: "No valid items in request" }, { status: 400 });
  }

  const service = canPersist() ? createSupabaseServiceClient() : null;
  const intentCluster = await deriveIntentCluster(parsed.normalized_items, parsed.category);
  const candidateCategories = parsed.confidence >= 0.72 ? [] : parsed.category_candidates;
  const basePlanUnfiltered = await resolveExpandedBasePlan(parsed.category, candidateCategories, parsed.site_plan);
  const intent = intentFromSignals(parsed.category, intentCluster.labels);
  const basePlan = filterSitesByIntent(basePlanUnfiltered, intent);
  const catalog = await loadSiteCatalog(basePlan);
  const baseScores = scoreSites(basePlan, catalog);
  const intentStats = service ? await loadIntentSiteStats(service, intentCluster.cluster_key, basePlan) : new Map();
  const banditRanked = rankWithBandit(runId, baseScores, intentStats).slice(0, 12);
  const rankedSites = await rerankSitePlanWithGemini(parsed.normalized_items, parsed.category, banditRanked);

  const probeSize = parsed.confidence >= 0.75 ? 4 : 6;
  const probeSites = rankedSites.slice(0, probeSize);
  const expansionSites = rankedSites.slice(probeSize);

  let userId: string | null = null;

  try {
    const supabase = await createSupabaseServerClient();
    const {
      data: { user }
    } = await supabase.auth.getUser();
    userId = user?.id ?? null;
  } catch {
    userId = null;
  }

  if (userId && service) {
    await service.from("quote_runs").insert({
      id: runId,
      user_id: userId,
      input_type: parsedInput.data.input_type,
      raw_input: JSON.stringify(parsedInput.data.items),
      category: parsed.category,
      site_plan: rankedSites,
      status: "running"
    });
  }

  const origin = process.env.APP_BASE_URL ?? new URL(request.url).origin;
  const startedAtMs = Date.now();
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const itemHasOk = new Set<number>();
      let totalOk = 0;
      const siteStats = new Map<string, SiteStats>();

      function addSiteStat(match: SiteMatch) {
        const current = siteStats.get(match.site) ?? {
          runs: 0,
          ok: 0,
          blocked: 0,
          unsupported: 0,
          error: 0,
          notFound: 0,
          latencySum: 0,
          latencyCount: 0
        };
        current.runs += 1;
        if (match.status === "ok") current.ok += 1;
        else if (match.status === "blocked") current.blocked += 1;
        else if (match.status === "unsupported_js") current.unsupported += 1;
        else if (match.status === "not_found") current.notFound += 1;
        else if (match.status === "error") current.error += 1;
        if (typeof match.latency_ms === "number" && match.latency_ms > 0) {
          current.latencySum += match.latency_ms;
          current.latencyCount += 1;
        }
        siteStats.set(match.site, current);
      }

      async function persistMatch(itemIndex: number, match: SiteMatch) {
        if (!service || !userId) return;
        await service.from("quote_results").insert({
          run_id: runId,
          item_index: itemIndex,
          site: match.site,
          title: match.title ?? null,
          price: typeof match.price === "number" ? match.price : null,
          currency: match.currency ?? "USD",
          url: match.url ?? null,
          status: match.status,
          message: match.message ?? null,
          latency_ms: match.latency_ms ?? null
        });
      }

      async function runProbeStage(sites: string[]) {
        const response = await fetch(`${origin}/api/quote_stream`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            run_id: runId,
            items: parsed.normalized_items,
            category: parsed.category,
            site_plan: sites,
            site_overrides: buildSiteOverrides(sites, catalog),
            options: { cache_ttl: Number(process.env.CACHE_TTL_SECONDS ?? "0") }
          })
        });

        if (!response.ok || !response.body) {
          throw new Error(`probe_stage_failed_${response.status}`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const events = buffer.split("\n\n");
          buffer = events.pop() ?? "";

          for (const rawEvent of events) {
            const line = rawEvent
              .split("\n")
              .find((l) => l.startsWith("data: "))
              ?.replace("data: ", "")
              .trim();
            if (!line) continue;

            const event = JSON.parse(line) as RustEvent;
            if (event.type === "match") {
              if (event.match.status === "ok") {
                totalOk += 1;
                itemHasOk.add(event.item_index);
              }
              addSiteStat(event.match);
              await persistMatch(event.item_index, event.match);
              controller.enqueue(encoder.encode(toNdjson(event)));
            } else if (event.type === "item_done") {
              controller.enqueue(encoder.encode(toNdjson(event)));
            }
          }
        }
      }

      async function runExpansionStage(sites: string[]) {
        const response = await fetch(`${origin}/api/quote`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            run_id: runId,
            items: parsed.normalized_items,
            category: parsed.category,
            site_plan: sites,
            site_overrides: buildSiteOverrides(sites, catalog),
            options: { cache_ttl: Number(process.env.CACHE_TTL_SECONDS ?? "0") }
          })
        });

        if (response.status === 405) {
          await runProbeStage(sites);
          return;
        }

        if (!response.ok) {
          throw new Error(`expansion_stage_failed_${response.status}`);
        }

        const json = await response.json();
        for (let itemIndex = 0; itemIndex < json.items.length; itemIndex++) {
          const item = json.items[itemIndex];
          for (const match of item.matches as SiteMatch[]) {
            if (match.status === "ok") {
              totalOk += 1;
              itemHasOk.add(itemIndex);
            }
            addSiteStat(match);
            await persistMatch(itemIndex, match);
            controller.enqueue(encoder.encode(toNdjson({ type: "match", item_index: itemIndex, query: item.query, match })));
          }
          controller.enqueue(
            encoder.encode(toNdjson({ type: "item_done", item_index: itemIndex, query: item.query, best: item.best }))
          );
        }
      }

      try {
        controller.enqueue(encoder.encode(toNdjson({ type: "started", run_id: runId, started_at: new Date(startedAtMs).toISOString() })));

        await runProbeStage(probeSites.length > 0 ? probeSites : rankedSites.slice(0, 4));

        if (shouldExpand(parsed.normalized_items.length, itemHasOk, totalOk, expansionSites.length)) {
          await runExpansionStage(expansionSites);
        }

        const durationMs = Date.now() - startedAtMs;
        if (service && userId) {
          await service.from("quote_runs").update({ status: "done", duration_ms: durationMs }).eq("id", runId).eq("user_id", userId);
        }
        if (service) {
          await persistSiteLearning(service, siteStats, catalog);
          await persistIntentLearning(service, intentCluster.cluster_key, siteStats, intentStats);
        }
        controller.enqueue(encoder.encode(toNdjson({ type: "done", duration_ms: durationMs })));
      } catch (error) {
        if (service && userId) {
          await service.from("quote_runs").update({ status: "error" }).eq("id", runId).eq("user_id", userId);
        }
        controller.enqueue(
          encoder.encode(
            toNdjson({
              type: "error",
              message: error instanceof Error ? error.message : "run_quote_orchestration_failed"
            })
          )
        );
      } finally {
        controller.close();
      }
    }
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache"
    }
  });
}
