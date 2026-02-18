import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase-server";
import { createSupabaseServiceClient } from "@/lib/supabase-service";

function safeUrl(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (!["http:", "https:"].includes(u.protocol)) return null;
    return u.toString();
  } catch {
    return null;
  }
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const target = safeUrl(url.searchParams.get("target"));
  const site = url.searchParams.get("site") ?? "unknown";
  const action = url.searchParams.get("action") === "open_result" ? "open_result" : "open_listing";
  const runId = url.searchParams.get("run_id");
  const query = url.searchParams.get("query");

  if (!target) {
    return NextResponse.redirect(new URL("/", url.origin));
  }

  try {
    const supabase = await createSupabaseServerClient();
    const {
      data: { user }
    } = await supabase.auth.getUser();

    const service = createSupabaseServiceClient();

    await service.from("quote_interactions").insert({
      run_id: runId,
      user_id: user?.id ?? null,
      action,
      site,
      query,
      target_url: target
    });

    const field = action === "open_result" ? "open_result_count" : "open_listing_count";
    const { data: current } = await service
      .from("site_catalog")
      .select("click_count, open_result_count, open_listing_count")
      .eq("site", site)
      .maybeSingle();

    await service
      .from("site_catalog")
      .update({
        click_count: (current?.click_count ?? 0) + 1,
        open_result_count: (current?.open_result_count ?? 0) + (field === "open_result_count" ? 1 : 0),
        open_listing_count: (current?.open_listing_count ?? 0) + (field === "open_listing_count" ? 1 : 0),
        last_seen_at: new Date().toISOString()
      })
      .eq("site", site);
  } catch {
    // Non-blocking tracking.
  }

  return NextResponse.redirect(target);
}
