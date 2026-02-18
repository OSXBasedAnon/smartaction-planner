import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase-server";
import { createSupabaseServiceClient } from "@/lib/supabase-service";

export async function GET() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ logged_in: false, runs: [] });
  }

  const { data: runs, error } = await supabase
    .from("quote_runs")
    .select("id, raw_input, created_at, status, duration_ms")
    .order("created_at", { ascending: false })
    .limit(20);

  if (error) {
    return NextResponse.json({ logged_in: true, runs: [], error: error.message }, { status: 500 });
  }

  return NextResponse.json({ logged_in: true, runs: runs ?? [] });
}

export async function DELETE(request: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { run_id } = (await request.json()) as { run_id?: string };
  if (!run_id) {
    return NextResponse.json({ error: "run_id required" }, { status: 400 });
  }

  const service = createSupabaseServiceClient();
  const { error } = await service.from("quote_runs").delete().eq("id", run_id).eq("user_id", user.id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
