"use client";

import { useMemo, useRef, useState } from "react";
import type { ProjectBlueprint } from "@/lib/project-blueprint";

type PlanResponse = {
  source: "gemini" | "fallback";
  blueprint: ProjectBlueprint;
};

type EditableMaterial = ProjectBlueprint["materials"][number] & { checked: boolean; unit_cost: number };
type EditableTool = ProjectBlueprint["tools"][number] & { owned: boolean };

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
  return materials.map((item) => ({
    ...item,
    checked: false,
    unit_cost: item.qty > 0 ? item.est_cost / item.qty : item.est_cost
  }));
}

function toToolRows(tools: ProjectBlueprint["tools"]): EditableTool[] {
  return tools.map((tool) => ({ ...tool, owned: false }));
}

function labelLines(text: string): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= 2) return [text];
  const mid = Math.ceil(words.length / 2);
  return [words.slice(0, mid).join(" "), words.slice(mid).join(" ")];
}

export default function LandingPage() {
  const [projectInput, setProjectInput] = useState("rewire my basement with 8 outlets and better lighting");
  const [csvInput, setCsvInput] = useState("");
  const [budgetTarget, setBudgetTarget] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [blueprint, setBlueprint] = useState<ProjectBlueprint | null>(null);
  const [materials, setMaterials] = useState<EditableMaterial[]>([]);
  const [tools, setTools] = useState<EditableTool[]>([]);
  const [copied, setCopied] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const csvRows = useMemo(() => toCsvRows(csvInput), [csvInput]);
  const totalMaterial = useMemo(() => materials.reduce((acc, item) => acc + item.est_cost, 0), [materials]);
  const remainingMaterialCost = useMemo(
    () => materials.filter((item) => !item.checked).reduce((acc, item) => acc + item.est_cost, 0),
    [materials]
  );
  const totalToolCost = useMemo(
    () => tools.reduce((acc, item) => acc + (item.owned ? 0 : item.est_cost), 0),
    [tools]
  );
  const checkedCount = useMemo(() => materials.filter((item) => item.checked).length, [materials]);
  const ownedCount = useMemo(() => tools.filter((tool) => tool.owned).length, [tools]);

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
      setBlueprint(data.blueprint);
      setMaterials(toMaterialRows(data.blueprint.materials));
      setTools(toToolRows(data.blueprint.tools));
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

  function updateMaterialQty(id: string, qtyRaw: string) {
    const qty = Math.max(0, Number(qtyRaw || "0"));
    setMaterials((prev) =>
      prev.map((item) => {
        if (item.id !== id) return item;
        const est = Math.round((item.unit_cost * qty + Number.EPSILON) * 100) / 100;
        return { ...item, qty, est_cost: est };
      })
    );
  }

  function updateMaterialEst(id: string, estRaw: string) {
    const estCost = Math.max(0, Number(estRaw || "0"));
    setMaterials((prev) =>
      prev.map((item) => {
        if (item.id !== id) return item;
        const unitCost = item.qty > 0 ? estCost / item.qty : estCost;
        return { ...item, est_cost: estCost, unit_cost: unitCost };
      })
    );
  }

  async function copyMaterialList() {
    if (materials.length === 0) return;
    const lines = materials.map((item) => `- ${item.name} | ${item.qty} ${item.unit} | Est ${money(item.est_cost)}`);
    const payload = ["SupplyFlare Materials List", ...lines].join("\n");
    await navigator.clipboard.writeText(payload);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  const chartMax = blueprint?.cost_breakdown.reduce((max, bucket) => Math.max(max, bucket.value), 1) ?? 1;
  const diagramNodes = useMemo(() => {
    const phaseOne = blueprint?.phases[0]?.name ?? "Scope";
    const phaseTwo = blueprint?.phases[1]?.name ?? "Procure";
    const phaseThree = blueprint?.phases[2]?.name ?? "Execute";
    return [
      { id: "d1", label: "Project Input", kind: "start" as const, x: 20, y: 82 },
      { id: "d2", label: phaseOne, kind: "task" as const, x: 150, y: 24 },
      { id: "d3", label: "Code + Safety", kind: "decision" as const, x: 300, y: 24 },
      { id: "d4", label: phaseTwo, kind: "task" as const, x: 300, y: 140 },
      { id: "d5", label: phaseThree, kind: "task" as const, x: 450, y: 140 },
      { id: "d6", label: "Final QA", kind: "finish" as const, x: 580, y: 82 }
    ];
  }, [blueprint]);
  const diagramNodeMap = useMemo(
    () => new Map(diagramNodes.map((node) => [node.id, node])),
    [diagramNodes]
  );
  const diagramEdges = [
    { from: "d1", to: "d2", label: "" },
    { from: "d2", to: "d3", label: "" },
    { from: "d3", to: "d4", label: "pass" },
    { from: "d4", to: "d5", label: "" },
    { from: "d5", to: "d6", label: "" }
  ];

  return (
    <main className="planner-root">
      <div className="hero-bg" />

      <section className="top-shell">
        <header className="top-bar">
          <div className="brand-lockup">
            <span>SupplyFlare</span>
            <img src="/logo.svg" alt="SupplyFlare logo" />
          </div>
        </header>

        <div className="headline-wrap">
          <p className="eyebrow">Project Blueprint Agent</p>
          <h1>Type Any Project. Get a Smart Action Plan + Supply List.</h1>
          <p className="subtle">Project Blueprint Agent</p>
        </div>

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
              <h2>What You Get</h2>
              <ul>
                <li>Sequenced workflow with checkpoints and warnings</li>
                <li>Non-linear visual flow map and decisions</li>
                <li>Editable materials list with estimated costs</li>
                <li>Tool checklist with ownership-aware totals</li>
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
                    <span>{money(blueprint.budget.mid, blueprint.budget.currency)} estimated midpoint</span>
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
                  <svg viewBox="0 0 716 220" className="diagram-svg" role="img" aria-label="Workflow map">
                    <defs>
                      <marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto-start-reverse">
                        <path d="M 0 0 L 8 4 L 0 8 z" fill="#2f6150" />
                      </marker>
                    </defs>
                    {diagramEdges.map((edge) => {
                      const from = diagramNodeMap.get(edge.from);
                      const to = diagramNodeMap.get(edge.to);
                      if (!from || !to) return null;
                      const x1 = from.x + 112;
                      const y1 = from.y + 28;
                      const x2 = to.x;
                      const y2 = to.y + 28;
                      const c1x = x1 + (x2 - x1) * 0.33;
                      const c1y = y1;
                      const c2x = x1 + (x2 - x1) * 0.66;
                      const c2y = y2;
                      return (
                        <g key={`${edge.from}-${edge.to}-${edge.label}`}>
                          <path
                            d={`M ${x1} ${y1} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${x2} ${y2}`}
                            stroke="var(--line-strong)"
                            strokeWidth="2.5"
                            fill="none"
                            markerEnd="url(#arrow)"
                          />
                          {edge.label ? (
                            <text x={(x1 + x2) / 2} y={Math.min(y1, y2) - 8} textAnchor="middle" className="diagram-edge">
                              {edge.label}
                            </text>
                          ) : null}
                        </g>
                      );
                    })}
                    {diagramNodes.map((node) => {
                      const lines = labelLines(node.label);
                      return (
                        <g key={node.id}>
                          <rect x={node.x} y={node.y} width={112} height={56} rx={16} fill={nodeColor(node.kind)} stroke="#7bb49c" />
                          <text x={node.x + 56} y={node.y + 24} textAnchor="middle" className="diagram-label">
                            {lines.map((line, idx) => (
                              <tspan key={line} x={node.x + 56} dy={idx === 0 ? 0 : 14}>
                                {line}
                              </tspan>
                            ))}
                          </text>
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
              <h3>Supply List</h3>
              <span>{checkedCount}/{materials.length} checked</span>
            </div>
            <div className="actions-row">
              <button type="button" className="ghost-btn small-btn" onClick={() => void copyMaterialList()}>
                {copied ? "Copied" : "Copy List"}
              </button>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Done</th>
                    <th>Item</th>
                    <th>Qty</th>
                    <th>Est</th>
                  </tr>
                </thead>
                <tbody>
                  {materials.map((item) => (
                    <tr key={item.id}>
                      <td>
                        <input type="checkbox" checked={item.checked} onChange={(event) => updateMaterial(item.id, { checked: event.target.checked })} />
                      </td>
                      <td className="item-cell">
                        <input value={item.name} onChange={(event) => updateMaterial(item.id, { name: event.target.value })} />
                        <small>{item.spec}</small>
                      </td>
                      <td>
                        <input
                          value={item.qty}
                          inputMode="decimal"
                          onChange={(event) => updateMaterialQty(item.id, event.target.value)}
                        />
                      </td>
                      <td>
                        <div className="money-input">
                          <span>$</span>
                          <input
                            value={item.est_cost}
                            inputMode="decimal"
                            onChange={(event) => updateMaterialEst(item.id, event.target.value)}
                          />
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </article>

          <article className="rail-card">
            <div className="row-split">
              <h3>Tools Checklist</h3>
              <span>{ownedCount}/{tools.length} owned</span>
            </div>
            <div className="tool-list">
              {tools.map((tool) => (
                <label className="tool-check" key={tool.id}>
                  <div>
                    <input type="text" value={tool.name} onChange={(event) => updateTool(tool.id, { name: event.target.value })} />
                    <small>{tool.purpose}</small>
                  </div>
                  <label className="own-toggle">
                    <input type="checkbox" checked={tool.owned} onChange={(event) => updateTool(tool.id, { owned: event.target.checked })} />
                    <span>Owned</span>
                  </label>
                  <div className="tool-money">{money(tool.est_cost)}</div>
                </label>
              ))}
            </div>
          </article>

          <article className="rail-card total-card">
            <h3>Live Totals</h3>
            <p>Materials: {money(totalMaterial)}</p>
            <p>Remaining materials cost: {money(remainingMaterialCost)}</p>
            <p>Tools (excluding owned): {money(totalToolCost)}</p>
            <p className="grand">Total Est: {money(totalMaterial + totalToolCost)}</p>
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
