# PlateauBreaker

PlateauBreaker is a web app for importing a legacy codebase, running a lightweight structural analysis, and producing downloadable report artifacts.

The current release focuses on the main delivery path only:

- create a project
- import source from ZIP or Git
- persist extracted files to MySQL
- run analysis and write results back to the database
- inspect the saved result in the UI
- download a real ZIP report
- delete the full project graph

## What it currently supports

- Source languages:
  - Go
  - SQL
  - Delphi (`.pas`, `.dpr`, `.delphi`)
- Import sources:
  - ZIP upload
  - Git repository clone
- Saved analysis artifacts:
  - symbols
  - symbol dependencies
  - fields
  - field dependencies
  - risks
  - derived rules
  - Markdown/YAML documents
- Report export:
  - ZIP archive containing `FLOW.md`, `DATA_DEPENDENCY.md`, `RISKS.md`, `RULES.yaml`, and `analysis-summary.json`

## What it does not claim to do

- It is not a full compiler-grade semantic analyzer.
- Multi-language repositories are accepted, but unsupported files are skipped and surfaced as warnings.
- Delphi and SQL parsing are heuristic and best-effort.
- The removed alignment-check flow is not part of this release.

## Tech stack

- Frontend: React 19, Vite, tRPC client, TanStack Query
- Backend: Express, tRPC server, TypeScript
- Database: MySQL, Drizzle ORM, Drizzle migrations
- Packaging: PNPM

## Required environment variables

Application runtime:

- `DATABASE_URL`
- `VITE_APP_ID`
- `VITE_OAUTH_PORTAL_URL`
- `JWT_SECRET`
- `OAUTH_SERVER_URL`
- `OWNER_OPEN_ID`

Optional storage-related variables used by `server/storage.ts`:

- `BUILT_IN_FORGE_API_URL`
- `BUILT_IN_FORGE_API_KEY`

## Local setup

```bash
pnpm install
pnpm db:migrate
pnpm dev
```

Default local URL:

- `http://localhost:3000`

## Scripts

- `pnpm dev`
- `pnpm build`
- `pnpm start`
- `pnpm typecheck`
- `pnpm lint`
- `pnpm test`
- `pnpm test:watch`
- `pnpm db:generate`
- `pnpm db:migrate`
- `pnpm db:push`

Notes:

- `pnpm db:generate` works without a live database connection.
- `pnpm db:migrate` still requires a valid `DATABASE_URL`.
- `pnpm lint` currently aliases the repository's static type check; formatting remains available through `pnpm format`.

## State model

Project lifecycle status:

- `draft`
- `importing`
- `ready`
- `analyzing`
- `completed`
- `failed`

Analysis result status:

- `pending`
- `processing`
- `completed`
- `partial`
- `failed`

## Import behavior

ZIP import:

- validates the archive before extraction
- ignores build output and dependency directories
- rejects archives with no supported source files
- saves files transactionally before the project is marked `ready`

Git import:

- validates the repository URL
- clones into a temporary directory
- scans supported source files only
- rejects empty repositories from the app's point of view
- cleans temporary files after the import attempt

## Analysis behavior

Analysis writes back:

- one `analysisResults` row per project
- symbols
- dependencies
- fields
- field dependencies
- risks
- rules

If analysis finishes with warnings, the project is still marked `completed`, while the saved analysis result is marked `partial`.

If analysis fails, the project is marked `failed` and the saved analysis result is marked `failed` with an error message.

## Download format

The download action returns a real ZIP payload from the backend with MIME type:

- `application/zip`

The filename pattern is:

- `{project-name}-analysis-report.zip`

## Tests included in this revision

- auth logout
- project creation
- ZIP import
- Git import
- analysis writeback
- analysis snapshot query
- report download packaging
- delete cascade

## Delivery checklist

Before release, run:

```bash
pnpm typecheck
pnpm test
pnpm build
```

If database schema changes are part of the release, also run:

```bash
pnpm db:migrate
```
