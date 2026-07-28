# Security Audit Summary

Last verified: 2026-07-28

Commands:

```bash
pnpm audit --audit-level high
pnpm audit --audit-level moderate
pnpm audit --json
```

Results:

- `pnpm audit --audit-level high`: passed. Output reported 2 low findings.
- `pnpm audit --audit-level moderate`: passed. Output reported 2 low findings.
- No current moderate, high, or critical findings were reported by the lockfile audit.

## Current Unresolved Findings

The current audit reports these low-severity findings:

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

Accepted low findings and rationale are tracked in `docs/security-audit-accepted-risks.md`.

## Resolved in v1.1.0-rc2

- `postcss` now resolves to `8.5.23` throughout the lockfile and is not listed as a current audit finding.
- `minimatch` now resolves to `10.2.5` on the ESLint / TypeScript-ESLint paths checked with `pnpm list postcss minimatch brace-expansion --depth 10`.
- `brace-expansion` now resolves to `5.0.8` on those paths and is not listed as a current audit finding.

This file records a point-in-time audit result only. Re-run the audit after dependency changes, lockfile changes, or before release sign-off.
