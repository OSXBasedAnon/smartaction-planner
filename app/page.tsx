"use client";

import { useMemo, useRef, useState } from "react";
import type { ProjectBlueprint } from "@/lib/project-blueprint";

type PlanResponse = {
  source: "gemini" | "fallback";
  blueprint: ProjectBlueprint;
};

type EditableMaterial = ProjectBlueprint["materials"][number] & { checked: boolean };
type EditableTool = ProjectBlueprint["tools"][number];

function money(value: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 0 }).format(value);
}

function toCsvRows(csv: string): string[] {
  return csv
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 150);
}

function inferComplexityLabel(level: ProjectBlueprint["complexity"]) {
  if (level === "advanced") return "Advanced";
  if (level === "moderate") return "Moderate";
  return "Simple";
}

function nodeColor(kind: "start" | "task" | "decision" | "finish") {
  if (kind === "start") return "var(--node-start)";
  if (kind === "decision") return "var(--node-decision)";
  if (kind === "finish") return "var(--node-finish)";
  return "var(--node-task)";
}

function toMaterialRows(materials: ProjectBlueprint["materials"]): EditableMaterial[] {
  return materials.map((item) => ({ ...item, checked: false }));
}

export default function LandingPage() {
  const [projectInput, setProjectInput] = useState("rewire my basement with 8 outlets and better lighting");
  const [csvInput, setCsvInput] = useState("");
  const [budgetTarget, setBudgetTarget] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState<"gemini" | "fallback" | null>(null);
  const [blueprint, setBlueprint] = useState<ProjectBlueprint | null>(null);
  const [materials, setMaterials] = useState<EditableMaterial[]>([]);
  const [tools, setTools] = useState<EditableTool[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  const csvRows = useMemo(() => toCsvRows(csvInput), [csvInput]);
  const totalMaterialLow = useMemo(() => materials.reduce((acc, item) => acc + item.est_cost_low, 0), [materials]);
  const totalMaterialHigh = useMemo(() => materials.reduce((acc, item) => acc + item.est_cost_high, 0), [materials]);
  const totalToolCost = useMemo(
    () => tools.reduce((acc, item) => acc + (item.rent_or_buy === "rent" ? item.est_cost * 0.4 : item.est_cost), 0),
    [tools]
  );
  const checkedCount = useMemo(() => materials.filter((item) => item.checked).length, [materials]);

  async function runPlan() {
    const trimmed = projectInput.trim();
    if (trimmed.length < 3) {
      setError("Please enter a project goal first.");
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const response = await fetch("/api/project-plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project_input: trimmed,
          csv_input: csvInput,
          budget_target: budgetTarget.length > 0 ? Number(budgetTarget) : undefined
        })
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { message?: string } | null;
        throw new Error(payload?.message ?? `Plan request failed (${response.status})`);
      }

      const data = (await response.json()) as PlanResponse;
      setSource(data.source);
      setBlueprint(data.blueprint);
      setMaterials(toMaterialRows(data.blueprint.materials));
      setTools(data.blueprint.tools);
    } catch (planError) {
      setError(planError instanceof Error ? planError.message : "Failed to generate plan.");
    } finally {
      setLoading(false);
    }
  }

  async function handleFile(file: File) {
    const text = await file.text();
    setCsvInput(text);
  }

  function updateMaterial(id: string, patch: Partial<EditableMaterial>) {
    setMaterials((prev) => prev.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  }

  function updateTool(id: string, patch: Partial<EditableTool>) {
    setTools((prev) => prev.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  }

  const chartMax = blueprint?.cost_breakdown.reduce((max, bucket) => Math.max(max, bucket.value), 1) ?? 1;

  return (
    <main className="planner-root">
      <div className="hero-bg" />

      <section className="top-shell">
        <header className="top-bar">
          <div>
            <p className="eyebrow">SupplyFlare Project Agent</p>
            <h1>Turn Any Idea Into a DIY Blueprint</h1>
            <p className="subtle">Describe any project, paste CSVs, and get a live workflow + editable shopping list.</p>
          </div>
          <div className="status-chip">{source ? `Model: ${source}` : "Ready"}</div>
        </header>

        <div className="intake-grid">
          <label className="field">
            <span>Project Goal</span>
            <textarea
              value={projectInput}
              onChange={(event) => setProjectInput(event.target.value)}
              placeholder="Example: remodel kitchen with budget finishes and keep existing plumbing footprint"
            />
          </label>

          <label className="field">
            <span>CSV / Existing List (optional)</span>
            <textarea
              value={csvInput}
              onChange={(event) => setCsvInput(event.target.value)}
              placeholder="item,qty,notes"
            />
          </label>
        </div>

        <div className="controls-row">
          <label className="budget-pill">
            Budget Target
            <input
              value={budgetTarget}
              onChange={(event) => setBudgetTarget(event.target.value.replace(/[^\d.]/g, ""))}
              placeholder="1500"
              inputMode="decimal"
            />
          </label>
          <button type="button" className="ghost-btn" onClick={() => fileRef.current?.click()}>
            Upload CSV
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            style={{ display: "none" }}
            onChange={async (event) => {
              const file = event.target.files?.[0];
              if (!file) return;
              await handleFile(file);
            }}
          />
          <button type="button" className="primary-btn" onClick={() => void runPlan()} disabled={loading}>
            {loading ? "Building Blueprint..." : "Generate Blueprint"}
          </button>
        </div>

        {error ? <p className="error-line">{error}</p> : null}
        {csvRows.length > 0 ? <p className="meta-line">{csvRows.length} CSV rows attached for agentic inference.</p> : null}
      </section>

      <section className="workspace">
        <div className="left-pane">
          {!blueprint ? (
            <article className="panel-card empty-card">
              <h2>What you get</h2>
              <ul>
                <li>Sequenced workflow with checkpoints and warnings</li>
                <li>Visual flow map for action order</li>
                <li>Editable materials and tool list with budget ranges</li>
                <li>Agent fill-ins for unknown gaps</li>
              </ul>
            </article>
          ) : (
            <>
              <article className="panel-card summary-card">
                <div className="row-split">
                  <div>
                    <p className="eyebrow">Blueprint</p>
                    <h2>{blueprint.title}</h2>
                    <p>{blueprint.objective}</p>
                  </div>
                  <div className="badge-stack">
                    <span>{inferComplexityLabel(blueprint.complexity)}</span>
                    <span>{money(blueprint.budget.low, blueprint.budget.currency)} - {money(blueprint.budget.high, blueprint.budget.currency)}</span>
                    <span>{blueprint.timeline.total_estimated_hours}h estimate</span>
                  </div>
                </div>
                <div className="chips">
                  {blueprint.assumptions.map((assumption) => (
                    <span key={assumption} className="chip">{assumption}</span>
                  ))}
                </div>
              </article>

              <article className="panel-card">
                <h3>Workflow Diagram</h3>
                <div className="diagram-scroll">
                  <svg viewBox="0 0 920 180" className="diagram-svg" role="img" aria-label="Workflow map">
                    {blueprint.diagram.nodes.map((node, index) => {
                      const x = 70 + index * 170;
                      const y = 90;
                      return (
                        <g key={node.id}>
                          <rect x={x} y={y - 30} width={140} height={60} rx={18} fill={nodeColor(node.kind)} />
                          <text x={x + 70} y={y + 4} textAnchor="middle" className="diagram-label">
                            {node.label.slice(0, 18)}
                          </text>
                        </g>
                      );
                    })}
                    {blueprint.diagram.edges.map((edge) => {
                      const fromIndex = blueprint.diagram.nodes.findIndex((node) => node.id === edge.from);
                      const toIndex = blueprint.diagram.nodes.findIndex((node) => node.id === edge.to);
                      if (fromIndex < 0 || toIndex < 0) return null;
                      const x1 = 70 + fromIndex * 170 + 140;
                      const x2 = 70 + toIndex * 170;
                      return (
                        <g key={`${edge.from}-${edge.to}-${edge.label}`}>
                          <line x1={x1} y1={90} x2={x2} y2={90} stroke="var(--line)" strokeWidth="3" />
                          {edge.label ? (
                            <text x={(x1 + x2) / 2} y={74} textAnchor="middle" className="diagram-edge">
                              {edge.label}
                            </text>
                          ) : null}
                        </g>
                      );
                    })}
                  </svg>
                </div>
              </article>

              <article className="panel-card">
                <h3>Step Workflow</h3>
                <div className="phase-list">
                  {blueprint.phases.map((phase) => (
                    <section key={phase.id} className="phase-card">
                      <div className="row-split">
                        <h4>{phase.name}</h4>
                        <span>{phase.duration_hours}h</span>
                      </div>
                      <p>{phase.goal}</p>
                      {phase.steps.map((step) => (
                        <article key={step.id} className="step-row">
                          <strong>{step.title}</strong>
                          <p>{step.details}</p>
                          <p className="muted">Checkpoint: {step.checkpoint}</p>
                          {step.warning ? <p className="warn">Warning: {step.warning}</p> : null}
                        </article>
                      ))}
                    </section>
                  ))}
                </div>
              </article>

              <article className="panel-card dual-grid">
                <div>
                  <h3>Cost Split</h3>
                  <div className="bars">
                    {blueprint.cost_breakdown.map((bucket) => (
                      <div key={bucket.label} className="bar-row">
                        <span>{bucket.label}</span>
                        <div className="bar-track">
                          <div className="bar-fill" style={{ width: `${Math.max(8, (bucket.value / chartMax) * 100)}%` }} />
                        </div>
                        <span>{money(bucket.value, blueprint.budget.currency)}</span>
                      </div>
                    ))}
                  </div>
                </div>

                <div>
                  <h3>Field Tips</h3>
                  <div className="tip-list">
                    {blueprint.tips.map((tip) => (
                      <article key={tip.id} className="tip-card">
                        <strong>{tip.title}</strong>
                        <p>{tip.detail}</p>
                      </article>
                    ))}
                  </div>
                </div>
              </article>

              <article className="panel-card dual-grid">
                <div>
                  <h3>Safety Notes</h3>
                  <ul className="basic-list">
                    {blueprint.safety_notes.map((note) => (
                      <li key={note}>{note}</li>
                    ))}
                  </ul>
                </div>
                <div>
                  <h3>Agent Fill-ins</h3>
                  <ul className="basic-list">
                    {blueprint.agent_fill_ins.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </div>
              </article>
            </>
          )}
        </div>

        <aside className="right-pane">
          <article className="rail-card">
            <div className="row-split">
              <h3>Materials List</h3>
              <span>{checkedCount}/{materials.length} checked</span>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Done</th>
                    <th>Item</th>
                    <th>Qty</th>
                    <th>Low</th>
                    <th>High</th>
                  </tr>
                </thead>
                <tbody>
                  {materials.map((item) => (
                    <tr key={item.id}>
                      <td>
                        <input type="checkbox" checked={item.checked} onChange={(event) => updateMaterial(item.id, { checked: event.target.checked })} />
                      </td>
                      <td>
                        <input value={item.name} onChange={(event) => updateMaterial(item.id, { name: event.target.value })} />
                        <small>{item.spec}</small>
                      </td>
                      <td>
                        <input
                          value={item.qty}
                          inputMode="decimal"
                          onChange={(event) => updateMaterial(item.id, { qty: Number(event.target.value || "0") })}
                        />
                      </td>
                      <td>
                        <input
                          value={item.est_cost_low}
                          inputMode="decimal"
                          onChange={(event) => updateMaterial(item.id, { est_cost_low: Number(event.target.value || "0") })}
                        />
                      </td>
                      <td>
                        <input
                          value={item.est_cost_high}
                          inputMode="decimal"
                          onChange={(event) => updateMaterial(item.id, { est_cost_high: Number(event.target.value || "0") })}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </article>

          <article className="rail-card">
            <h3>Tools</h3>
            <div className="tool-list">
              {tools.map((tool) => (
                <div className="tool-row" key={tool.id}>
                  <input type="text" value={tool.name} onChange={(event) => updateTool(tool.id, { name: event.target.value })} />
                  <select value={tool.rent_or_buy} onChange={(event) => updateTool(tool.id, { rent_or_buy: event.target.value as EditableTool["rent_or_buy"] })}>
                    <option value="own">Own</option>
                    <option value="rent">Rent</option>
                    <option value="buy">Buy</option>
                  </select>
                  <input
                    value={tool.est_cost}
                    inputMode="decimal"
                    onChange={(event) => updateTool(tool.id, { est_cost: Number(event.target.value || "0") })}
                  />
                </div>
              ))}
            </div>
          </article>

          <article className="rail-card total-card">
            <h3>Live Totals</h3>
            <p>Materials: {money(totalMaterialLow)} - {money(totalMaterialHigh)}</p>
            <p>Tools: {money(totalToolCost)}</p>
            <p className="grand">
              Total: {money(totalMaterialLow + totalToolCost)} - {money(totalMaterialHigh + totalToolCost)}
            </p>
            {blueprint ? <p className="confidence">Plan confidence: {(blueprint.confidence * 100).toFixed(0)}%</p> : null}
          </article>

          {blueprint ? (
            <article className="rail-card">
              <h3>Common Questions</h3>
              {blueprint.qa.map((item) => (
                <details key={item.question}>
                  <summary>{item.question}</summary>
                  <p>{item.answer}</p>
                </details>
              ))}
            </article>
          ) : null}
        </aside>
      </section>
    </main>
  );
}
