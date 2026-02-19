import { NextResponse } from "next/server";
import { ZodError } from "zod";
import {
  ensureBlueprintCoverage,
  fallbackBlueprint,
  intakeSchema,
  parsePossiblyWrappedJson,
  projectBlueprintSchema
} from "@/lib/project-blueprint";

const GEMINI_MODEL = "gemini-2.0-flash";
const ALLOW_PLANNER_FALLBACK = (process.env.ALLOW_PLANNER_FALLBACK ?? "false").toLowerCase() === "true";

function buildPrompt(projectInput: string, csvInput: string, budgetTarget?: number) {
  return [
    "You are SupplyFlare Blueprint Agent for practical DIY plans.",
    "Return valid JSON only. No markdown.",
    "Build a complete project blueprint that is safe, practical, and optimized for store-ready shopping lists.",
    "Assume the user is non-expert unless prompt implies pro-level.",
    "If the request appears like grocery planning, still return project structure but tune to household execution.",
    "Quantities and costs must be realistic estimates, not exact promises.",
    "materials.est_cost must be a single estimated dollar value for each item.",
    "For rewiring/electrical projects, always include lighting components when user asks for better lighting.",
    "For kitchen remodel projects, include cabinetry, countertop, sink/faucet, and backsplash categories unless user explicitly excludes them.",
    "Always include alternatives for key materials.",
    "Ensure materials are complete enough that a normal homeowner can walk into a store with the list and start work.",
    "Schema must include all required fields exactly.",
    `User project input: ${projectInput}`,
    `CSV input (if any): ${csvInput || "none"}`,
    `Budget target (if any): ${typeof budgetTarget === "number" ? budgetTarget : "none"}`
  ].join("\n");
}

async function callGemini(projectInput: string, csvInput: string, budgetTarget?: number) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("gemini_api_key_missing");
  }

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [{ text: buildPrompt(projectInput, csvInput, budgetTarget) }]
          }
        ],
        generationConfig: {
          temperature: 0.25,
          topP: 0.9,
          responseMimeType: "application/json"
        }
      })
    }
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`gemini_request_failed_${response.status}:${body.slice(0, 300)}`);
  }

  const payload = await response.json();
  const text = payload?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text || typeof text !== "string") {
    throw new Error("gemini_empty_response");
  }

  const rawJson = parsePossiblyWrappedJson(text) as Record<string, unknown>;
  const candidate = rawJson && typeof rawJson === "object" && rawJson.blueprint && typeof rawJson.blueprint === "object"
    ? (rawJson.blueprint as Record<string, unknown>)
    : rawJson;

  return candidate;
}

function normalizeArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function coerceBlueprint(projectInput: string, csvInput: string, budgetTarget: number | undefined, candidate: Record<string, unknown>) {
  const base = fallbackBlueprint({ project_input: projectInput, csv_input: csvInput, budget_target: budgetTarget });

  const rawMaterials = normalizeArray(candidate.materials);
  const rawTools = normalizeArray(candidate.tools);

  const materials = rawMaterials
    .map((entry, index) => {
      if (typeof entry === "string") {
        return {
          id: `m_ai_${index + 1}`,
          name: entry,
          spec: "General supply item",
          qty: 1,
          unit: "pcs",
          category: "general",
          priority: "recommended" as const,
          est_cost: 25,
          notes: "",
          alternatives: []
        };
      }
      if (!entry || typeof entry !== "object") return null;
      const row = entry as Record<string, unknown>;
      const name = String(row.name ?? row.title ?? `Item ${index + 1}`).trim();
      return {
        id: String(row.id ?? `m_ai_${index + 1}`),
        name: name.length > 0 ? name : `Item ${index + 1}`,
        spec: String(row.spec ?? row.description ?? "General supply item"),
        qty: Number(row.qty ?? 1) || 1,
        unit: String(row.unit ?? "pcs"),
        category: String(row.category ?? "general"),
        priority:
          row.priority === "critical" || row.priority === "optional" || row.priority === "recommended"
            ? row.priority
            : "recommended",
        est_cost: Number(row.est_cost ?? row.estimated_cost ?? row.cost ?? 25) || 25,
        notes: String(row.notes ?? ""),
        alternatives: Array.isArray(row.alternatives) ? row.alternatives.map((v) => String(v)) : []
      };
    })
    .filter((v): v is NonNullable<typeof v> => Boolean(v));

  const tools = rawTools
    .map((entry, index) => {
      if (typeof entry === "string") {
        return { id: `t_ai_${index + 1}`, name: entry, purpose: "General project task", est_cost: 25 };
      }
      if (!entry || typeof entry !== "object") return null;
      const row = entry as Record<string, unknown>;
      const name = String(row.name ?? row.title ?? `Tool ${index + 1}`).trim();
      return {
        id: String(row.id ?? `t_ai_${index + 1}`),
        name: name.length > 0 ? name : `Tool ${index + 1}`,
        purpose: String(row.purpose ?? row.use ?? "General project task"),
        est_cost: Number(row.est_cost ?? row.estimated_cost ?? row.cost ?? 25) || 25
      };
    })
    .filter((v): v is NonNullable<typeof v> => Boolean(v));

  return {
    ...base,
    ...candidate,
    title: String(candidate.title ?? base.title),
    objective: String(candidate.objective ?? base.objective),
    complexity:
      candidate.complexity === "simple" || candidate.complexity === "moderate" || candidate.complexity === "advanced"
        ? candidate.complexity
        : base.complexity,
    assumptions: normalizeArray(candidate.assumptions).map((v) => String(v)).filter(Boolean).slice(0, 8).length > 0
      ? normalizeArray(candidate.assumptions).map((v) => String(v)).filter(Boolean).slice(0, 8)
      : base.assumptions,
    safety_notes: normalizeArray(candidate.safety_notes).map((v) => String(v)).filter(Boolean).slice(0, 8).length > 0
      ? normalizeArray(candidate.safety_notes).map((v) => String(v)).filter(Boolean).slice(0, 8)
      : base.safety_notes,
    timeline: candidate.timeline && typeof candidate.timeline === "object" ? candidate.timeline : base.timeline,
    budget: candidate.budget && typeof candidate.budget === "object" ? candidate.budget : base.budget,
    phases: Array.isArray(candidate.phases) && candidate.phases.length > 0 ? candidate.phases : base.phases,
    diagram: candidate.diagram && typeof candidate.diagram === "object" ? candidate.diagram : base.diagram,
    materials: materials.length > 0 ? materials : base.materials,
    tools: tools.length > 0 ? tools : base.tools,
    cost_breakdown: Array.isArray(candidate.cost_breakdown) && candidate.cost_breakdown.length > 0 ? candidate.cost_breakdown : base.cost_breakdown,
    tips: Array.isArray(candidate.tips) && candidate.tips.length > 0 ? candidate.tips : base.tips,
    qa: Array.isArray(candidate.qa) && candidate.qa.length > 0 ? candidate.qa : base.qa,
    agent_fill_ins: Array.isArray(candidate.agent_fill_ins)
      ? candidate.agent_fill_ins.map((v) => String(v)).filter(Boolean).slice(0, 12)
      : base.agent_fill_ins,
    confidence: typeof candidate.confidence === "number" ? Math.max(0, Math.min(1, candidate.confidence)) : base.confidence
  };
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const parsed = intakeSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        {
          error: "invalid_payload",
          details: parsed.error.flatten()
        },
        { status: 400 }
      );
    }

    const payload = parsed.data;
    try {
      const rawCandidate = await callGemini(payload.project_input, payload.csv_input ?? "", payload.budget_target);
      const normalized = coerceBlueprint(payload.project_input, payload.csv_input ?? "", payload.budget_target, rawCandidate);
      const parsedBlueprint = projectBlueprintSchema.parse(normalized);
      const blueprint = ensureBlueprintCoverage(payload.project_input, parsedBlueprint);
      return NextResponse.json({ source: "gemini", blueprint });
    } catch (error) {
      if (!ALLOW_PLANNER_FALLBACK) {
        const message =
          error instanceof ZodError
            ? `model_response_invalid_schema (${error.issues.length} issues).`
            : error instanceof Error
              ? error.message
              : "gemini_generation_failed";
        return NextResponse.json(
          {
            error: "planner_generation_failed",
            message
          },
          { status: 502 }
        );
      }
      const blueprint = fallbackBlueprint(payload);
      return NextResponse.json({ source: "fallback", blueprint, warning: "fallback_enabled" });
    }
  } catch (error) {
    return NextResponse.json(
      {
        error: "project_plan_failed",
        message: error instanceof Error ? error.message : "unknown_error"
      },
      { status: 500 }
    );
  }
}
