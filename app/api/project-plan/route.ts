import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { intakeSchema, parsePossiblyWrappedJson, projectBlueprintSchema } from "@/lib/project-blueprint";

const GEMINI_MODEL = "gemini-2.0-flash";
const ALLOW_EMERGENCY_HEURISTIC_FALLBACK = (process.env.ALLOW_PLANNER_FALLBACK ?? "false").toLowerCase() === "true";

const SCHEMA_SHAPE = `{
  "title": "string",
  "objective": "string",
  "complexity": "simple|moderate|advanced",
  "assumptions": ["string"],
  "safety_notes": ["string"],
  "timeline": {
    "total_estimated_hours": 0,
    "suggested_days_min": 0,
    "suggested_days_max": 0
  },
  "budget": { "currency": "USD", "low": 0, "mid": 0, "high": 0 },
  "phases": [
    {
      "id": "string",
      "name": "string",
      "goal": "string",
      "duration_hours": 0,
      "steps": [
        {
          "id": "string",
          "title": "string",
          "details": "string",
          "checkpoint": "string",
          "warning": "string"
        }
      ],
      "deliverables": ["string"]
    }
  ],
  "diagram": {
    "nodes": [
      { "id": "string", "label": "string", "kind": "start|task|decision|finish" }
    ],
    "edges": [
      { "from": "string", "to": "string", "label": "string" }
    ]
  },
  "materials": [
    {
      "id": "string",
      "name": "string",
      "spec": "string",
      "qty": 0,
      "unit": "string",
      "category": "string",
      "priority": "critical|recommended|optional",
      "est_cost": 0,
      "notes": "string",
      "alternatives": ["string"]
    }
  ],
  "tools": [
    { "id": "string", "name": "string", "purpose": "string", "est_cost": 0 }
  ],
  "cost_breakdown": [{ "label": "string", "value": 0 }],
  "tips": [{ "id": "string", "title": "string", "detail": "string" }],
  "qa": [{ "question": "string", "answer": "string" }],
  "agent_fill_ins": ["string"],
  "confidence": 0
}`;

function buildGenerationPrompt(projectInput: string, csvInput: string, budgetTarget?: number) {
  return [
    "You are SupplyFlare Project Agent.",
    "Return JSON only. No markdown, no extra commentary.",
    "Generate a practical project plan for any user request, including unpredictable requests.",
    "Do not rely on rigid categories; infer task-specific materials/tools/workflow from context.",
    "If project is mostly organization/planning, it is valid for budget/materials to be near zero.",
    "If costs are unknown, provide reasonable estimates with transparent assumptions.",
    "Never return placeholder names like 'Item 1' or 'Tool 1'.",
    "All required keys must be present using the schema shape below.",
    SCHEMA_SHAPE,
    `project_input=${projectInput}`,
    `csv_input=${csvInput || "none"}`,
    `budget_target=${typeof budgetTarget === "number" ? budgetTarget : "none"}`
  ].join("\n");
}

function buildRepairPrompt(projectInput: string, previousOutput: string) {
  return [
    "Your previous output failed schema validation.",
    "Return corrected JSON only. No markdown.",
    "Keep intent of original project, but fix required fields/types.",
    "Do not use placeholders like Item 1 / Tool 1.",
    SCHEMA_SHAPE,
    `project_input=${projectInput}`,
    `previous_output=${previousOutput}`
  ].join("\n");
}

async function callGemini(prompt: string) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("gemini_api_key_missing");

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.2,
          topP: 0.9,
          responseMimeType: "application/json"
        }
      })
    }
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`gemini_request_failed_${response.status}:${body.slice(0, 280)}`);
  }

  const payload = await response.json();
  const text = payload?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text || typeof text !== "string") throw new Error("gemini_empty_response");
  return text;
}

function unwrapBlueprint(raw: unknown) {
  if (raw && typeof raw === "object" && "blueprint" in raw) {
    const nested = (raw as Record<string, unknown>).blueprint;
    if (nested && typeof nested === "object") return nested;
  }
  return raw;
}

function toNumber(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toStringList(value: unknown, fallback: string[]) {
  if (!Array.isArray(value)) return fallback;
  const normalized = value.map((v) => String(v).trim()).filter((v) => v.length > 0);
  return normalized.length > 0 ? normalized : fallback;
}

function parseCsvItems(csvInput: string) {
  return csvInput
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line, index) => {
      const [nameRaw, qtyRaw] = line.split(",").map((part) => part.trim());
      const name = nameRaw || `Imported item ${index + 1}`;
      const qty = Math.max(1, toNumber(qtyRaw, 1));
      return {
        id: `csv_${index + 1}`,
        name,
        spec: "Imported from existing list",
        qty,
        unit: "pcs",
        category: "imported",
        priority: "recommended" as const,
        est_cost: 25 * qty,
        notes: "",
        alternatives: []
      };
    });
}

function neutralBlueprint(projectInput: string, csvInput: string, budgetTarget?: number) {
  const imported = parseCsvItems(csvInput);
  const mid = typeof budgetTarget === "number" ? budgetTarget : 900;
  const low = Math.max(0, Math.round(mid * 0.65));
  const high = Math.round(mid * 1.35);

  return {
    title: `${projectInput.trim() || "Project"} Plan`,
    objective: `Plan and execute: ${projectInput.trim() || "user-requested project"}`,
    complexity: "moderate" as const,
    assumptions: [
      "Estimates are approximate and should be validated before purchase.",
      "Scope can change based on site conditions.",
      "Quantities include a small safety margin."
    ],
    safety_notes: ["Use task-appropriate PPE and follow local safety/code requirements."],
    timeline: {
      total_estimated_hours: 8,
      suggested_days_min: 1,
      suggested_days_max: 3
    },
    budget: { currency: "USD", low, mid, high },
    phases: [
      {
        id: "p1",
        name: "Scope and planning",
        goal: "Clarify project deliverables and constraints.",
        duration_hours: 2,
        steps: [
          { id: "p1s1", title: "Define scope", details: "Confirm success criteria and constraints.", checkpoint: "Scope confirmed", warning: "" }
        ],
        deliverables: ["Scope brief"]
      },
      {
        id: "p2",
        name: "Procurement and prep",
        goal: "Prepare tools/materials and site readiness.",
        duration_hours: 2,
        steps: [
          { id: "p2s1", title: "Prepare supplies", details: "Finalize supply/tool list and alternatives.", checkpoint: "Supplies ready", warning: "" }
        ],
        deliverables: ["Supply list"]
      },
      {
        id: "p3",
        name: "Execution and closeout",
        goal: "Run tasks and verify outcomes.",
        duration_hours: 4,
        steps: [
          { id: "p3s1", title: "Execute", details: "Complete core tasks and verify quality.", checkpoint: "Project closed", warning: "" }
        ],
        deliverables: ["Completion checklist"]
      }
    ],
    diagram: {
      nodes: [
        { id: "d1", label: "Input", kind: "start" as const },
        { id: "d2", label: "Plan", kind: "task" as const },
        { id: "d3", label: "Prep", kind: "task" as const },
        { id: "d4", label: "Execute", kind: "finish" as const }
      ],
      edges: [
        { from: "d1", to: "d2", label: "" },
        { from: "d2", to: "d3", label: "" },
        { from: "d3", to: "d4", label: "" }
      ]
    },
    materials: imported,
    tools: [],
    cost_breakdown: [
      { label: "Materials", value: Math.round(low * 0.55) },
      { label: "Tools", value: Math.round(low * 0.2) },
      { label: "Buffer", value: Math.round(low * 0.25) }
    ],
    tips: [
      { id: "tip1", title: "Start with scope", detail: "A clear scope prevents waste and rework." },
      { id: "tip2", title: "Validate quantities", detail: "Double-check quantities before final purchase." },
      { id: "tip3", title: "Keep alternatives", detail: "Maintain substitute options for critical items." }
    ],
    qa: [
      { question: "How precise is this?", answer: "Treat as a planning baseline and refine with measurements." },
      { question: "Can this be low-cost?", answer: "Yes, prioritize essentials and optional upgrades separately." }
    ],
    agent_fill_ins: ["Generated from Gemini output with schema normalization."],
    confidence: 0.55
  };
}

function coerceCandidate(candidate: unknown, projectInput: string, csvInput: string, budgetTarget?: number) {
  const base = neutralBlueprint(projectInput, csvInput, budgetTarget);
  const raw = candidate && typeof candidate === "object" ? (candidate as Record<string, unknown>) : {};

  const rawMaterials = Array.isArray(raw.materials) ? raw.materials : [];
  const materials = rawMaterials
    .map((entry, index) => {
      if (typeof entry === "string") {
        return {
          id: `m_${index + 1}`,
          name: entry,
          spec: "Project supply item",
          qty: 1,
          unit: "pcs",
          category: "general",
          priority: "recommended",
          est_cost: 25,
          notes: "",
          alternatives: []
        };
      }
      if (!entry || typeof entry !== "object") return null;
      const row = entry as Record<string, unknown>;
      return {
        id: String(row.id ?? `m_${index + 1}`),
        name: String(row.name ?? row.title ?? `Item ${index + 1}`),
        spec: String(row.spec ?? row.description ?? "Project supply item"),
        qty: Math.max(0, toNumber(row.qty, 1)),
        unit: String(row.unit ?? "pcs"),
        category: String(row.category ?? "general"),
        priority: row.priority === "critical" || row.priority === "optional" ? row.priority : "recommended",
        est_cost: Math.max(0, toNumber(row.est_cost ?? row.cost, 25)),
        notes: String(row.notes ?? ""),
        alternatives: toStringList(row.alternatives, [])
      };
    })
    .filter((v): v is NonNullable<typeof v> => Boolean(v));

  const rawTools = Array.isArray(raw.tools) ? raw.tools : [];
  const tools = rawTools
    .map((entry, index) => {
      if (typeof entry === "string") {
        return { id: `t_${index + 1}`, name: entry, purpose: "Project task", est_cost: 20 };
      }
      if (!entry || typeof entry !== "object") return null;
      const row = entry as Record<string, unknown>;
      return {
        id: String(row.id ?? `t_${index + 1}`),
        name: String(row.name ?? row.title ?? `Tool ${index + 1}`),
        purpose: String(row.purpose ?? row.use ?? "Project task"),
        est_cost: Math.max(0, toNumber(row.est_cost ?? row.cost, 20))
      };
    })
    .filter((v): v is NonNullable<typeof v> => Boolean(v));

  return {
    ...base,
    ...raw,
    title: String(raw.title ?? base.title),
    objective: String(raw.objective ?? base.objective),
    complexity: raw.complexity === "simple" || raw.complexity === "advanced" ? raw.complexity : "moderate",
    assumptions: toStringList(raw.assumptions, base.assumptions),
    safety_notes: toStringList(raw.safety_notes, base.safety_notes),
    timeline: raw.timeline && typeof raw.timeline === "object" ? raw.timeline : base.timeline,
    budget: raw.budget && typeof raw.budget === "object" ? raw.budget : base.budget,
    phases: Array.isArray(raw.phases) && raw.phases.length > 0 ? raw.phases : base.phases,
    diagram: raw.diagram && typeof raw.diagram === "object" ? raw.diagram : base.diagram,
    materials: materials.length > 0 ? materials : base.materials,
    tools: tools.length > 0 ? tools : base.tools,
    cost_breakdown: Array.isArray(raw.cost_breakdown) && raw.cost_breakdown.length > 0 ? raw.cost_breakdown : base.cost_breakdown,
    tips: Array.isArray(raw.tips) && raw.tips.length > 0 ? raw.tips : base.tips,
    qa: Array.isArray(raw.qa) && raw.qa.length > 0 ? raw.qa : base.qa,
    agent_fill_ins: toStringList(raw.agent_fill_ins, base.agent_fill_ins),
    confidence: Math.max(0, Math.min(1, toNumber(raw.confidence, base.confidence)))
  };
}

async function generateWithRepair(projectInput: string, csvInput: string, budgetTarget?: number) {
  const firstText = await callGemini(buildGenerationPrompt(projectInput, csvInput, budgetTarget));
  try {
    const firstRaw = unwrapBlueprint(parsePossiblyWrappedJson(firstText));
    return projectBlueprintSchema.parse(firstRaw);
  } catch (firstError) {
    const secondText = await callGemini(buildRepairPrompt(projectInput, firstText));
    const secondRaw = unwrapBlueprint(parsePossiblyWrappedJson(secondText));
    const secondParsed = projectBlueprintSchema.safeParse(secondRaw);
    if (secondParsed.success) return secondParsed.data;

    const coerced = coerceCandidate(secondRaw, projectInput, csvInput, budgetTarget);
    return projectBlueprintSchema.parse(coerced);
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const parsed = intakeSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "invalid_payload", details: parsed.error.flatten() }, { status: 400 });
    }

    const payload = parsed.data;
    try {
      const blueprint = await generateWithRepair(payload.project_input, payload.csv_input ?? "", payload.budget_target);
      return NextResponse.json({ source: "gemini", blueprint });
    } catch (error) {
      if (!ALLOW_EMERGENCY_HEURISTIC_FALLBACK) {
        const message =
          error instanceof ZodError
            ? `model_response_invalid_schema (${error.issues.length} issues)`
            : error instanceof Error
              ? error.message
              : "planner_generation_failed";
        return NextResponse.json({ error: "planner_generation_failed", message }, { status: 502 });
      }
      return NextResponse.json(
        {
          error: "planner_generation_failed",
          message: "Gemini output invalid and fallback disabled for this environment."
        },
        { status: 502 }
      );
    }
  } catch (error) {
    return NextResponse.json(
      { error: "project_plan_failed", message: error instanceof Error ? error.message : "unknown_error" },
      { status: 500 }
    );
  }
}
