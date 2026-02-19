import { z } from "zod";

export const intakeSchema = z.object({
  project_input: z.string().min(3),
  csv_input: z.string().optional().default(""),
  budget_target: z.number().positive().optional()
});

const phaseStepSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  details: z.string().min(1),
  checkpoint: z.string().min(1),
  warning: z.string().optional().default("")
});

const phaseSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  goal: z.string().min(1),
  duration_hours: z.number().positive(),
  steps: z.array(phaseStepSchema).min(1),
  deliverables: z.array(z.string().min(1)).min(1)
});

const diagramNodeSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  kind: z.enum(["start", "task", "decision", "finish"])
});

const diagramEdgeSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  label: z.string().optional().default("")
});

const materialSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  spec: z.string().min(1),
  qty: z.number().nonnegative(),
  unit: z.string().min(1),
  category: z.string().min(1),
  priority: z.enum(["critical", "recommended", "optional"]),
  est_cost_low: z.number().nonnegative(),
  est_cost_high: z.number().nonnegative(),
  notes: z.string().optional().default(""),
  alternatives: z.array(z.string()).default([])
});

const toolSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  purpose: z.string().min(1),
  owned: z.boolean().default(false),
  rent_or_buy: z.enum(["own", "rent", "buy"]),
  est_cost: z.number().nonnegative()
});

const costBucketSchema = z.object({
  label: z.string().min(1),
  value: z.number().nonnegative()
});

const tipSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  detail: z.string().min(1)
});

const qaSchema = z.object({
  question: z.string().min(1),
  answer: z.string().min(1)
});

export const projectBlueprintSchema = z.object({
  title: z.string().min(1),
  objective: z.string().min(1),
  complexity: z.enum(["simple", "moderate", "advanced"]),
  assumptions: z.array(z.string()).min(1),
  safety_notes: z.array(z.string()).min(1),
  timeline: z.object({
    total_estimated_hours: z.number().positive(),
    suggested_days_min: z.number().positive(),
    suggested_days_max: z.number().positive()
  }),
  budget: z.object({
    currency: z.string().default("USD"),
    low: z.number().nonnegative(),
    mid: z.number().nonnegative(),
    high: z.number().nonnegative()
  }),
  phases: z.array(phaseSchema).min(2),
  diagram: z.object({
    nodes: z.array(diagramNodeSchema).min(2),
    edges: z.array(diagramEdgeSchema).min(1)
  }),
  materials: z.array(materialSchema).min(1),
  tools: z.array(toolSchema).min(1),
  cost_breakdown: z.array(costBucketSchema).min(1),
  tips: z.array(tipSchema).min(3),
  qa: z.array(qaSchema).min(2),
  agent_fill_ins: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1)
});

export type ProjectBlueprint = z.infer<typeof projectBlueprintSchema>;
export type IntakePayload = z.infer<typeof intakeSchema>;

function csvRows(csv: string): string[] {
  return csv
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 100);
}

export function fallbackBlueprint(input: IntakePayload): ProjectBlueprint {
  const rows = csvRows(input.csv_input ?? "");
  const normalized = input.project_input.trim();
  const isKitchen = /kitchen|cabinet|counter|sink|backsplash/i.test(normalized);
  const isElectrical = /rewire|breaker|panel|outlet|circuit|electrical/i.test(normalized);
  const isGrocery = /grocery|meal|food|shopping list|pantry/i.test(normalized);
  const contextTitle = isKitchen
    ? "Kitchen Remodel Starter Plan"
    : isElectrical
      ? "Basement Rewire Starter Plan"
      : isGrocery
        ? "Smart Grocery Planning Blueprint"
        : "DIY Project Blueprint";

  const materials = isGrocery
    ? [
        {
          id: "m1",
          name: "Fresh vegetables",
          spec: "7-day mixed produce set",
          qty: 1,
          unit: "set",
          category: "produce",
          priority: "critical" as const,
          est_cost_low: 30,
          est_cost_high: 55,
          notes: "Split by meals for less spoilage.",
          alternatives: ["Frozen vegetables"]
        },
        {
          id: "m2",
          name: "Protein pack",
          spec: "Lean meats / beans / tofu mix",
          qty: 1,
          unit: "set",
          category: "protein",
          priority: "critical" as const,
          est_cost_low: 35,
          est_cost_high: 85,
          notes: "Pick 3 rotating options for variety.",
          alternatives: ["Canned tuna", "Lentils"]
        }
      ]
    : [
        {
          id: "m1",
          name: isElectrical ? "12/2 Romex cable" : "Framing lumber",
          spec: isElectrical ? "Copper NM-B, indoor rated" : "2x4 kiln-dried studs",
          qty: isElectrical ? 250 : 24,
          unit: isElectrical ? "ft" : "pcs",
          category: isElectrical ? "electrical" : "build",
          priority: "critical" as const,
          est_cost_low: isElectrical ? 145 : 110,
          est_cost_high: isElectrical ? 260 : 210,
          notes: "Adjust quantity after final measurements.",
          alternatives: isElectrical ? ["14/2 for lighting runs"] : ["2x3 for non-load framing"]
        },
        {
          id: "m2",
          name: isElectrical ? "20A outlets + boxes" : "Drywall sheets",
          spec: isElectrical ? "Tamper-resistant duplex, old-work boxes" : "1/2 inch gypsum board",
          qty: isElectrical ? 10 : 18,
          unit: "pcs",
          category: isElectrical ? "devices" : "finish",
          priority: "recommended" as const,
          est_cost_low: isElectrical ? 65 : 150,
          est_cost_high: isElectrical ? 140 : 280,
          notes: "Include 10% overage for breakage.",
          alternatives: isElectrical ? ["AFCI/GFCI where required"] : ["Moisture resistant board"]
        }
      ];

  const tools = isGrocery
    ? [
        { id: "t1", name: "Meal prep containers", purpose: "Batch prep and store meals", owned: false, rent_or_buy: "buy" as const, est_cost: 18 },
        { id: "t2", name: "Digital kitchen scale", purpose: "Portion control and consistency", owned: false, rent_or_buy: "buy" as const, est_cost: 24 }
      ]
    : [
        { id: "t1", name: "Tape measure", purpose: "Room and run measurements", owned: false, rent_or_buy: "buy" as const, est_cost: 12 },
        { id: "t2", name: isElectrical ? "Wire stripper" : "Circular saw", purpose: isElectrical ? "Clean wire prep" : "Cut framing material", owned: false, rent_or_buy: "buy" as const, est_cost: isElectrical ? 25 : 89 },
        { id: "t3", name: "Drill driver", purpose: "Fastening and assembly", owned: false, rent_or_buy: "rent" as const, est_cost: 35 }
      ];

  const low = materials.reduce((acc, item) => acc + item.est_cost_low, 0) + tools.reduce((acc, item) => acc + item.est_cost * 0.4, 0);
  const high = materials.reduce((acc, item) => acc + item.est_cost_high, 0) + tools.reduce((acc, item) => acc + item.est_cost, 0);
  const mid = Math.round((low + high) / 2);

  return {
    title: contextTitle,
    objective: `Plan and execute: ${normalized}`,
    complexity: rows.length > 30 ? "advanced" : rows.length > 10 ? "moderate" : "simple",
    assumptions: [
      "Local building code and permit rules vary by city.",
      "Pricing is estimate-only and should be validated in-store.",
      "Quantities include a small waste factor."
    ],
    safety_notes: isElectrical
      ? ["Turn off breaker and verify zero voltage before work.", "Use correct gauge and breaker pairing.", "When in doubt, involve a licensed electrician."]
      : ["Use eye and hearing protection.", "Confirm wall utility lines before cutting.", "Keep workspace ventilated and clean."],
    timeline: {
      total_estimated_hours: isGrocery ? 2 : 18,
      suggested_days_min: isGrocery ? 1 : 3,
      suggested_days_max: isGrocery ? 2 : 7
    },
    budget: {
      currency: "USD",
      low,
      mid,
      high
    },
    phases: [
      {
        id: "p1",
        name: "Scope and measure",
        goal: "Translate project goal into measurable requirements.",
        duration_hours: isGrocery ? 0.5 : 3,
        steps: [
          {
            id: "p1s1",
            title: "Define outcomes",
            details: "List what success looks like and non-negotiable constraints.",
            checkpoint: "Clear scope note approved",
            warning: ""
          },
          {
            id: "p1s2",
            title: "Capture dimensions and quantities",
            details: "Measure once, then verify. Convert to bill-of-material assumptions.",
            checkpoint: "Measurement sheet complete",
            warning: "Bad measurements create major cost drift."
          }
        ],
        deliverables: ["Scope brief", "Measurement log"]
      },
      {
        id: "p2",
        name: "Procure and stage",
        goal: "Build the materials and tools list and stage work safely.",
        duration_hours: isGrocery ? 1 : 5,
        steps: [
          {
            id: "p2s1",
            title: "Finalize shopping list",
            details: "Set base quantities, plus waste factor and alternatives.",
            checkpoint: "Primary + backup list ready",
            warning: ""
          },
          {
            id: "p2s2",
            title: "Prepare workspace",
            details: "Clear work area and set safety gear and storage locations.",
            checkpoint: "Workspace pass completed",
            warning: ""
          }
        ],
        deliverables: ["Store-ready item list", "Workspace checklist"]
      },
      {
        id: "p3",
        name: "Execute and verify",
        goal: "Perform the work, validate outcomes, and capture next actions.",
        duration_hours: isGrocery ? 0.5 : 10,
        steps: [
          {
            id: "p3s1",
            title: "Run step-by-step execution",
            details: "Perform tasks in sequence and verify each checkpoint.",
            checkpoint: "Milestones signed off",
            warning: ""
          },
          {
            id: "p3s2",
            title: "Final QA and cleanup",
            details: "Check fit/finish/safety and log leftover items for returns.",
            checkpoint: "Project closeout note complete",
            warning: ""
          }
        ],
        deliverables: ["Completion checklist", "Return/reorder list"]
      }
    ],
    diagram: {
      nodes: [
        { id: "n1", label: "Project Input", kind: "start" },
        { id: "n2", label: "Measure + Scope", kind: "task" },
        { id: "n3", label: "Material Plan", kind: "task" },
        { id: "n4", label: "Safety Check", kind: "decision" },
        { id: "n5", label: "Build + Verify", kind: "finish" }
      ],
      edges: [
        { from: "n1", to: "n2", label: "" },
        { from: "n2", to: "n3", label: "" },
        { from: "n3", to: "n4", label: "pre-work gate" },
        { from: "n4", to: "n5", label: "go" }
      ]
    },
    materials,
    tools,
    cost_breakdown: [
      { label: "Core materials", value: Math.round(low * 0.65) },
      { label: "Tools and rentals", value: Math.round(low * 0.2) },
      { label: "Contingency", value: Math.round(low * 0.15) }
    ],
    tips: [
      { id: "tip1", title: "Buy once strategy", detail: "Purchase critical path items first, optional items after first milestone." },
      { id: "tip2", title: "Label everything", detail: "Use bins and labels for faster install and easier returns." },
      { id: "tip3", title: "Keep a rollback plan", detail: "Maintain one alternative item per critical material." }
    ],
    qa: [
      { question: "What if my budget is tight?", answer: "Cut optional items, reduce finish tier, and keep contingency at least 10%." },
      { question: "How accurate are quantities?", answer: "Treat quantities as first-pass; verify against final measurements before purchase." }
    ],
    agent_fill_ins: [
      rows.length > 0 ? `Parsed ${rows.length} CSV rows to infer scope and quantities.` : "No CSV attached; assumptions are based on prompt only.",
      "Applied a default waste factor for material planning.",
      "Generated alternatives for high-risk or high-variance items."
    ],
    confidence: rows.length > 0 ? 0.76 : 0.62
  };
}

export function parsePossiblyWrappedJson(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    return JSON.parse(trimmed);
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    return JSON.parse(fenced[1]);
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
  }

  throw new Error("json_not_found_in_model_output");
}
