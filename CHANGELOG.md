# Changelog

## 1.1.0 - 2026-08-01

### Added

- Immutable analysis-run history, current-source diff/baseline workflows, and production health/readiness probes.

### Changed

- Promoted the release version from `1.1.0-rc2` to `1.1.0`.
- Aligned production runtime configuration around canonical `PUBLIC_ORIGIN`, worker/runtime env contracts, and graceful shutdown bounds.

### Fixed

- OAuth callback origin construction now uses a validated canonical public origin in production.
- Readiness responses fail closed with reason codes instead of leaking raw dependency errors.
- Analysis baseline persistence now has a DB-level project/run consistency constraint.

### Security

- Preserved fail-closed temp ZIP cleanup and sanitized deployment-facing health disclosures.

### Deployment Notes

- Set `PUBLIC_ORIGIN` to the canonical HTTPS origin before running `docker compose -f docker-compose.prod.yml up`.
- Inject `APP_VERSION=1.1.0` and `GIT_COMMIT` during production builds.

### Known Limitations

- OAuth still depends on the external portal/provider being reachable from the deployed app environment.
- Rate limiting remains process-local unless a shared external store is introduced.

### Upgrade Notes

- Apply migration `0016_release_baseline_integrity.sql` before tagging or deploying `v1.1.0`.
