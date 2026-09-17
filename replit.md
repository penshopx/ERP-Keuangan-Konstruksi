# Konstruksi Finance ERP

A construction-focused ERP for project finance, RAB budgeting, cost control, billing, tax, retention, and audit workflows.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/construction-erp` — React web application
- `artifacts/api-server` — Express API and demo domain data
- `lib/api-spec/openapi.yaml` — source of truth for API contracts
- `artifacts/construction-erp/src/index.css` — dark blue product theme

## Architecture decisions

- Tax rates and DPP formulas must become effective-dated configuration before production use.
- Posted financial transactions will be immutable; corrections use reversals.
- Approved RAB versions are baselines; revisions create a new version rather than overwriting history.

## Product

The app includes a portfolio dashboard, project creation and detail, reusable RAB templates with versioned import, RAB cost control, automatic invoice tax calculations, monthly tax summaries, and an immutable-style audit timeline.

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

_Populate as you build — sharp edges, "always run X before Y" rules._

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
- See `docs/blueprints/ai-construction-erp.md` for the vendor-neutral AI Construction ERP architecture, governance model, module scope, and phased roadmap.
- See `docs/references/odoo-construction-erp.md` for the curated process reference extracted from uploaded Odoo construction materials; it is not a product specification or regulatory authority.
- See `docs/references/erabe-rab-project-workflow.md` for curated RAB, progress, field access, and reconciliation patterns from ERAbe; vendor claims and example values are not authoritative.
