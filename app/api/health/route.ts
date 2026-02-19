import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const secret = new URL(request.url).searchParams.get("secret");

  if (!secret || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const origin = process.env.APP_BASE_URL ?? new URL(request.url).origin;
  const response = await fetch(`${origin}/api/project-plan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      project_input: "build a simple garage storage shelf",
      csv_input: "item,qty\n2x4 studs,8\nplywood sheet,2",
      budget_target: 400
    })
  });

  if (!response.ok) {
    return NextResponse.json({ ok: false, status: response.status }, { status: 500 });
  }

  const json = await response.json();
  const title = json?.blueprint?.title ?? "unknown";
  const phaseCount = Array.isArray(json?.blueprint?.phases) ? json.blueprint.phases.length : 0;
  return NextResponse.json({ ok: true, source: json?.source ?? "unknown", title, phase_count: phaseCount });
}
