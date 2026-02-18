import Link from "next/link";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase-server";

export default async function HistoryPage() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const { data: runs } = await supabase
    .from("quote_runs")
    .select("id, created_at, raw_input, category, status, duration_ms")
    .order("created_at", { ascending: false })
    .limit(50);

  return (
    <main className="container grid" style={{ gap: 12 }}>
      <header className="row" style={{ justifyContent: "space-between" }}>
        <h1>Quote History</h1>
        <Link href="/app">Back</Link>
      </header>

      <p className="small">Pricing may exclude shipping/tax. Results can be partial if sites are blocked.</p>

      {runs?.map((run) => (
        <article key={run.id} className="panel grid" style={{ gap: 6 }}>
          <strong>{run.id}</strong>
          <span className="small">{run.created_at}</span>
          <span>{run.raw_input}</span>
          <span className="small">{run.category} | {run.status} | {run.duration_ms ?? 0}ms</span>
        </article>
      ))}

      {!runs?.length ? <p className="small">No history yet.</p> : null}
    </main>
  );
}
