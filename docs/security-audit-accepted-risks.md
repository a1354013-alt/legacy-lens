# Security Audit Accepted Risks

Last reviewed: 2026-07-28

`pnpm audit --audit-level high` passes for the current v1.1.0-rc2 lockfile.

`pnpm audit --audit-level moderate` passes for the current v1.1.0-rc2 lockfile. The audit output reports 2 low findings below the release-required moderate threshold.

## Current Unresolved Findings

- `esbuild@0.28.0`, GHSA-g7r4-m6w7-qqqr, low.
  Paths:
  `. > esbuild@0.28.0`;
  `. > vite@8.1.0 > esbuild@0.28.0`;
  `. > @tailwindcss/vite@4.3.1 > vite@8.1.0 > esbuild@0.28.0`;
  `. > @vitejs/plugin-react@6.0.3 > vite@8.1.0 > esbuild@0.28.0`;
  `. > vitest@4.1.8 > vite@8.1.0 > esbuild@0.28.0`;
  `. > vitest@4.1.8 > @vitest/mocker@4.1.8 > vite@8.1.0 > esbuild@0.28.0`;
  `. > drizzle-kit@0.31.5 > @esbuild-kit/esm-loader@2.6.5 > @esbuild-kit/core-utils@3.3.2 > esbuild@0.28.0`.
- `body-parser@1.20.5`, GHSA-v422-hmwv-36x6 / CVE-2026-12590, low.
  Paths:
  `. > express@4.22.2 > body-parser@1.20.5`;
  `. > express-rate-limit@8.3.2 > express@4.22.2 > body-parser@1.20.5`.

## Accepted Findings

- `esbuild@0.28.0`: accepted as low severity for this release candidate because the advisory targets the esbuild development server on Windows. Legacy Lens does not ship or expose the esbuild development server in production; production static assets are built and served by the Express app from `dist/public`.
- `body-parser@1.20.5`: accepted as low severity for this release candidate because Legacy Lens uses fixed, validated request-size limits and separate upload guards. ZIP import also enforces raw archive, entry count, source file count, single-file, extracted-size, unsafe path, and cleanup limits. Revisit when `express@4` publishes or resolves to `body-parser@1.20.6` or later.

## Resolved in v1.1.0-rc2

- `postcss` stringification XSS is no longer a current accepted vulnerability. The current lockfile resolves `postcss` to `8.5.23`.
- `brace-expansion` is no longer a current accepted vulnerability. The checked ESLint / TypeScript-ESLint paths resolve `minimatch` to `10.2.5` and `brace-expansion` to `5.0.8`.
- Removed unused direct `streamdown`, `mermaid`, `d3`, `framer-motion`, `date-fns`, `@hookform/resolvers`, `react-hook-form`, and `@types/d3` roots. Re-add any of these only with a current source import and audit review.
- Prior moderate/high findings for `ip-address`, `qs`, `js-yaml`, `fast-xml-parser`, `axios`, and old drizzle-tooling `esbuild` paths are not present in the current audit output.

Review notes:

- Prefer upstream package upgrades when compatible releases land.
- Do not add broad `pnpm.overrides` entries just to silence the audit report.
- Re-evaluate this file whenever `pnpm audit --audit-level moderate` changes materially or a new deployment-facing advisory appears.
- Import security boundaries such as ZIP path validation, Git host/IP validation, lease-safe temp ZIP cleanup, and report export size preflight are documented in the root `README.md` and should be reviewed together with this file during deployment sign-off.
