# Legacy Lens

Legacy Lens is a **legacy static analyzer and project import workspace**. It imports Go / SQL / Delphi projects (ZIP upload or Git clone), runs deterministic server-side analysis, persists results in MySQL, and lets you **export a reviewable ZIP report** generated from the same persisted snapshot.

Positioning:
- portfolio-grade
- demo-ready
- legacy modernization analysis workspace

## Product Positioning

Legacy Lens is intentionally focused on:
- legacy code analyzer
- project import workspace (ZIP / Git)
- static analysis and impact analysis assistant
- report export tool for modernization review

It is intentionally **not** positioned as:
- chat bot
- RAG knowledge base
- runtime tracing platform
- replacement for a compiler or DB query planner

## What It Does (Today)

- Import via **ZIP upload** or **Git clone**
- Normalize + persist source files (encoding detection, size limits, warnings)
- Analyze and persist:
  - symbols (functions/procedures/methods/classes/queries/tables)
  - dependencies (calls/reads/writes/references)
  - field references (read/write/calculate)
  - risks + derived rules (heuristics)
  - documents (`FLOW.md`, `DATA_DEPENDENCY.md`, `RISKS.md`, `RULES.yaml`, `IMPACT_ANALYSIS.md`)
- **Impact Analysis**: Trace potential breaking changes across symbols, SQL tables, fields, risks, and rules.
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
Persisted Snapshot (DB)
  v
Analyzer
  v
Export Report ZIP
```

## Example Output

```text
Representative sample (from `analysis-summary.json` inside an exported report ZIP; values vary by project size):
fileCount: 1284
symbolCount: 14228
dependencyCount: 3912
warningCount: 12
```

## Report ZIP Contents (Persisted + Deterministic)

The exported ZIP is generated **only** from the persisted server-side snapshot (DB), and the same snapshot yields the same ZIP output.

Files at the ZIP root:
- `metadata.json` (audit/replay metadata)
- `analysis-summary.json` (metrics + warnings summary)
- `FLOW.md`
- `DATA_DEPENDENCY.md`
- `RISKS.md`
- `RULES.yaml`
- `IMPACT_ANALYSIS.md`
- `impact-analysis.json`

`IMPACT_ANALYSIS.md` and `impact-analysis.json` are generated from the persisted project snapshot and summarize:
- total files / symbols / dependencies / risks / rules
- top impacted files
- top dependencies
- high-risk items
- business rules summary

Minimal excerpt (shape) of `metadata.json`:

```json
{
  "projectName": "…",
  "analysisVersion": "…",
  "createdAt": "…",
  "focusLanguage": "go|sql|delphi",
  "fileCount": 0,
  "symbolCount": 0,
  "dependencyCount": 0,
  "warningCount": 0
}
```

## Example Import Warnings (Human-Readable + Stable)

Import is intentionally bounded and produces stable warning codes/messages instead of stack traces.
Common examples you may see in the UI:

```text
IMPORT_UNSAFE_PATH: ../evil.go - The file was skipped because its path is not a safe relative path.
IMPORT_LANGUAGE_UNSUPPORTED: legacy.ts - The file was skipped because Legacy Lens currently supports import analysis only for Go, SQL, and Delphi.
IMPORT_LIMITED_ANALYSIS: Form1.dfm - The file was imported, but only limited Delphi analysis is available for this file type.
IMPORT_ENCODING_DETECTED: legacy.pas - Detected encoding: Big5 (confidence: 86%). Content decoded with big5. Legacy encoding may cause analysis issues.
IMPORT_FILE_TOO_LARGE: big.sql - The file was skipped because it exceeds the maximum supported size (5MB).
```

## What Makes This Repo Strong

- Deterministic server-side analysis with bounded ingestion (ZIP/Git limits + stable warnings)
- Persisted snapshot as the source of truth (UI reads persisted records; export is generated from the same snapshot)
- Legacy encoding awareness during import (explicit detection + human-readable warnings)
- Exportable review artifact (ZIP report with stable structure + `metadata.json` for audit/replay)

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
- `VITE_OAUTH_PORTAL_URL` (must be set; placeholder OK when dev auth bypass is enabled)
- `OAUTH_SERVER_URL` (must be set; placeholder OK when dev auth bypass is enabled)

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

This repo ships a Dockerfile and a `docker-compose.yml` for running the app + MySQL locally in a reproducible way.

By default, `docker-compose.yml` runs in **local demo mode**:
- `DEV_AUTH_BYPASS=1` (server enables `/api/dev/login`)
- `DEV_AUTH_BYPASS_UNSAFE_ALLOW=1` (explicitly allows bypass even when the container runs with `NODE_ENV=production` for static serving)
- `VITE_DEV_AUTH_BYPASS=1` (client builds the "Sign in" button to hit `/api/dev/login`)
- OAuth URLs are still required as placeholders (`VITE_OAUTH_PORTAL_URL` / `OAUTH_SERVER_URL`) because the server config schema is consistent across modes.
- `JWT_SECRET` demo default is long enough for runtime validation, but you must replace it in any real deployment.

```bash
docker compose up --build
```

`docker compose up --build` now brings up MySQL, waits for the one-shot `migrate` service to finish, and only then starts `app`.

If you want to run migrations manually without starting the app:
```bash
docker compose run --rm migrate
```

If you want to verify the full demo container flow end-to-end (build -> migrate -> app health -> dev login redirect):
```bash
pnpm docker:smoke
```

Port notes:
- `docker compose` defaults to `3000` for the app and `3306` for MySQL.
- You can override host ports with `LEGACY_LENS_PORT` / `LEGACY_LENS_DB_PORT`, which is what the smoke test does in CI to avoid collisions.

Open `http://localhost:3000`.

Operational notes:
- `app` does not run migrations.
- `migrate` is the only container that runs `pnpm db:migrate`.
- The production app image keeps production dependencies only; it is not expected to contain `drizzle-kit`.

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

Docker equivalents:
- `docker compose up --build` -> start `db`, run `migrate`, then start `app`
- `docker compose run --rm migrate` -> run migrations only
- `pnpm docker:smoke` -> build the compose stack, verify `/health`, `/api/health`, and demo dev-login redirect, then tear it down

## Import Safety Boundaries

Import pipeline is intentionally bounded:
- Frontend ZIP upload preflight: max 30MB per `.zip` before base64 encoding
- HTTP request body limit: 50MB JSON payload to leave room for base64 overhead
- ZIP: max 2,000 entries, max 5MB per file, max 500MB expanded
- Git: max 2,000 files, max 5MB per file, max 500MB total extracted
- Production Git host policy:
  - loopback hosts are blocked (`localhost`, `127.0.0.1`, `0.0.0.0`, `::1`)
  - private / link-local IPs are blocked
  - production mode defaults to `github.com` and `gitlab.com`
  - override with `LEGACY_LENS_GIT_HOST_ALLOWLIST=github.com,gitlab.com,example.com`
  - current validation is enforced at the URL host layer; if you publicly deploy Legacy Lens, pair this with network-layer egress policy because DNS resolution is not yet re-checked against private IP ranges after host allowlisting
- Path traversal defense: unsafe paths (e.g. `../`, absolute paths, or drive-letter paths) are skipped with warnings
- Imported source content is persisted in MySQL `MEDIUMTEXT`, which comfortably covers the 5MB per-file import ceiling

## Limitations (Honest)

- Parsing is **heuristic static analysis**, not compiler-grade.
- SQL / Delphi / Go extraction is meant to support legacy code exploration, initial dependency review, and first-pass impact analysis.
- Cross-file Delphi resolution is best-effort.
- Dynamic SQL field extraction is incomplete for heavily constructed SQL strings.
- Results do **not** replace a compiler, runtime tracing, DB execution plan analysis, or a full SQL AST parser.
- Mixed-language repos are supported; the **Focus language** is a UI/navigation lens, not an analysis filter.
- Import is capped at 5MB per file and 500MB total extracted content by design.

## Demo vs Production

- `docker-compose.yml` is tuned for local demo convenience, not hardened production rollout.
- `DEV_AUTH_BYPASS` must not be enabled in production.
- `JWT_SECRET` must be at least 32 characters in production and local runtime validation.
- Production Git import should use `LEGACY_LENS_GIT_HOST_ALLOWLIST`.
- Production network policy should restrict outbound Git egress even if host allowlisting is configured.
- Production deployments should review network policy, DB credentials, OAuth settings, and container secrets separately from this demo setup.

## Acceptance Commands

Use these commands for local acceptance before shipping changes:

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm lint
pnpm test
pnpm build
pnpm docker:smoke
```

## Impact Analysis

Impact Analysis helps developers understand what may break before changing legacy code. It connects symbols, SQL fields, tables, business rules, and risks into a traceable dependency view, reducing modernization risk.

### Features
- **Auto-detection**: Automatically resolve target type (symbol, file, table, etc.).
- **Impact Tree**: Visual representation of affected components.
- **Dependency Chains**: Trace the path from change to impact.
- **Exportable**: Impact summaries are included in the generated report ZIP.

### API Example
```bash
GET /api/trpc/analysis.getImpact?batch=1&input={"0":{"projectId":1,"target":"EB_SPECI","type":"auto"}}
```

## Roadmap (Not Implemented Yet)

These are intentionally not half-shipped in code:
- analysis diff / snapshot compare
- interactive dependency graph
- custom rule packs
- Delphi form event mapping
- ingestion preflight report

## License

MIT
