# Security Audit Accepted Risks

Last reviewed: 2026-07-24

`pnpm audit --audit-level high` passes after the v1.1.0-rc2 dependency cleanup.

`pnpm audit --audit-level moderate` passes after the v1.1.0-rc2 dependency cleanup. The audit output reports 2 low findings below the release-required moderate threshold. Future moderate or high findings should be tracked here instead of being hidden with blanket overrides when they are either:

- dev-server-only issues in transitive tooling used by current `vitest@4`, `vite@8`, or `drizzle-kit`
- indirect dependency issues that need an upstream package release path
- low-likelihood UI exposure that is not exercised by the current product surface

Current accepted moderate findings:

- `esbuild` through current build/test tooling, including `vite@8` and `drizzle-kit` helper packages. This is a dev-server CORS issue, not a production runtime exposure in the shipped Express app.
- `vite` through current `vitest@4` / `vite@8` tooling. Current Vite advisories are about dev-server file access paths, not the production bundle served from `dist/public`.
- `postcss` stringification XSS. Legacy Lens does not accept arbitrary user CSS and re-embed it inside a server-rendered `<style>` tag.
- Removed in the v1.1.0-rc2 cleanup: unused direct `streamdown`, `mermaid`, `d3`, `framer-motion`, `date-fns`, `@hookform/resolvers`, `react-hook-form`, and `@types/d3` roots. Re-add any of these only with a current source import and audit review.
- `ip-address` via `express-rate-limit`. The advisory targets HTML-emitting helper methods that Legacy Lens does not call.
- `qs` via `express`. The advisory requires a specific `qs.stringify` option combination that Legacy Lens does not exercise on its request path.
- `brace-expansion` via ESLint / TypeScript-ESLint. This is tooling-only and not part of the production runtime.

Review notes:

- Prefer upstream package upgrades when compatible releases land.
- Do not add broad `pnpm.overrides` entries just to silence the audit report.
- Re-evaluate this file whenever `pnpm audit --audit-level moderate` changes materially or a new deployment-facing advisory appears.
- Import security boundaries such as ZIP path validation, Git host/IP validation, lease-safe temp ZIP cleanup, and report export size preflight are documented in the root `README.md` and should be reviewed together with this file during deployment sign-off.
