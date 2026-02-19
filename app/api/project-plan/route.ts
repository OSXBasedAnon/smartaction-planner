import { NextResponse } from "next/server";
import { fallbackBlueprint, intakeSchema, parsePossiblyWrappedJson, projectBlueprintSchema } from "@/lib/project-blueprint";

const GEMINI_MODEL = "gemini-2.0-flash";

function buildPrompt(projectInput: string, csvInput: string, budgetTarget?: number) {
  return [
    "You are SupplyFlare Blueprint Agent for practical DIY plans.",
    "Return valid JSON only. No markdown.",
    "Build a complete project blueprint that is safe, practical, and optimized for store-ready shopping lists.",
    "Assume the user is non-expert unless prompt implies pro-level.",
    "If the request appears like grocery planning, still return project structure but tune to household execution.",
    "Quantities and costs must be realistic ranges, not exact promises.",
    "Always include alternatives for key materials.",
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

  const rawJson = parsePossiblyWrappedJson(text);
  return projectBlueprintSchema.parse(rawJson);
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
      const blueprint = await callGemini(payload.project_input, payload.csv_input ?? "", payload.budget_target);
      return NextResponse.json({ source: "gemini", blueprint });
    } catch {
      const blueprint = fallbackBlueprint(payload);
      return NextResponse.json({ source: "fallback", blueprint });
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
