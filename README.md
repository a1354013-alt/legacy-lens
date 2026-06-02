# Legacy Lens

Legacy Lens is a **legacy static analyzer and project import workspace**. It imports Go / SQL / Delphi projects (ZIP upload or Git clone), runs deterministic server-side analysis, persists results in MySQL, and lets you **export a reviewable ZIP report** generated from the same persisted snapshot.

Legacy Lens should be positioned as a **legacy impact review assistant**. Its reports support human code review and modernization planning; they do not replace manual review, compiler-grade semantic analysis, or runtime validation.

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
- legacy encoding detection + persisted stable import warnings
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

## Accuracy Posture

- Legacy Lens uses heuristic, regex-driven, and line-based analysis in many Go, SQL, Delphi, and DFM paths.
- Results are intended to support human code review and legacy impact review, not to serve as a fully authoritative semantic model.
- Known weak spots include dynamic SQL, complex Delphi inheritance chains, DFM/runtime mismatches, Go interface dispatch, and cross-package type resolution.
- Exported reports should be reviewed alongside skipped-file warnings, degraded-file warnings, and surrounding source code before changes ship.

## Architecture (High Level)

```text
Browser (React/Vite)
  -> tRPC client
       -> Express + tRPC (Node)
            -> Import (ZIP/Git) -> files table
            -> Analyze -> symbols/dependencies/fields/risks/rules tables
            -> Export ZIP -> generated from persisted analysisResults snapshot

MySQL (Drizzle ORM)
  -> projects (status + import warnings)
  -> files
  -> symbols / dependencies
  -> fields / fieldDependencies
  -> risks / rules
  -> analysisResults (documents + metrics + warnings)
  -> projectJobs (DB-backed import/analyze queue + recovery state)
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
- `import-warnings.json`
- `FLOW.md`
- `DATA_DEPENDENCY.md`
- `RISKS.md`
- `RULES.yaml`
- `IMPACT_ANALYSIS.md`
- `impact-analysis.json`

`IMPACT_ANALYSIS.md` and `impact-analysis.json` are generated from the persisted project snapshot and summarize:
- total files / symbols / dependencies / risks / rules
- top impacted files (dependency/risk/rule-driven impact signals)
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

`focusLanguage` records the primary report focus language for the project. It is not a hard filter: Legacy Lens still scans other supported languages so cross-file and cross-language relationships remain visible in the exported report.

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

## Target Environment

Legacy Lens currently targets CI and local acceptance with:
- Node.js `22.18.0` in CI and Docker
- pnpm `10.4.1`

`package.json#packageManager` is the single source of truth for pnpm. CI uses `pnpm/action-setup` without a duplicated version override so `pnpm install --frozen-lockfile` stays aligned with the repo lockfile.

## Quick Start (Local)

### Prerequisites
- Node.js 22.x (`>=20 <23`, verified with `22.18.0`)
- pnpm 10.4.1 (via `packageManager`)
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
- `DEV_AUTH_BYPASS_UNSAFE_ALLOW` exists only for local/demo containers that still run with `NODE_ENV=production` for static asset serving. It must never be enabled in a real production deployment.

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

This repo ships a Dockerfile plus separate compose files for demo and production-like runs.

### Demo mode (local only)

`docker-compose.demo.yml` is for local demos and smoke tests only:
- `DEV_AUTH_BYPASS=1` (server enables `/api/dev/login`)
- `DEV_AUTH_BYPASS_UNSAFE_ALLOW=1` (explicitly allows bypass even when the container runs with `NODE_ENV=production` for static serving)
- `VITE_DEV_AUTH_BYPASS=1` (client builds the "Sign in" button to hit `/api/dev/login`)
- OAuth URLs are still required as placeholders (`VITE_OAUTH_PORTAL_URL` / `OAUTH_SERVER_URL`) because the server config schema is consistent across modes.
- `JWT_SECRET` demo default is long enough for runtime validation, but you must replace it in any real deployment.

#### One-click Demo Start

On Windows, double-click:

```text
start-demo.cmd
```

This starts the local demo stack with Docker Compose:
- MySQL
- migrations
- Legacy Lens app
- dev-only auth bypass

Open:

```text
http://localhost:3000
```

Click **Sign in** to enter the demo.

To stop:

```bash
pnpm demo:down
```

To reset the demo database:

```bash
pnpm demo:reset
```

```bash
pnpm demo
```

The demo compose file brings up MySQL, waits for the one-shot `migrate` service to finish, and only then starts `app`.

If you want to run migrations manually without starting the app:
```bash
docker compose -f docker-compose.demo.yml run --rm migrate
```

To run migration smoke locally against a dedicated MySQL database:
```bash
DATABASE_URL=mysql://root:password@127.0.0.1:3306/legacy_lens_dev pnpm test:migration
```

### Production-like mode

`docker-compose.yml` extends `docker-compose.prod.yml` and does not enable demo auth, weak demo secrets, or fake users. It expects production-like environment values:

```bash
APP_VERSION=1.0.0 \
DATABASE_URL=mysql://user:password@host:3306/legacy_lens \
JWT_SECRET=replace-with-at-least-32-characters \
VITE_APP_ID=your-app-id \
VITE_OAUTH_PORTAL_URL=https://oauth.example.com \
OAUTH_SERVER_URL=https://oauth.example.com \
docker compose up --build
```

Do not set `DEV_AUTH_BYPASS`, `VITE_DEV_AUTH_BYPASS`, or `DEV_AUTH_BYPASS_UNSAFE_ALLOW` for production-like runs.

If you want to verify the full demo container flow end-to-end (build -> migrate -> app health -> dev login redirect):
```bash
pnpm docker:smoke
```

Port notes:
- Demo compose defaults to `3000` for the app and `3306` for MySQL.
- Production-like compose binds only the app port and expects `DATABASE_URL` to point at an existing MySQL-compatible database.
- You can override host ports with `LEGACY_LENS_PORT` / `LEGACY_LENS_DB_PORT`, which is what the smoke test does in CI to avoid collisions.
- On Windows, set alternate ports before starting the demo with:

```powershell
$env:LEGACY_LENS_PORT=3100
$env:LEGACY_LENS_DB_PORT=3310
.\start-demo.cmd
```

### Docker Smoke / CI Environment Variables

The Docker smoke script and compose stack use a small set of env vars to keep CI deterministic:

- `LEGACY_LENS_PORT`: host port bound to container port `3000`
- `LEGACY_LENS_DB_PORT`: host port bound to MySQL `3306`
- `LEGACY_LENS_SMOKE_TIMEOUT_MS`: total polling timeout for DB health, app health, and dev-login redirect checks
- `DEV_AUTH_BYPASS=1`: enables `/api/dev/login` for local/demo flows only
- `DEV_AUTH_BYPASS_UNSAFE_ALLOW=1`: only for local/demo containers that keep `NODE_ENV=production`; never use in real production
- `LEGACY_LENS_GIT_HOST_ALLOWLIST`: production Git host allowlist override
- `LEGACY_LENS_TRUST_PROXY`: only set this when the app is actually behind a trusted reverse proxy or load balancer

The CI smoke flow randomizes `COMPOSE_PROJECT_NAME`, `LEGACY_LENS_PORT`, and `LEGACY_LENS_DB_PORT` so parallel jobs do not collide on the same runner.

Open `http://localhost:3000`.

Operational notes:
- `app` does not run migrations.
- `migrate` is the only container that runs `pnpm db:migrate`.
- The production app image keeps production dependencies only; it is not expected to contain `drizzle-kit`.

## Usage Flow (Import -> Analyze -> Export)

1. Create a project
2. Import source (ZIP or Git URL)
3. Wait for the persisted import job to complete
4. Run analysis as a separate persisted job
5. Review the persisted snapshot + paged detail views in the UI
6. Export report ZIP (generated from persisted analysis only)

Report downloads should use `GET /api/projects/:projectId/report.zip` so large report archives are returned as an `application/zip` response instead of relying on a base64 tRPC query payload. The legacy tRPC `analysis.downloadReport` query remains available only for compatibility and should be treated as deprecated.

Project imports should use `POST /api/projects/:projectId/upload` with `multipart/form-data`. The legacy tRPC `projects.uploadFiles` mutation remains available only for small compatibility payloads and is intentionally capped at 2MB raw ZIP content to avoid storing large base64 archives in job payloads.
The multipart upload route is protected by an Express upload rate limiter before `multer` starts parsing the request body, so repeated large-file uploads are rejected with `429` before temp files are written.

Multipart request examples:

```bash
# ZIP upload
curl -X POST "http://localhost:3000/api/projects/42/upload" \
  -H "Cookie: app_session_id=..." \
  -F "file=@./project.zip;type=application/zip"

# Git import through the same multipart endpoint
curl -X POST "http://localhost:3000/api/projects/42/upload" \
  -H "Cookie: app_session_id=..." \
  -F "gitUrl=https://github.com/example/repo.git"
```

Upload/report error contract:
- `401`: unauthenticated or invalid session
- `404`: project not found (per the current ownership-hiding strategy)
- `409`: conflicting project/job state such as an already-active import/analysis job or a report that is not ready yet
- `413`: upload/report archive exceeds the configured size limit
- `429`: route-specific rate limit exceeded
- `500`: database or unexpected internal failure

ZIP safety contract:
- Unsupported or malformed archives return `ZIP_INVALID`.
- Non-`.zip` file uploads are rejected with `ZIP_INVALID`; the backend does not rely on the browser `accept=".zip"` hint.
- Any unsafe archive path such as `../evil.go`, `/absolute/main.go`, `C:/windows/evil.go`, or nested traversal segments rejects the entire archive with `ZIP_UNSAFE_PATH`.
- Unsafe ZIP entries are never partially skipped. Fix the archive and upload it again.

### Job Model

- ZIP import, Git import, and analysis are queued as persisted `projectJobs` records.
- `projectJobs` is the single source of truth for queued/running/completed/failed work; process memory is only a local execution aid.
- Job status values: `queued`, `running`, `completed`, `failed`.
- The queue is DB-backed and restart-safe: startup recovery re-queues stale `running` jobs, resumes `queued` jobs, and marks stuck `importing` / `analyzing` projects as failed when no active job still exists.
- The system supports multiple web replicas. Worker replicas are supported when they share the same MySQL database and preserve the current conditional-update semantics.
- Each running job carries `lockedBy`, `leaseUntil`, `heartbeatAt`, `attemptCount`, and `maxAttempts` so multiple workers can coordinate through DB leases.
- Claiming uses a DB-selected candidate plus an atomic conditional update. Competing workers may examine the same candidate row, but only one claim update is allowed to win for a given lease window.
- Running jobs extend their lease through periodic heartbeats while work is in flight. Heartbeats, retry decisions, and finalization are ownership-fenced with `lockedBy + attemptCount`, so stale workers cannot overwrite a reclaimed job or its project state.
- If a worker dies and the lease expires, another worker may safely reclaim the job until its retry budget is exhausted. Stale worker finalization is rejected and logged instead of clearing the new worker's lease.
- Startup recovery respects still-valid leases. Legacy rows without lease metadata fall back to the older stale-window heuristic instead of being reset immediately.
- If a deployment cannot provide reliable shared-MySQL transaction and conditional-update semantics, run a single worker replica instead of weakening the claim logic.
- SQLite or in-memory test doubles are not the target for multi-worker deployment guarantees; the distributed-safe claim path assumes shared MySQL state.
- `PROJECT_JOB_STALE_MS` controls when a running job is treated as stale during startup recovery (default `900000` / 15 minutes).
- The UI polls project state plus the latest job state instead of waiting on a single long-running request.
- The backend enforces one active job per project across `import_zip`, `import_git`, and `analyze`; conflicting requests fail with a stable conflict error instead of relying on disabled buttons.
- Projects with active queued/running jobs cannot be deleted. This avoids dangling state while an import/analyze workflow is still in progress.

## Analysis Limitations

Legacy Lens provides heuristic impact analysis intended to guide code review. It is not a compiler-grade guarantee of complete call graph or data lineage coverage.

- Dynamic SQL may not be fully resolved.
- Go interface dispatch, reflection, and dynamic calls may not be fully traced.
- Delphi `with`, inheritance-heavy flows, and DFM/source mismatches can reduce precision.
- Treat the report as the start of code review and change planning, not as the only source of truth.

### Snapshot / Pagination Model

- `analysis.getSnapshot` is now a light summary payload only.
- Symbols, Fields, Risks, Rules, Dependencies, and FieldDependencies are fetched through dedicated paged APIs.
- Page input is bounded to `pageSize <= 100`.
- Heavy read endpoints have their own rate limiter and a consistent `429` message.
- Procedure-level tRPC middleware applies rate-limit buckets per procedure path, so `httpBatchLink` batching cannot bypass upload/import, clone, analysis-trigger, or heavy-read limits.

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

Demo walkthrough:
1. Start the app with `pnpm dev` or `docker compose -f docker-compose.demo.yml up --build`
2. Sign in with dev auth bypass
3. Create a project and import `samples/go/`, `samples/sql/`, or `samples/delphi/`
4. Run analysis
5. Download the report from the result page using the HTTP ZIP route

## Health / System Info

- Liveness: `GET /health`
- Readiness: `GET /ready`
- Full health (includes DB check, version, commit hash, and degraded-state details): `GET /api/health`
- tRPC system health: `GET /api/trpc/system.health`

Endpoint semantics:
- `/health` only confirms that the HTTP server process is alive enough to answer requests.
- `/ready` is the deploy-time readiness gate and returns success only when required runtime checks are available.
- `/api/health` remains the detailed diagnostics endpoint and may return `206` for degraded-but-still-running states.

## Language / i18n Status

- The current portfolio UI primarily targets **Traditional Chinese**.
- A lightweight locale helper exists, but the product is not yet fully localized end-to-end.
- New UI work should prefer the existing locale layer where practical instead of adding more ad-hoc hard-coded strings.

Version is sourced from `APP_VERSION` first, then `npm_package_version`, then `package.json`. If no reliable value exists, health reports `unknown` rather than an incorrect `0.0.0`. `GIT_COMMIT` is reported when injected; otherwise commit hash is `unknown`.

## Scripts

| Command | Description |
|---|---|
| `pnpm dev` | Dev server (Vite + API) |
| `pnpm build` | Build client + bundle server to `dist/` |
| `pnpm start` | Run production server from `dist/` |
| `pnpm lint` | ESLint |
| `pnpm check` | Typecheck (app + tests) |
| `pnpm test` | Vitest |
| `pnpm test:migration` | Run migration smoke against a real MySQL database (`DATABASE_URL` required) |
| `pnpm demo` | Start the local Docker demo stack with MySQL and dev auth bypass |
| `pnpm demo:down` | Stop the local Docker demo stack |
| `pnpm demo:reset` | Stop the local Docker demo stack and remove its demo database volume |
| `start-demo.cmd` | Windows one-click launcher for the local Docker demo stack |
| `pnpm db:migrate` | Apply Drizzle migrations |

Docker equivalents:
- `pnpm demo` or `docker compose -f docker-compose.demo.yml up --build` -> local demo stack with MySQL and dev auth bypass
- `pnpm demo:down` or `docker compose -f docker-compose.demo.yml down` -> stop the local demo stack
- `pnpm demo:reset` or `docker compose -f docker-compose.demo.yml down -v` -> reset the local demo database
- `docker compose up --build` -> production-like app/migrate flow using external `DATABASE_URL`
- `docker compose -f docker-compose.demo.yml run --rm migrate` -> run demo migrations only
- `pnpm docker:smoke` -> build the compose stack, verify `/health`, `/ready`, `/api/health`, and demo dev-login redirect, then tear it down

## Dependency Security Notes

- `package.json` keeps a small `pnpm.overrides` block for transitive packages that were still flagged by `pnpm audit --audit-level high` after the direct dependency upgrades.
- Current overrides are intentionally limited to security patches for `path-to-regexp`, `rollup`, `picomatch`, `tar`, `lodash`, and `lodash-es`.
- When upstream packages adopt the patched transitive versions directly, prefer removing the override instead of letting the list grow.
- Moderate findings are tracked in [docs/security-audit-accepted-risks.md](docs/security-audit-accepted-risks.md).

## Import Safety Boundaries

Import pipeline is intentionally bounded:
- Shared raw ZIP upload limit: 30MB per `.zip` before base64 encoding (`MAX_UPLOAD_BYTES` / `MAX_ZIP_RAW_BYTES`)
- HTTP JSON body limit is derived from the same raw ZIP limit with base64 overhead headroom (`JSON_UPLOAD_BODY_LIMIT_BYTES`)
- Legacy tRPC base64 ZIP upload is compatibility-only and capped at 2MB raw ZIP content; normal imports should use the multipart upload route instead of embedding archive data in JSON
- ZIP: max 10,000 total archive entries, max 2,000 supported source files, max 5MB per source file, max 500MB expanded supported source content
- Git: max 2,000 supported source files, max 5MB per source file, max 500MB total supported source content
- ZIP extraction does not trust compressed size alone: central-directory metadata and streaming extraction enforce per-file extracted bytes and total extracted bytes before content can grow unbounded in memory
- Oversize individual source files are skipped with a stable `IMPORT_FILE_TOO_LARGE` warning so the rest of the import can continue
- ZIP and Git imports both preserve import warnings in the persisted project snapshot and exported report
- Temporary upload cleanup protects active `import_zip` jobs: expired temp ZIPs are deleted only when no queued/running job payload still references that file path
- Large result sets are never returned from the summary snapshot; the UI reads detail pages through backend pagination
- Generated report archives are bounded by a server-side ZIP size ceiling before download
- Report export performs a preflight size estimate before ZIP generation so oversized archives fail fast without first allocating the full buffer in memory
- Archive / repository import fails only for whole-import safety boundaries such as invalid ZIP content, unsafe ZIP paths, total supported-source bytes, or supported-source file-count limits
- Production Git host policy:
  - loopback hosts are blocked (`localhost`, `127.0.0.1`, `0.0.0.0`, `::1`)
  - private / link-local IPs are blocked
  - production mode defaults to `github.com` and `gitlab.com`
  - override with `LEGACY_LENS_GIT_HOST_ALLOWLIST=github.com,gitlab.com,example.com`
- DNS resolution is performed during validation and rejected if the resolved address is loopback, link-local, or private
- `importProjectGit()` reuses the validated Git URL metadata so a single import flow does not repeat DNS resolution before clone
- Git clone includes application-layer host/IP validation, but app-level DNS and IP validation are not a complete SSRF boundary by themselves
- Production deployments should keep `LEGACY_LENS_GIT_HOST_ALLOWLIST` narrow and also restrict outbound egress at the network/container/platform layer
- DNS rebinding / TOCTOU risk cannot be eliminated purely in app code; use deployment-layer egress controls to reduce that residual risk
- Higher-security environments should run Git clone/import in an isolated worker or container instead of the main web process
- `LEGACY_LENS_TRUST_PROXY` should stay unset unless the app is deployed behind a trusted reverse proxy/load balancer; enabling it on a directly exposed app weakens client IP handling for rate limits and cookies
- ZIP path traversal defense: unsafe archive paths (e.g. `../`, absolute paths, or drive-letter paths) reject the whole archive
- Git path traversal / symlink escape defense: unsafe resolved paths are skipped and recorded as import warnings
- Imported source content is persisted in MySQL `MEDIUMTEXT`, which comfortably covers the 5MB per-file import ceiling

## Analysis Status Semantics

- `completed`: analysis produced a usable result and no files were skipped or degraded.
- `partial`: analysis produced a usable result, but at least one file was skipped, degraded, or only partially parsed.
- `failed`: analysis produced no usable result, or the core workflow failed.
- Heuristic notes remain visible in warnings, but heuristic analysis alone does not force `partial`.

## Limitations (Honest)

- Parsing is **heuristic static analysis**, not a compiler, language server, or full semantic index.
- SQL / Delphi / Go extraction is meant to support legacy code exploration, initial dependency review, and first-pass impact analysis.
- Delphi `.pas` / `.dpr` parsing is best-effort; `.dfm`, `.fmx`, `.dpk`, and `.inc` are imported with limited analysis warnings.
- DFM event metadata can now emit UI event -> Pascal handler dependencies for straightforward `OnClick`-style bindings, but this still remains heuristic and should be verified during review.
- SQL extraction handles common table/field and query patterns but is not a complete SQL parser, optimizer, or execution-plan analyzer.
- Go extraction focuses on structural symbols and dependencies; it does not replace `go/types`, `gopls`, build tags, or module-aware compilation.
- Go interface dispatch and package-alias-based construction are not resolved with compiler-grade certainty.
- Complex Delphi inheritance, `with` blocks, runtime component wiring, and dataset ownership can still require manual review.
- Dynamic SQL field extraction is incomplete for heavily constructed SQL strings.
- Results do **not** replace a compiler, runtime tracing, DB execution plan analysis, or a full SQL AST parser.
- Mixed-language repos are supported; the **Focus language** is the primary report focus language, not an analysis filter.
- Import is capped at 5MB per file and 500MB total extracted content by design.
- Analysis and impact output remain heuristic even when the status is `completed`; review warnings, skipped files, and degraded files before treating results as source-of-truth.
- Large report archives may exceed the export cap; in that case split the analysis into smaller project slices or raise `MAX_REPORT_ARCHIVE_BYTES` deliberately after reviewing infrastructure impact.

## Additional Docs

- Architecture notes: [docs/architecture.md](docs/architecture.md)
- Deployment notes: [docs/deployment.md](docs/deployment.md)
- Known limitations: [docs/known-limitations.md](docs/known-limitations.md)
- Testing notes: [docs/testing.md](docs/testing.md)
- Accepted audit risks: [docs/security-audit-accepted-risks.md](docs/security-audit-accepted-risks.md)

## Demo vs Production

- `docker-compose.demo.yml` is tuned for local demo convenience, not hardened production rollout.
- `docker-compose.yml` / `docker-compose.prod.yml` are production-like and do not enable demo auth by default.
- `DEV_AUTH_BYPASS`, `VITE_DEV_AUTH_BYPASS`, and `DEV_AUTH_BYPASS_UNSAFE_ALLOW` must not be enabled in production.
- `JWT_SECRET` must be at least 32 characters in production and local runtime validation.
- Production Git import should use `LEGACY_LENS_GIT_HOST_ALLOWLIST`.
- `LEGACY_LENS_TRUST_PROXY` should be enabled only when Legacy Lens sits behind a trusted reverse proxy/load balancer.
- `APP_VERSION` should be injected in production-like Docker and compose runs so health/report metadata show the deploy version deterministically.
- Production network policy should restrict outbound Git egress even if host allowlisting is configured.
- Production deployments should review network policy, DB credentials, OAuth settings, and container secrets separately from this demo setup.

## Acceptance Commands

Use these commands for local acceptance before shipping changes:

```bash
corepack prepare pnpm@10.4.1 --activate
pnpm install --frozen-lockfile
pnpm audit --audit-level high
pnpm check
pnpm lint
pnpm test
pnpm test:migration
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
- ingestion preflight report

## License

MIT
