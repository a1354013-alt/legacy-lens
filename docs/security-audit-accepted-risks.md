# Security Audit Accepted Risks

Last reviewed: 2026-05-21

`pnpm audit --audit-level high` currently passes.

`pnpm audit --audit-level moderate` currently reports 9 moderate vulnerabilities. They are tracked here instead of being hidden with blanket overrides because the current findings are either:

- dev-server-only issues in transitive tooling used by `vitest`, `vite`, or `drizzle-kit`
- indirect dependency issues that need an upstream package release path
- low-likelihood UI exposure that is not exercised by the current product surface

Current accepted moderate findings:

- `esbuild` via `vite@5` and `drizzle-kit` helper packages. This is a dev-server CORS issue, not a production runtime exposure in the shipped Express app.
- `vite` via `vitest`. Both current advisories are about Vite dev-server file access paths, not the production bundle served from `dist/public`.
- `postcss` stringification XSS. Legacy Lens does not accept arbitrary user CSS and re-embed it inside a server-rendered `<style>` tag.
- `mdast-util-to-hast` via `streamdown` / `react-markdown`. The app does not expose arbitrary end-user markdown authoring today; keep this under review if user-supplied markdown is introduced.
- `uuid` via `mermaid`. This affects buffer-bound validation in UUID helper variants and is not on the server request path.
- `ip-address` via `express-rate-limit`. The advisory targets HTML-emitting helper methods that Legacy Lens does not call.
- `brace-expansion` via ESLint / TypeScript-ESLint. This is tooling-only and not part of the production runtime.

Review notes:

- Prefer upstream package upgrades when compatible releases land.
- Do not add broad `pnpm.overrides` entries just to silence the audit report.
- Re-evaluate this file whenever `pnpm audit --audit-level moderate` changes materially or a new deployment-facing advisory appears.
