# Security Audit Summary

Last verified: 2026-06-05

Command:

```bash
pnpm audit --audit-level high
```

Result: passed for high severity advisories during this verification run.

The audit output still reports 7 moderate findings. Those are not treated as hidden or permanently accepted; they are documented in [security-audit-accepted-risks.md](security-audit-accepted-risks.md) with the current rationale and review notes.

This file records a point-in-time audit result only. Re-run the audit after dependency changes, lockfile changes, or before release sign-off.
