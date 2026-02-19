import Link from "next/link";

export default function AppPage() {
  return (
    <main className="planner-root">
      <section className="panel-card" style={{ maxWidth: 760, margin: "40px auto" }}>
        <p className="eyebrow">SupplyFlare</p>
        <h1>Project Blueprint Workspace</h1>
        <p style={{ color: "var(--ink-soft)" }}>
          The old quote dashboard has been retired. Use the new project planner to generate workflows, diagrams, and editable material lists.
        </p>
        <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
          <Link href="/" className="primary-btn">
            Open Planner
          </Link>
          <Link href="/app/history" className="ghost-btn">
            View Notes
          </Link>
        </div>
      </section>
    </main>
  );
}
