import Link from "next/link";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase-server";

export default async function DashboardPage() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const { data: runs } = await supabase
    .from("quote_runs")
    .select("id, created_at, status, category, duration_ms")
    .order("created_at", { ascending: false })
    .limit(10);

  return (
    <main className="container grid" style={{ gap: 16 }}>
      <header className="row" style={{ justifyContent: "space-between" }}>
        <h1>SupplyFlare Dashboard</h1>
        <div className="row">
          <Link href="/">New Quote</Link>
          <Link href="/app/history">History</Link>
        </div>
      </header>

      <section className="panel grid">
        <p>Logged in as {user.email}</p>
        <h2>Recent Runs</h2>
        {runs?.length ? (
          runs.map((run) => (
            <div key={run.id} className="panel" style={{ padding: 10 }}>
              <div>{run.id}</div>
              <div className="small">{run.category} | {run.status} | {run.duration_ms ?? 0}ms</div>
            </div>
          ))
        ) : (
          <p className="small">No runs yet.</p>
        )}
      </section>
    </main>
  );
}
