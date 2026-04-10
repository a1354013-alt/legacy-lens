# Legacy Lens

Legacy Lens imports a legacy codebase, runs a persisted structural analysis workflow, and exports a ZIP report generated from the same saved analysis result shown in the UI.

## Delivery scope

- Create a project
- Import source from ZIP or Git
- Persist extracted files to MySQL
- Run server-owned analysis and persist the result
- Inspect the saved result in the UI
- Download a ZIP report generated from the persisted analysis row
- Delete the full project graph

## Supported inputs

- Languages: Go, SQL, Delphi (`.pas`, `.dpr`, `.delphi`)
- Import sources: ZIP upload, Git repository clone

## Analysis output

- One `analysisResults` row per project
- Symbols
- Symbol dependencies
- Fields
- Field dependencies
- Risks
- Derived rules
- Markdown and YAML report documents

## Accuracy and limitations

- The analyzer is heuristic, not compiler-grade semantic analysis.
- Go, SQL, and Delphi symbol/dependency extraction can miss or skip ambiguous cases by design.
- Warnings in the UI and ZIP summary should be reviewed before using the result as source-of-truth.

## Required environment variables

- `DATABASE_URL`
- `VITE_APP_ID`
- `VITE_OAUTH_PORTAL_URL`
- `JWT_SECRET`
- `OAUTH_SERVER_URL`
- `OWNER_OPEN_ID`

Optional integration variables:

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

- `pnpm dev`: start the development server
- `pnpm build`: build client and server bundles
- `pnpm start`: run the production bundle
- `pnpm typecheck`: type-check application code
- `pnpm typecheck:test`: type-check test files
- `pnpm check`: run both type-check passes
- `pnpm lint`: run ESLint
- `pnpm test`: run Vitest
- `pnpm test:watch`: run Vitest in watch mode
- `pnpm db:generate`: generate Drizzle migrations from schema changes
- `pnpm db:migrate`: apply Drizzle migrations
- `pnpm db:push`: generate then apply migrations

## Workflow states

Project lifecycle:

- `draft`
- `importing`
- `ready`
- `analyzing`
- `completed`
- `failed`

Analysis result lifecycle:

- `pending`
- `processing`
- `completed`
- `partial`
- `failed`

## Release validation

Run the following before release:

```bash
pnpm check
pnpm lint
pnpm test
pnpm build
pnpm db:migrate
```
