# Security Audit Summary

Last verified: 2026-07-24

Command:

```bash
pnpm audit --audit-level high
```

Result: passed for high severity advisories during this verification run. The audit output reports 2 low findings below the requested threshold.

The dependency cleanup removed unused direct `mermaid`, `streamdown`, `d3`, `framer-motion`, `date-fns`, `@hookform/resolvers`, `react-hook-form`, and `@types/d3` roots. It also updated `axios`, `postcss`, `fast-xml-parser`, and narrow transitive overrides for `brace-expansion`, `js-yaml`, `ip-address`, `qs`, and the old drizzle-tooling esbuild path.

This file records a point-in-time audit result only. Re-run the audit after dependency changes, lockfile changes, or before release sign-off.
