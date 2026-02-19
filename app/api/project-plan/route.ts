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

async function generateWithRepair(projectInput: string, csvInput: string, budgetTarget?: number) {
  const firstText = await callGemini(buildGenerationPrompt(projectInput, csvInput, budgetTarget));
  try {
    const firstRaw = unwrapBlueprint(parsePossiblyWrappedJson(firstText));
    return projectBlueprintSchema.parse(firstRaw);
  } catch (firstError) {
    const secondText = await callGemini(buildRepairPrompt(projectInput, firstText));
    const secondRaw = unwrapBlueprint(parsePossiblyWrappedJson(secondText));
    return projectBlueprintSchema.parse(secondRaw);
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
