# Legacy Lens Portfolio Notes

Legacy Lens is a legacy impact review assistant, not a compiler-grade static analyzer.
It helps teams import legacy projects, inspect symbol/data dependencies, detect risky patterns, and export review-ready reports.

## Positioning

- Focus: legacy impact review for mixed Go, SQL, and Delphi repositories.
- Output: persisted snapshots, paged APIs, warning summaries, and exportable review artifacts.
- Boundary: heuristic static analysis that supports human review instead of replacing it.

## Architecture

- Import pipeline supports ZIP upload and Git import with persisted project/job records.
- Analysis artifacts are stored in MySQL-backed tables for symbols, dependencies, fields, risks, and rules.
- A DB-backed job queue coordinates import/analyze work and stale-job recovery.
- Report exports package the persisted snapshot into a review-friendly ZIP bundle.

## Security Considerations

- Git import blocks loopback, private-network, link-local, credentialed, SSH, and file-protocol targets.
- Production Git import should still be isolated with outbound egress restrictions because app-level DNS/IP checks are not a complete SSRF boundary.
- ZIP import rejects unsafe traversal entries instead of partially skipping them.

## Testing Strategy

- Contract checks cover shared status enums, paged API schemas, and report-export readiness.
- Unit and integration tests cover import, analysis, warning aggregation, queue recovery, and Docker smoke paths.
- `pnpm docker:smoke` validates the production-like demo stack end to end.

## Demo Steps

1. Run `pnpm install --frozen-lockfile`.
2. Run `pnpm build`.
3. Run `pnpm docker:smoke` or `pnpm demo`.
4. Import a ZIP or allowlisted Git repository.
5. Review the persisted warnings, risk/rule groups, and exported report bundle.
