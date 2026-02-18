import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const secret = new URL(request.url).searchParams.get("secret");

  if (!secret || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const origin = process.env.APP_BASE_URL ?? new URL(request.url).origin;
  const response = await fetch(`${origin}/api/quote`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      items: [{ query: "paper towels 2 ply", qty: 1 }],
      category: "office",
      site_plan: ["staples", "amazon_business"],
      options: { cache_ttl: 0 }
    })
  });

  if (!response.ok) {
    return NextResponse.json({ ok: false, status: response.status }, { status: 500 });
  }

  const json = await response.json();
  return NextResponse.json({ ok: true, run_id: json.run_id, duration_ms: json.duration_ms });
}
