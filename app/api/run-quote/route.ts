import { randomUUID } from "crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { parseAndRoute } from "@/lib/ai-parser";
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
    const { data, error } = await service
      .from("site_plans")
      .select("sites")
      .eq("category", category)
      .maybeSingle();

    if (error || !data?.sites || !Array.isArray(data.sites)) return fallback;
    const sites = data.sites.filter((s: unknown): s is string => typeof s === "string" && s.trim().length > 0);
    return sites.length > 0 ? sites : fallback;
  } catch {
    return fallback;
  }
}

async function resolveSiteOverridesFromSupabase(sitePlan: string[]): Promise<Record<string, string>> {
  if (!canPersist() || sitePlan.length === 0) return {};

  try {
    const service = createSupabaseServiceClient();
    const { data, error } = await service
      .from("site_catalog")
      .select("site, search_url_template")
      .in("site", sitePlan)
      .eq("enabled", true);

    if (error || !data) return {};

    const overrides: Record<string, string> = {};
    for (const row of data) {
      if (typeof row.site === "string" && typeof row.search_url_template === "string" && row.search_url_template.includes("{q}")) {
        overrides[row.site] = row.search_url_template;
      }
    }
    return overrides;
  } catch {
    return {};
  }
}

async function filterEnabledSites(sitePlan: string[]): Promise<string[]> {
  if (!canPersist() || sitePlan.length === 0) return sitePlan;
  try {
    const service = createSupabaseServiceClient();
    const { data, error } = await service.from("site_catalog").select("site, enabled").in("site", sitePlan);
    if (error || !data) return sitePlan;
    const enabledBySite = new Map<string, boolean>();
    for (const row of data) {
      if (typeof row.site === "string") {
        enabledBySite.set(row.site, row.enabled !== false);
      }
    }
    // Keep unknown sites; only remove explicitly disabled ones.
    const filtered = sitePlan.filter((site) => enabledBySite.get(site) !== false);
    return filtered.length > 0 ? filtered : sitePlan;
  } catch {
    return sitePlan;
  }
}

export async function POST(request: Request) {
  const rawBody = await request.json();
  const parsedInput = inputSchema.safeParse(rawBody);

  if (!parsedInput.success) {
    return NextResponse.json({ error: "Invalid payload", details: parsedInput.error.flatten() }, { status: 400 });
  }

  const runId = randomUUID();
  const normalized = await parseAndRoute(parsedInput.data.items);
  const plannedSitePlan = await resolveSitePlanFromSupabase(normalized.category, normalized.site_plan);
  const resolvedSitePlan = await filterEnabledSites(plannedSitePlan);
  const siteOverrides = await resolveSiteOverridesFromSupabase(resolvedSitePlan);

  if (normalized.normalized_items.length === 0) {
    return NextResponse.json({ error: "No valid items in request" }, { status: 400 });
  }

  let userId: string | null = null;
  let service: ReturnType<typeof createSupabaseServiceClient> | null = null;

  try {
    const supabase = await createSupabaseServerClient();
    const {
      data: { user }
    } = await supabase.auth.getUser();
    userId = user?.id ?? null;
  } catch {
    userId = null;
  }

  if (userId && canPersist()) {
    service = createSupabaseServiceClient();
    await service.from("quote_runs").insert({
      id: runId,
      user_id: userId,
      input_type: parsedInput.data.input_type,
      raw_input: JSON.stringify(parsedInput.data.items),
      category: normalized.category,
      site_plan: resolvedSitePlan,
      status: "running"
    });
  }

  const origin = process.env.APP_BASE_URL ?? new URL(request.url).origin;
  const payload = {
    run_id: runId,
    items: normalized.normalized_items,
    category: normalized.category,
    site_plan: resolvedSitePlan,
    site_overrides: siteOverrides,
    options: {
      cache_ttl: Number(process.env.CACHE_TTL_SECONDS ?? "0")
    }
  };

  const streamResponse = await fetch(`${origin}/api/quote_stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!streamResponse.ok || !streamResponse.body) {
    const quoteResponse = await fetch(`${origin}/api/quote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (!quoteResponse.ok) {
      if (service && userId) {
        await service.from("quote_runs").update({ status: "error" }).eq("id", runId).eq("user_id", userId);
      }
      return NextResponse.json({ error: "Quote failed", stream_status: streamResponse.status, quote_status: quoteResponse.status }, { status: 502 });
    }

    const quoteJson = await quoteResponse.json();
    const lines: string[] = [];
    lines.push(toNdjson({ type: "started", run_id: runId, started_at: new Date().toISOString() }));

    for (let i = 0; i < quoteJson.items.length; i++) {
      const item = quoteJson.items[i];
      for (const match of item.matches) {
        const event: RustEvent = { type: "match", item_index: i, query: item.query, match };
        lines.push(toNdjson(event));

        if (service && userId) {
          await service.from("quote_results").insert({
            run_id: runId,
            item_index: i,
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
      }

      lines.push(toNdjson({ type: "item_done", item_index: i, query: item.query, best: item.best }));
    }

    lines.push(toNdjson({ type: "done", duration_ms: quoteJson.duration_ms ?? 0 }));

    if (service && userId) {
      await service.from("quote_runs").update({ status: "done", duration_ms: quoteJson.duration_ms ?? 0 }).eq("id", runId).eq("user_id", userId);
    }

    return new Response(lines.join(""), {
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-cache"
      }
    });
  }

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encoder.encode(toNdjson({ type: "started", run_id: runId, started_at: new Date().toISOString() })));

      const reader = streamResponse.body!.getReader();
      let buffer = "";

      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const events = buffer.split("\n\n");
          buffer = events.pop() ?? "";

          for (const rawEvent of events) {
            const dataLine = rawEvent
              .split("\n")
              .find((line) => line.startsWith("data: "))
              ?.replace("data: ", "")
              .trim();

            if (!dataLine) continue;
            const parsed = JSON.parse(dataLine) as RustEvent;

            if (parsed.type === "match" && service && userId) {
              await service.from("quote_results").insert({
                run_id: runId,
                item_index: parsed.item_index,
                site: parsed.match.site,
                title: parsed.match.title ?? null,
                price: typeof parsed.match.price === "number" ? parsed.match.price : null,
                currency: parsed.match.currency ?? "USD",
                url: parsed.match.url ?? null,
                status: parsed.match.status,
                message: parsed.match.message ?? null,
                latency_ms: parsed.match.latency_ms ?? null
              });
            }

            if (parsed.type === "done" && service && userId) {
              await service.from("quote_runs").update({ status: "done", duration_ms: parsed.duration_ms }).eq("id", runId).eq("user_id", userId);
            }

            if (parsed.type === "error" && service && userId) {
              await service.from("quote_runs").update({ status: "error" }).eq("id", runId).eq("user_id", userId);
            }

            controller.enqueue(encoder.encode(toNdjson(parsed)));
          }
        }
      } catch (error) {
        if (service && userId) {
          await service.from("quote_runs").update({ status: "error" }).eq("id", runId).eq("user_id", userId);
        }
        controller.enqueue(
          encoder.encode(
            toNdjson({
              type: "error",
              message: error instanceof Error ? error.message : "Stream parsing failed"
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
