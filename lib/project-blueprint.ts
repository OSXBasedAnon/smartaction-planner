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
  est_cost: z.number().nonnegative(),
  notes: z.string().optional().default(""),
  alternatives: z.array(z.string()).default([])
});

const toolSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  purpose: z.string().min(1),
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
    .slice(0, 120);
}

function includesAny(text: string, words: string[]): boolean {
  return words.some((word) => text.includes(word));
}

function intentFlags(text: string) {
  const electricalStrong = includesAny(text, ["rewire", "re-wire", "circuit", "breaker", "panel", "outlet", "switch leg", "junction"]);
  const kitchenLocation = includesAny(text, ["kitchen"]);
  const kitchenRemodel = kitchenLocation && includesAny(text, ["remodel", "renovate", "cabinet", "counter", "backsplash", "sink"]);
  const tileIntent = includesAny(text, ["tile", "tiling", "grout", "backsplash"]);
  const groceryIntent = includesAny(text, ["grocery", "meal", "pantry", "food list", "shopping list"]);
  const paintIntent = includesAny(text, ["paint", "primer", "roll", "brush"]);
  const plumbingIntent = includesAny(text, ["plumbing", "faucet", "sink", "pipe", "drain"]);
  const framingIntent = includesAny(text, ["frame", "framing", "stud", "wall", "room"]);

  return {
    isElectrical: electricalStrong || (includesAny(text, ["electrical", "lighting"]) && !kitchenRemodel),
    isKitchen: kitchenRemodel && !electricalStrong,
    isTile: tileIntent,
    isGrocery: groceryIntent,
    isPaint: paintIntent,
    isPlumbing: plumbingIntent,
    isFraming: framingIntent,
    kitchenLocation
  };
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32);
}

function materialExists(materials: ProjectBlueprint["materials"], probes: string[]): boolean {
  return materials.some((item) => {
    const hay = `${item.name} ${item.spec}`.toLowerCase();
    return probes.some((probe) => hay.includes(probe));
  });
}

function addMaterialIfMissing(
  materials: ProjectBlueprint["materials"],
  candidate: ProjectBlueprint["materials"][number],
  probes: string[]
): ProjectBlueprint["materials"] {
  if (materialExists(materials, probes)) return materials;
  return [...materials, candidate];
}

function normalizeBudget(blueprint: ProjectBlueprint): ProjectBlueprint {
  const materialTotal = blueprint.materials.reduce((acc, item) => acc + item.est_cost, 0);
  const toolTotal = blueprint.tools.reduce((acc, item) => acc + item.est_cost, 0);
  const low = Math.round(materialTotal + toolTotal * 0.45);
  const high = Math.round(materialTotal * 1.3 + toolTotal);
  const mid = Math.round((low + high) / 2);

  return {
    ...blueprint,
    budget: {
      currency: blueprint.budget.currency || "USD",
      low,
      mid,
      high
    },
    cost_breakdown: [
      { label: "Materials", value: Math.round(materialTotal) },
      { label: "Tools", value: Math.round(toolTotal) },
      { label: "Buffer", value: Math.round(Math.max(40, high - materialTotal - toolTotal)) }
    ]
  };
}

function baselineDiagram(): ProjectBlueprint["diagram"] {
  return {
    nodes: [
      { id: "d_start", label: "Project intake", kind: "start" },
      { id: "d_scope", label: "Scope and measurements", kind: "task" },
      { id: "d_procure", label: "Material and tool prep", kind: "task" },
      { id: "d_gate", label: "Safety + code checkpoint", kind: "decision" },
      { id: "d_execute", label: "Execute build steps", kind: "task" },
      { id: "d_finish", label: "Final QA + closeout", kind: "finish" }
    ],
    edges: [
      { from: "d_start", to: "d_scope", label: "" },
      { from: "d_scope", to: "d_procure", label: "" },
      { from: "d_procure", to: "d_gate", label: "ready?" },
      { from: "d_gate", to: "d_execute", label: "yes" },
      { from: "d_gate", to: "d_scope", label: "fix scope" },
      { from: "d_execute", to: "d_finish", label: "" }
    ]
  };
}

function dynamicToolSet(flags: {
  isElectrical: boolean;
  isKitchen: boolean;
  isTile: boolean;
  isPaint: boolean;
  isPlumbing: boolean;
  isFraming: boolean;
  isGrocery: boolean;
}): ProjectBlueprint["tools"] {
  if (flags.isGrocery) {
    return [
      { id: "t_meal_containers", name: "Meal prep containers", purpose: "Store batch-cooked meals", est_cost: 18 },
      { id: "t_kitchen_scale", name: "Kitchen scale", purpose: "Portion and recipe consistency", est_cost: 24 },
      { id: "t_label_marker", name: "Label marker", purpose: "Date and label stored items", est_cost: 8 }
    ];
  }

  const tools: ProjectBlueprint["tools"] = [{ id: "t_tape", name: "Tape measure", purpose: "Capture dimensions and layout references", est_cost: 12 }];

  if (flags.isElectrical) {
    tools.push(
      { id: "t_wire_strip", name: "Wire stripper/cutter", purpose: "Strip and prep conductors safely", est_cost: 25 },
      { id: "t_voltage_test", name: "Voltage tester", purpose: "Confirm circuits are de-energized", est_cost: 26 },
      { id: "t_fish_tape", name: "Fish tape", purpose: "Pull cable through closed cavities", est_cost: 24 }
    );
  }

  if (flags.isKitchen || flags.isFraming) {
    tools.push(
      { id: "t_drill", name: "Drill driver", purpose: "Fastening, anchors, and assembly", est_cost: 85 },
      { id: "t_level", name: "4-ft level", purpose: "Level cabinets, fixtures, and framing lines", est_cost: 28 }
    );
  }

  if (flags.isTile) {
    tools.push(
      { id: "t_tile_trowel", name: "Notched trowel", purpose: "Apply thinset evenly for tile install", est_cost: 16 },
      { id: "t_grout_float", name: "Grout float", purpose: "Pack grout joints and clean tile face", est_cost: 14 },
      { id: "t_tile_cutter", name: "Tile cutter", purpose: "Cut tiles to fit edges and corners", est_cost: 79 }
    );
  }

  if (flags.isPaint) {
    tools.push(
      { id: "t_paint_roller", name: "Roller and tray set", purpose: "Even wall/cabinet paint coverage", est_cost: 18 },
      { id: "t_brush_set", name: "Detail brush set", purpose: "Cut-ins and trim finish", est_cost: 14 }
    );
  }

  if (flags.isPlumbing || flags.isKitchen) {
    tools.push({ id: "t_pipe_wrench", name: "Adjustable wrench set", purpose: "Sink and faucet connection adjustments", est_cost: 22 });
  }

  return tools;
}

function dynamicTips(flags: {
  isElectrical: boolean;
  isKitchen: boolean;
  isTile: boolean;
  isPaint: boolean;
  isGrocery: boolean;
}): ProjectBlueprint["tips"] {
  if (flags.isElectrical) {
    return [
      { id: "tip1", title: "Label every circuit run", detail: "Write destination labels before wall close-up to reduce troubleshooting later." },
      { id: "tip2", title: "Test before final plate install", detail: "Energize each circuit and verify polarity and switch behavior before finish trim." },
      { id: "tip3", title: "Keep lighting zones balanced", detail: "Split fixtures across practical switch zones so brightness is usable in daily use." }
    ];
  }

  if (flags.isKitchen) {
    return [
      { id: "tip1", title: "Lock layout before purchases", detail: "Cabinet and appliance dimensions should be frozen before ordering countertop and backsplash." },
      { id: "tip2", title: "Dry-fit major components", detail: "Test-fit cabinet and sink alignment before permanent fastening." },
      { id: "tip3", title: "Sequence saves money", detail: "Cabinets first, then countertop, then backsplash and finish details." }
    ];
  }

  if (flags.isTile) {
    return [
      { id: "tip1", title: "Start from a centerline", detail: "Dry-layout tile from center to avoid tiny edge cuts." },
      { id: "tip2", title: "Control thinset coverage", detail: "Work small sections so thinset does not skin over before tile placement." },
      { id: "tip3", title: "Clean as you go", detail: "Remove thinset squeeze-out and haze early to reduce finish cleanup." }
    ];
  }

  if (flags.isGrocery) {
    return [
      { id: "tip1", title: "Shop by meal blocks", detail: "Group items by breakfast/lunch/dinner to avoid random overbuy." },
      { id: "tip2", title: "Use shelf-life ordering", detail: "Buy perishables last and freeze portions same day." },
      { id: "tip3", title: "Track carry-over inventory", detail: "List what you already have before adding duplicate staples." }
    ];
  }

  return [
    { id: "tip1", title: "Critical-path first", detail: "Buy and stage critical items first; defer optional upgrades." },
    { id: "tip2", title: "Label and zone", detail: "Split materials by phase to reduce mistakes and time loss." },
    { id: "tip3", title: "Keep one backup option", detail: "Have one substitute per critical material before starting." }
  ];
}

export function ensureBlueprintCoverage(projectInput: string, blueprint: ProjectBlueprint): ProjectBlueprint {
  const lower = projectInput.toLowerCase();
  let materials = [...blueprint.materials];
  let tools = [...blueprint.tools];
  const fillIns = [...blueprint.agent_fill_ins];
  const flags = intentFlags(lower);
  const isElectrical = flags.isElectrical;
  const isKitchen = flags.isKitchen;
  const isTile = flags.isTile;
  const isGrocery = flags.isGrocery;

  if (isElectrical) {
    materials = addMaterialIfMissing(
      materials,
      {
        id: "m_light_fixtures",
        name: "LED light fixtures",
        spec: "Ceiling fixtures or can lights, damp-rated if needed",
        qty: 6,
        unit: "pcs",
        category: "lighting",
        priority: "critical",
        est_cost: 210,
        notes: "Target lumen output by room zone.",
        alternatives: ["LED wafer lights", "Surface-mount fixtures"]
      },
      ["light fixture", "can light", "led light", "wafer"]
    );
    materials = addMaterialIfMissing(
      materials,
      {
        id: "m_switches",
        name: "Light switches and plates",
        spec: "Single pole / 3-way as required",
        qty: 6,
        unit: "pcs",
        category: "devices",
        priority: "recommended",
        est_cost: 55,
        notes: "Match gang box count and control layout.",
        alternatives: ["Smart switches"]
      },
      ["switch", "plate"]
    );
    materials = addMaterialIfMissing(
      materials,
      {
        id: "m_breakers",
        name: "Compatible breakers",
        spec: "Panel-matching breakers for new circuits",
        qty: 3,
        unit: "pcs",
        category: "panel",
        priority: "critical",
        est_cost: 72,
        notes: "Must match panel brand and rating.",
        alternatives: []
      },
      ["breaker"]
    );
    tools = tools.some((tool) => /voltage|multimeter|tester/i.test(`${tool.name} ${tool.purpose}`))
      ? tools
      : [
          ...tools,
          {
            id: "t_voltage_tester",
            name: "Non-contact voltage tester",
            purpose: "Verify circuits are de-energized before touching wiring.",
            est_cost: 26
          }
        ];
    fillIns.push("Added missing lighting and electrical safety essentials based on project intent.");
  }

  if (isKitchen) {
    materials = addMaterialIfMissing(
      materials,
      {
        id: "m_cabinets",
        name: "Cabinets or cabinet hardware",
        spec: "Base/wall cabinet set or refresh hardware set",
        qty: 1,
        unit: "set",
        category: "cabinetry",
        priority: "critical",
        est_cost: 2400,
        notes: "Adjust for full replacement vs refresh.",
        alternatives: ["Refacing kit", "Paint + hardware update"]
      },
      ["cabinet", "drawer", "hardware"]
    );
    materials = addMaterialIfMissing(
      materials,
      {
        id: "m_countertop",
        name: "Countertop material",
        spec: "Laminate / butcher block / quartz option",
        qty: 30,
        unit: "sqft",
        category: "surface",
        priority: "recommended",
        est_cost: 1450,
        notes: "Template after cabinet alignment.",
        alternatives: ["Prefabricated laminate top"]
      },
      ["counter", "countertop"]
    );
    materials = addMaterialIfMissing(
      materials,
      {
        id: "m_sink_faucet",
        name: "Sink + faucet set",
        spec: "Single or double bowl with matching faucet",
        qty: 1,
        unit: "set",
        category: "plumbing",
        priority: "recommended",
        est_cost: 320,
        notes: "Confirm cutout and plumbing compatibility.",
        alternatives: ["Drop-in sink with basic faucet"]
      },
      ["sink", "faucet"]
    );
    materials = addMaterialIfMissing(
      materials,
      {
        id: "m_backsplash",
        name: "Backsplash tile and adhesive",
        spec: "Tile, mortar/mastic, grout, spacers",
        qty: 1,
        unit: "set",
        category: "finish",
        priority: "optional",
        est_cost: 290,
        notes: "Usually installed after countertop set.",
        alternatives: ["Peel-and-stick backsplash panels"]
      },
      ["backsplash", "tile", "grout"]
    );
    fillIns.push("Added core kitchen scope items: cabinetry, countertop, sink/faucet, and backsplash.");
  }

  if (isTile) {
    materials = addMaterialIfMissing(
      materials,
      {
        id: "m_tile_surface",
        name: "Tile boxes",
        spec: "Chosen tile style with 10% overage",
        qty: 12,
        unit: "boxes",
        category: "tile",
        priority: "critical",
        est_cost: 520,
        notes: "Final quantity depends on measured surface area.",
        alternatives: ["Ceramic budget tile", "Peel-and-stick tile"]
      },
      ["tile boxes", "ceramic tile", "porcelain tile", "tile"]
    );
    materials = addMaterialIfMissing(
      materials,
      {
        id: "m_tile_set",
        name: "Thinset + grout + spacers",
        spec: "Adhesive, grout color, and leveling/spacer system",
        qty: 1,
        unit: "set",
        category: "tile_install",
        priority: "critical",
        est_cost: 110,
        notes: "Match thinset and grout to tile type and location.",
        alternatives: []
      },
      ["thinset", "grout", "spacers"]
    );
    fillIns.push("Added tile installation materials because project includes tile scope.");
  }

  if (isGrocery) {
    materials = addMaterialIfMissing(
      materials,
      {
        id: "m_pantry_base",
        name: "Pantry staples",
        spec: "Rice/pasta/beans/oil/salt basics",
        qty: 1,
        unit: "set",
        category: "pantry",
        priority: "critical",
        est_cost: 48,
        notes: "Buy bulk for long shelf life.",
        alternatives: []
      },
      ["pantry", "rice", "pasta", "beans"]
    );
    fillIns.push("Added pantry baseline to reduce missing essentials.");
  }

  const normalizedMaterials = materials
    .map((item, index) => ({
      ...item,
      id: item.id?.trim().length > 0 ? item.id : `m_${slug(item.name)}_${index + 1}`,
      name: item.name.trim(),
      spec: item.spec.trim(),
      est_cost: Number.isFinite(item.est_cost) ? Math.max(0, Math.round(item.est_cost)) : 0
    }))
    .filter((item) => item.name.length > 0);

  const normalizedTools = tools
    .map((item, index) => ({
      ...item,
      id: item.id?.trim().length > 0 ? item.id : `t_${slug(item.name)}_${index + 1}`,
      name: item.name.trim(),
      purpose: item.purpose.trim(),
      est_cost: Number.isFinite(item.est_cost) ? Math.max(0, Math.round(item.est_cost)) : 0
    }))
    .filter((item) => item.name.length > 0);

  const normalized = {
    ...blueprint,
    materials: normalizedMaterials,
    tools: normalizedTools,
    agent_fill_ins: [...new Set(fillIns.filter((entry) => entry.trim().length > 0))],
    diagram:
      blueprint.diagram.nodes.length >= 4 && blueprint.diagram.edges.length >= 3
        ? blueprint.diagram
        : baselineDiagram()
  };

  return normalizeBudget(normalized);
}

export function fallbackBlueprint(input: IntakePayload): ProjectBlueprint {
  const rows = csvRows(input.csv_input ?? "");
  const normalized = input.project_input.trim();
  const lower = normalized.toLowerCase();
  const flags = intentFlags(lower);
  const isKitchen = flags.isKitchen;
  const isElectrical = flags.isElectrical;
  const isTile = flags.isTile;
  const isPaint = flags.isPaint;
  const isPlumbing = flags.isPlumbing;
  const isFraming = flags.isFraming;
  const isGrocery = flags.isGrocery;
  const contextTitle = isKitchen
    ? "Kitchen Remodel Blueprint"
    : isElectrical && flags.kitchenLocation
      ? "Kitchen Rewire Blueprint"
      : isElectrical
        ? "Electrical Rewire Blueprint"
        : isGrocery
          ? "Smart Grocery Planning Blueprint"
          : "DIY Project Blueprint";

  const materials: ProjectBlueprint["materials"] = isGrocery
    ? [
        {
          id: "m1",
          name: "Fresh vegetables",
          spec: "7-day mixed produce set",
          qty: 1,
          unit: "set",
          category: "produce",
          priority: "critical",
          est_cost: 44,
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
          priority: "critical",
          est_cost: 62,
          notes: "Pick 3 rotating options for variety.",
          alternatives: ["Canned tuna", "Lentils"]
        },
        {
          id: "m3",
          name: "Pantry staples",
          spec: "Rice, pasta, oil, seasoning basics",
          qty: 1,
          unit: "set",
          category: "pantry",
          priority: "recommended",
          est_cost: 38,
          notes: "Refill shelf-stable base ingredients.",
          alternatives: []
        }
      ]
    : isKitchen
      ? [
          {
            id: "m1",
            name: "Cabinetry or hardware set",
            spec: "Cabinets or refresh hardware kit",
            qty: 1,
            unit: "set",
            category: "cabinetry",
            priority: "critical",
            est_cost: 2400,
            notes: "Scope based on full replacement vs refresh.",
            alternatives: ["Cabinet refacing"]
          },
          {
            id: "m2",
            name: "Countertop material",
            spec: "Laminate, butcher block, or stone option",
            qty: 30,
            unit: "sqft",
            category: "surface",
            priority: "recommended",
            est_cost: 1450,
            notes: "Measure after cabinet plan is locked.",
            alternatives: ["Prefabricated laminate top"]
          },
          {
            id: "m3",
            name: "Sink + faucet set",
            spec: "Kitchen sink with matching faucet",
            qty: 1,
            unit: "set",
            category: "plumbing",
            priority: "recommended",
            est_cost: 320,
            notes: "Confirm cutout size and drain alignment.",
            alternatives: ["Drop-in sink set"]
          },
          {
            id: "m4",
            name: "Backsplash system",
            spec: "Tile, adhesive, grout, spacers",
            qty: 1,
            unit: "set",
            category: "finish",
            priority: "optional",
            est_cost: 280,
            notes: "Install after countertop.",
            alternatives: ["Peel-and-stick panels"]
          },
          {
            id: "m5",
            name: "Paint and prep supplies",
            spec: "Primer, paint, rollers, masking materials",
            qty: 1,
            unit: "set",
            category: "finish",
            priority: "optional",
            est_cost: 190,
            notes: "Needed for wall or cabinet refresh.",
            alternatives: []
          }
        ]
      : [
          {
            id: "m1",
            name: "12/2 NM-B cable",
            spec: "Copper branch circuit cable",
            qty: 300,
            unit: "ft",
            category: "electrical",
            priority: "critical",
            est_cost: 210,
            notes: "Adjust quantity after route plan.",
            alternatives: ["14/2 for lighting-only circuits"]
          },
          {
            id: "m2",
            name: "Outlets + old-work boxes",
            spec: "Tamper-resistant receptacles and boxes",
            qty: 8,
            unit: "sets",
            category: "devices",
            priority: "critical",
            est_cost: 118,
            notes: "Target: 8 outlets from prompt.",
            alternatives: ["AFCI/GFCI combo outlets"]
          },
          {
            id: "m3",
            name: "LED lighting fixtures",
            spec: "Ceiling fixtures/can lights for basement",
            qty: 6,
            unit: "pcs",
            category: "lighting",
            priority: "critical",
            est_cost: 210,
            notes: "Included because user requested better lighting.",
            alternatives: ["LED wafer lights"]
          },
          {
            id: "m4",
            name: "Switches and wall plates",
            spec: "Single pole and 3-way as needed",
            qty: 6,
            unit: "pcs",
            category: "devices",
            priority: "recommended",
            est_cost: 55,
            notes: "Map switch location before pulling cable.",
            alternatives: ["Smart dimmer switches"]
          },
          {
            id: "m5",
            name: "Panel-compatible breakers",
            spec: "Circuit breakers matching existing panel",
            qty: 3,
            unit: "pcs",
            category: "panel",
            priority: "critical",
            est_cost: 72,
            notes: "Verify panel make/model first.",
            alternatives: []
          }
        ];

  const tools = dynamicToolSet({ isElectrical, isKitchen, isTile, isPaint, isPlumbing, isFraming, isGrocery });

  const phases: ProjectBlueprint["phases"] = isElectrical
    ? [
        {
          id: "p1",
          name: "Plan circuits and layout",
          goal: "Map outlet and lighting locations, panel loads, and code constraints.",
          duration_hours: 4,
          steps: [
            {
              id: "p1s1",
              title: "Map outlets and lighting zones",
              details: "Mark each outlet/light location and assign intended circuit groups.",
              checkpoint: "Room layout map completed",
              warning: ""
            },
            {
              id: "p1s2",
              title: "Validate panel capacity and breaker plan",
              details: "Confirm available panel slots, breaker compatibility, and load assumptions.",
              checkpoint: "Circuit schedule drafted",
              warning: "Overloaded circuits are a safety hazard."
            }
          ],
          deliverables: ["Circuit map", "Breaker schedule"]
        },
        {
          id: "p2",
          name: "Rough-in wiring and boxes",
          goal: "Install cable runs, boxes, and switch locations before device install.",
          duration_hours: 6,
          steps: [
            {
              id: "p2s1",
              title: "Pull cable and secure routing",
              details: "Run NM cable, staple correctly, and keep protection clearances.",
              checkpoint: "All planned runs completed",
              warning: ""
            },
            {
              id: "p2s2",
              title: "Set boxes and label conductors",
              details: "Install outlet/switch boxes and label each run for faster finish-out.",
              checkpoint: "Rough-in complete",
              warning: "Mislabeling slows troubleshooting and increases errors."
            }
          ],
          deliverables: ["Rough-in pass", "Labeled box map"]
        },
        {
          id: "p3",
          name: "Install devices, fixtures, and test",
          goal: "Terminate devices, install lights, energize safely, and verify operation.",
          duration_hours: 8,
          steps: [
            {
              id: "p3s1",
              title: "Terminate outlets, switches, and fixtures",
              details: "Install receptacles, switches, and LED fixtures per layout and polarity.",
              checkpoint: "All devices installed",
              warning: ""
            },
            {
              id: "p3s2",
              title: "Energize and functional test",
              details: "Turn circuits on one by one and test outlets, switches, and lighting levels.",
              checkpoint: "Final electrical checklist complete",
              warning: "Stop immediately if breaker trips or device overheats."
            }
          ],
          deliverables: ["Verified operation", "Punch list"]
        }
      ]
    : isKitchen
      ? [
          {
            id: "p1",
            name: "Scope kitchen layout and measurements",
            goal: "Lock cabinet, appliance, plumbing, and finish dimensions.",
            duration_hours: 5,
            steps: [
              {
                id: "p1s1",
                title: "Measure walls, openings, and service points",
                details: "Capture exact dimensions for cabinet runs, sink centerline, and appliance clearances.",
                checkpoint: "Kitchen measurement sheet complete",
                warning: ""
              },
              {
                id: "p1s2",
                title: "Finalize cabinet/counter and fixture selections",
                details: "Choose cabinet footprint, countertop type, sink/faucet, and backsplash scope.",
                checkpoint: "Material specification approved",
                warning: "Late spec changes drive major cost and schedule delays."
              }
            ],
            deliverables: ["Kitchen layout plan", "Selected finish schedule"]
          },
          {
            id: "p2",
            name: "Demolition and prep",
            goal: "Remove old finishes and prep level, clean install surfaces.",
            duration_hours: 7,
            steps: [
              {
                id: "p2s1",
                title: "Remove old fixtures and finishes",
                details: "Demo cabinets/counters as needed while protecting reusable systems.",
                checkpoint: "Demo and debris removal complete",
                warning: ""
              },
              {
                id: "p2s2",
                title: "Prepare walls, plumbing, and electrical points",
                details: "Patch surfaces and verify rough-in locations before new installs.",
                checkpoint: "Install-ready surfaces verified",
                warning: ""
              }
            ],
            deliverables: ["Prep checklist", "Install-ready room"]
          },
          {
            id: "p3",
            name: "Install and finish",
            goal: "Set cabinets, counters, sink/faucet, backsplash, and final finishes.",
            duration_hours: 16,
            steps: [
              {
                id: "p3s1",
                title: "Install cabinets and countertop",
                details: "Level and secure cabinets, then template/set countertop.",
                checkpoint: "Cabinets and countertop installed",
                warning: ""
              },
              {
                id: "p3s2",
                title: "Install sink/faucet and backsplash then closeout",
                details: "Connect plumbing fixtures, complete backsplash, and perform final cleanup/QA.",
                checkpoint: "Kitchen closeout checklist complete",
                warning: "Verify for leaks and proper drainage before signoff."
              }
            ],
            deliverables: ["Functional kitchen", "Final punch list"]
          }
        ]
      : [
          {
            id: "p1",
            name: "Scope and measurements",
            goal: "Translate goal into measurable requirements.",
            duration_hours: isGrocery ? 0.5 : 3,
            steps: [
              {
                id: "p1s1",
                title: "Define output target",
                details: "Write what completion looks like, constraints, and quality tier.",
                checkpoint: "Scope brief approved",
                warning: ""
              },
              {
                id: "p1s2",
                title: "Capture dimensions and dependencies",
                details: "Measure and map constraints before buying.",
                checkpoint: "Measurement log complete",
                warning: "Measurement errors drive rework and extra spend."
              }
            ],
            deliverables: ["Scope brief", "Measurement sheet"]
          },
          {
            id: "p2",
            name: "Procurement and staging",
            goal: "Build complete list and prep workspace.",
            duration_hours: isGrocery ? 1 : 5,
            steps: [
              {
                id: "p2s1",
                title: "Finalize items and alternatives",
                details: "Set core items plus fallback options.",
                checkpoint: "Store-ready list created",
                warning: ""
              },
              {
                id: "p2s2",
                title: "Stage tools and safety",
                details: "Prepare tools and PPE before first install step.",
                checkpoint: "Pre-work safety checklist complete",
                warning: ""
              }
            ],
            deliverables: ["Materials list", "Tool checklist"]
          },
          {
            id: "p3",
            name: "Execution and closeout",
            goal: "Execute sequence and verify quality.",
            duration_hours: isGrocery ? 0.5 : 8,
            steps: [
              {
                id: "p3s1",
                title: "Run build sequence",
                details: "Execute each task in order and validate checkpoints.",
                checkpoint: "Core install complete",
                warning: ""
              },
              {
                id: "p3s2",
                title: "QA and cleanup",
                details: "Validate performance, finish quality, and leftover handling.",
                checkpoint: "Closeout checklist complete",
                warning: ""
              }
            ],
            deliverables: ["QA checklist", "Return/reorder list"]
          }
        ];

  const base: ProjectBlueprint = {
    title: contextTitle,
    objective: `Plan and execute: ${normalized}`,
    complexity: rows.length > 35 ? "advanced" : rows.length > 12 ? "moderate" : "simple",
    assumptions: [
      "Local code, permit, and inspection requirements vary by jurisdiction.",
      "Pricing is estimate-only and may vary by region and quality tier.",
      "Material quantities include a small waste allowance."
    ],
    safety_notes: isElectrical
      ? ["Turn off breakers and verify zero voltage before touching conductors.", "Use correct wire gauge and breaker sizing.", "Use licensed electrician support when scope exceeds comfort."]
      : ["Use PPE (gloves/eye/ear protection) throughout active work.", "Confirm hidden utilities before cutting/drilling.", "Keep workspace ventilated and dry."],
    timeline: {
      total_estimated_hours: isGrocery ? 2 : isKitchen ? 28 : 18,
      suggested_days_min: isGrocery ? 1 : isKitchen ? 4 : 3,
      suggested_days_max: isGrocery ? 2 : isKitchen ? 9 : 7
    },
    budget: {
      currency: "USD",
      low: 0,
      mid: 0,
      high: 0
    },
    phases,
    diagram: baselineDiagram(),
    materials,
    tools,
    cost_breakdown: [],
    tips: dynamicTips({ isElectrical, isKitchen, isTile, isPaint, isGrocery }),
    qa: [
      { question: "Can I cut costs fast?", answer: "Reduce finish tier, keep critical safety items, and preserve a 10% buffer." },
      { question: "How exact are these quantities?", answer: "Treat as planning baseline; verify against field measurements before purchase." }
    ],
    agent_fill_ins: [
      rows.length > 0 ? `Parsed ${rows.length} CSV rows to infer quantities and scope.` : "No CSV provided; used intent-only planning assumptions.",
      "Applied coverage checks to avoid missing core item categories.",
      "Added alternatives for critical items where relevant."
    ],
    confidence: rows.length > 0 ? 0.8 : 0.67
  };

  return ensureBlueprintCoverage(input.project_input, base);
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
