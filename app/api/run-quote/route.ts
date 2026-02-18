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

type RustEvent =
  | { type: "started"; run_id: string; started_at: string }
  | {
      type: "match";
      item_index: number;
      query: string;
      match: {
        site: string;
        title?: string;
        price?: number;
        currency?: string;
        url?: string;
        status: string;
        message?: string;
        latency_ms?: number;
      };
    }
  | { type: "item_done"; item_index: number; query: string; best?: { site: string; price: number; url: string } }
  | { type: "done"; duration_ms: number }
  | { type: "error"; message: string };

function toNdjson(event: RustEvent) {
  return `${JSON.stringify(event)}\n`;
}

export async function POST(request: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rawBody = await request.json();
  const parsedInput = inputSchema.safeParse(rawBody);

  if (!parsedInput.success) {
    return NextResponse.json({ error: "Invalid payload", details: parsedInput.error.flatten() }, { status: 400 });
  }

  const runId = randomUUID();
  const normalized = await parseAndRoute(parsedInput.data.items);

  if (normalized.normalized_items.length === 0) {
    return NextResponse.json({ error: "No valid items in request" }, { status: 400 });
  }

  const service = createSupabaseServiceClient();

  await service.from("quote_runs").insert({
    id: runId,
    user_id: user.id,
    input_type: parsedInput.data.input_type,
    raw_input: JSON.stringify(parsedInput.data.items),
    category: normalized.category,
    site_plan: normalized.site_plan,
    status: "running"
  });

  const origin = process.env.APP_BASE_URL ?? new URL(request.url).origin;
  const rustResponse = await fetch(`${origin}/api/quote_stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      run_id: runId,
      items: normalized.normalized_items,
      category: normalized.category,
      site_plan: normalized.site_plan,
      options: {
        cache_ttl: Number(process.env.CACHE_TTL_SECONDS ?? "0")
      }
    })
  });

  if (!rustResponse.ok || !rustResponse.body) {
    await service.from("quote_runs").update({ status: "error" }).eq("id", runId);
    return NextResponse.json({ error: "Quote stream failed", status: rustResponse.status }, { status: 502 });
  }

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encoder.encode(toNdjson({ type: "started", run_id: runId, started_at: new Date().toISOString() })));

      const reader = rustResponse.body!.getReader();
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

            if (parsed.type === "match") {
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

            if (parsed.type === "done") {
              await service
                .from("quote_runs")
                .update({ status: "done", duration_ms: parsed.duration_ms })
                .eq("id", runId)
                .eq("user_id", user.id);
            }

            if (parsed.type === "error") {
              await service.from("quote_runs").update({ status: "error" }).eq("id", runId).eq("user_id", user.id);
            }

            controller.enqueue(encoder.encode(toNdjson(parsed)));
          }
        }
      } catch (error) {
        await service.from("quote_runs").update({ status: "error" }).eq("id", runId).eq("user_id", user.id);
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
