import Link from "next/link";

export default function HistoryPage() {
  return (
    <main className="planner-root">
      <section className="panel-card" style={{ maxWidth: 760, margin: "40px auto", display: "grid", gap: 10 }}>
        <p className="eyebrow">SupplyFlare Notes</p>
        <h1>Legacy History Is Disabled</h1>
        <p style={{ color: "var(--ink-soft)" }}>
          This refactor removed quote scraping history. Next phase is saving blueprint sessions and editable revisions.
        </p>
        <Link href="/" className="primary-btn" style={{ width: "fit-content" }}>
          Back to Planner
        </Link>
      </section>
    </main>
  );
}
