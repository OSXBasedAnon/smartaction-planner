import { randomUUID } from "crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import sitePlansJson from "@/config/site-plans.json";
import { parseAndRoute, rerankSitePlanWithGemini } from "@/lib/ai-parser";
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

function scoreSites(sitePlan: string[], catalog: Map<string, SiteCatalogRow>) {
  const scored = sitePlan
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
    .filter((row) => Number.isFinite(row.score) && row.score > -1e9)
    .sort((a, b) => b.score - a.score)
    .map((row) => row.site);

  return scored.length > 0 ? scored : sitePlan;
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

  const basePlan = await resolveExpandedBasePlan(parsed.category, parsed.category_candidates, parsed.site_plan);
  const catalog = await loadSiteCatalog(basePlan);
  const scoredSites = scoreSites(basePlan, catalog).slice(0, 12);
  const rankedSites = await rerankSitePlanWithGemini(parsed.normalized_items, parsed.category, scoredSites);

  const probeSize = parsed.confidence >= 0.75 ? 4 : 6;
  const probeSites = rankedSites.slice(0, probeSize);
  const expansionSites = rankedSites.slice(probeSize);

  let userId: string | null = null;
  const service = canPersist() ? createSupabaseServiceClient() : null;

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
