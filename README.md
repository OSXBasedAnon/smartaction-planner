# SupplyFlare Blueprint Agent

SupplyFlare is now a Gemini-powered project planning app for DIY and small trade workflows.

## What It Does
- Accepts open-ended project prompts (example: "rewire my basement", "remodel kitchen", "meal prep grocery plan").
- Accepts optional CSV input and uses it to infer scope and quantities.
- Generates structured JSON blueprint:
  - step workflow
  - visual diagram model
  - materials and tools list
  - budget bands and cost breakdown
  - safety notes, field tips, and Q&A
- Renders a two-pane workspace:
  - left: workflow, diagram, tips, assumptions
  - right: editable materials/tools and live totals

## Main Route
- UI: `/`
- API: `POST /api/project-plan`

## API Payload
```json
{
  "project_input": "rewire my basement",
  "csv_input": "item,qty\noutlet box,8",
  "budget_target": 1500
}
```

## API Response
```json
{
  "source": "gemini",
  "blueprint": { "...": "structured plan object" }
}
```

If Gemini is unavailable or returns invalid JSON, the app automatically returns a deterministic fallback blueprint.

## Environment
- `GEMINI_API_KEY` (optional but recommended)
- Existing Supabase variables can remain for auth pages.

## Local Dev
```bash
npm install
npm run dev
```

## Notes
- This pivot removed the quote scraping entry path.
- The old Rust scraper stack has been removed from this project.
