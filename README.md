# Legacy Lens

Legacy Lens is a **legacy modernization analysis workspace**. It imports Go / SQL / Delphi projects (ZIP upload or Git clone), runs deterministic server-side analysis, persists results in MySQL, and lets you **export a reviewable ZIP report** generated from the same persisted snapshot.

Positioning:
- portfolio-grade
- demo-ready
- legacy modernization analysis workspace

## What It Does (Today)

- Import via **ZIP upload** or **Git clone**
- Normalize + persist source files (encoding detection, size limits, warnings)
- Analyze and persist:
  - symbols (functions/procedures/methods/classes/queries/tables)
  - dependencies (calls/reads/writes/references)
  - field references (read/write/calculate)
  - risks + derived rules (heuristics)
  - documents (`FLOW.md`, `DATA_DEPENDENCY.md`, `RISKS.md`, `RULES.yaml`)
- Export a ZIP report generated **only from persisted analysis**

Highlights (why this repo is portfolio-worthy):
- Delphi support (including limited-analysis import for `.dfm` / `.fmx` / `.dpk` / `.inc`)
- SQL field read/write extraction (heuristic)
- legacy encoding detection + stable import warnings
- persisted snapshot as the single source of truth
- deterministic, exportable review artifact (ZIP)

## Supported Languages (Import + Analysis)

| Language | Extensions | Notes |
|---|---|---|
| Go | `.go` | heuristic symbol/dependency extraction |
| SQL | `.sql` | heuristic query/table/field extraction |
| Delphi | `.pas`, `.dpr`, `.delphi` | heuristic unit analysis |
| Delphi related | `.dfm`, `.inc`, `.dpk`, `.fmx` | imported with **limited analysis** warnings |

Unsupported languages are skipped with explicit import warnings.

## Architecture (High Level)

```text
Browser (React/Vite)
  -> tRPC client
       -> Express + tRPC (Node)
            -> Import (ZIP/Git) -> files table
            -> Analyze -> symbols/dependencies/fields/risks/rules tables
            -> Export ZIP -> generated from persisted analysisResults snapshot

MySQL (Drizzle ORM)
  -> projects
  -> files
  -> symbols / dependencies
  -> fields / fieldDependencies
  -> risks / rules
  -> analysisResults (documents + metrics + warnings)
```

## Architecture Snapshot (Data Flow)

```text
ZIP / Git
  v
Normalizer
  v
Database (persisted snapshot)
  v
Analyzer
  v
Export ZIP
```

## Quick Start (Local)

### Prerequisites
- Node.js 20+
- pnpm 10+
- MySQL 8+ (or compatible provider)

### 1) Configure env

Copy:
```bash
cp .env.example .env
```

Minimum required variables (all modes):
- `DATABASE_URL`
- `JWT_SECRET`
- `VITE_APP_ID`
- `VITE_OAUTH_PORTAL_URL` (placeholder OK when dev auth bypass is enabled)
- `OAUTH_SERVER_URL` (placeholder OK when dev auth bypass is enabled)

#### Local dev without OAuth (recommended for demos)

Legacy Lens supports a **dev-only auth bypass** that keeps the same cookie/session path but avoids setting up an OAuth provider.
This is useful for demos and local development, but must never be enabled in production.

In `.env` set:
```bash
DEV_AUTH_BYPASS=1
VITE_DEV_AUTH_BYPASS=1
DEV_AUTH_OPEN_ID=local-dev-user
```

Important notes:
- Bypass does **not** remove the need for OAuth env variables. The server still validates `VITE_OAUTH_PORTAL_URL` / `OAUTH_SERVER_URL` as required placeholders.
- While bypass is enabled, the UI "Sign in" button uses `/api/dev/login` instead of starting an OAuth redirect.

Dev login flow:
- UI "Sign in" navigates to `/api/dev/login?next=/...` (controlled by `VITE_DEV_AUTH_BYPASS`)
- Server sets the session cookie (`app_session_id`)
- Default identity is `DEV_AUTH_OPEN_ID` (fallback: `local-dev-user`)

Logout flow:
- UI "Sign out" calls `POST /api/trpc/auth.logout` to clear the session cookie
- In bypass mode, `/api/dev/logout?next=/` is also available

### 2) Install deps
```bash
pnpm install
```

### 3) Run migrations
```bash
pnpm db:migrate
```

### 4) Start dev server
```bash
pnpm dev
```

Open `http://localhost:3000`. Click "Sign in".

## Quick Start (Docker)

This repo ships a Dockerfile and a `docker-compose.yml` for running the app + MySQL locally (a production-like image intended for reproducible runs).

Note: `DEV_AUTH_BYPASS` is disabled when `NODE_ENV=production`, so Docker runs require a real OAuth provider (or a compatible stub).

```bash
docker compose up --build
```

Then run migrations once (in another terminal):
```bash
docker compose exec app pnpm db:migrate
```

Open `http://localhost:3000`.

## Usage Flow (Import -> Analyze -> Export)

1. Create a project
2. Import source (ZIP or Git URL)
3. Run analysis (server-side, persisted)
4. Review the persisted snapshot in the UI
5. Export report ZIP (generated from persisted analysis only)

## Samples

The `samples/` folder contains small fixtures you can ZIP for import:

```text
samples/
  go/
  sql/
  delphi/
```

Example:
1. Zip `samples/go/` into `samples-go.zip`
2. Import the ZIP in the UI
3. Run analysis
4. Download the report

## Health / System Info

- Liveness: `GET /health`
- Full health (includes DB check + version): `GET /api/health`
- tRPC system health: `GET /api/trpc/system.health`

Version is sourced from `package.json` (with `npm_package_version` as a fast path when available).

## Scripts

| Command | Description |
|---|---|
| `pnpm dev` | Dev server (Vite + API) |
| `pnpm build` | Build client + bundle server to `dist/` |
| `pnpm start` | Run production server from `dist/` |
| `pnpm lint` | ESLint |
| `pnpm check` | Typecheck (app + tests) |
| `pnpm test` | Vitest |
| `pnpm db:migrate` | Apply Drizzle migrations |

## Import Safety Boundaries

Import pipeline is intentionally bounded:
- ZIP: max 2,000 entries, max 5MB per file, max 500MB expanded
- Git: max 2,000 files, max 5MB per file, max 500MB total extracted
- Path traversal defense: unsafe paths (e.g. `../`, absolute paths, or drive-letter paths) are skipped with warnings

## Limitations (Honest)

- Parsing is **heuristic**, not compiler-grade.
- Cross-file Delphi resolution is best-effort.
- Dynamic SQL field extraction is incomplete for heavily constructed SQL strings.
- Mixed-language repos are supported; the **Focus language** is a UI/navigation lens, not an analysis filter.

## Roadmap (Not Implemented Yet)

These are intentionally not half-shipped in code:
- analysis diff / snapshot compare
- interactive dependency graph
- custom rule packs
- Delphi form event mapping
- ingestion preflight report

## License

MIT
