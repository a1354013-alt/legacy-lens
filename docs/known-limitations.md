# Known Limitations

This document records intentionally unfinished or bounded behavior so deployment and review expectations stay honest.

## Analyzer Boundaries

- Legacy Lens is a legacy impact review assistant, not a compiler-grade semantic analyzer.
- Go support is strongest for local symbol/method discovery inside imported files. Interface dispatch, package-alias construction, and cross-package type resolution are still heuristic.
- SQL support is strongest for common CRUD, schema-qualified names, CTEs, and many quoted identifiers. Dynamic SQL and deeply nested runtime-built statements can still be incomplete.
- Delphi support is strongest for common unit procedures, `FieldByName`, `ParamByName`, and basic DFM event extraction. Complex inheritance, `with` blocks, dataset ownership, and runtime wiring still require manual review.
- DFM support is metadata-oriented and should be cross-checked against matching `.pas` units during review.

## Frontend / i18n Boundaries

- The current product primarily targets Traditional Chinese.
- Primary Home, Import, Analysis Result, and Impact Analysis UI copy now flows through the locale helper.
- Backend enum values remain stable API data. The frontend maps common enum values to Traditional Chinese display labels instead of changing the contracts.

## Worker / Deployment Boundaries

- Worker coordination uses lease-based claiming plus ownership-fenced heartbeat/finalization, so stale workers are rejected once ownership moves to a newer attempt.
- Multi-worker safety still depends on timely parent-process heartbeats and a healthy shared MySQL database with reliable conditional-update semantics.
- Long-running jobs that exceed the lease window without parent heartbeat renewal will be retried; size worker and database resources so legitimate work does not starve the dispatcher heartbeat.
- If a deployment cannot rely on shared-database conditional updates, run a single worker replica rather than weakening the claim path.
- Deleting a project is intentionally blocked while queued/running work exists. If you need cancel semantics, that remains a future enhancement.

## Rate Limit Boundaries

- HTTP route and tRPC procedure rate limits are process-local in the current implementation.
- The supported production topology is one app replica unless Redis or another shared rate-limit store is added.
- Multi-replica app/API deployments can dilute per-client limits and are not documented as supported today.
- `LEGACY_LENS_TRUST_PROXY` only controls trusted proxy/IP parsing. It does not provide shared limiter state.

## Git Import Security Boundaries

- Git host validation rejects loopback, link-local, and private-network destinations, but app-level DNS/IP checks are not a complete SSRF boundary.
- Git import intentionally accepts HTTPS repository URLs only; SSH, `git://`, `file://`, credentialed, and plain HTTP URLs stay out of scope.
- Production deployments should use a narrow `LEGACY_LENS_GIT_HOST_ALLOWLIST` and outbound egress restrictions at the deployment layer.
- Higher-security environments should run Git clone/import in an isolated worker or container instead of the main web process.

## Report Export Boundaries

- Report ZIP generation is capped by `MAX_REPORT_ARCHIVE_BYTES`.
- Very large projects may need to be imported and reviewed in smaller slices, or the limit must be raised deliberately with matching infrastructure review.

## v1.1 Delphi History, Build Doctor, and Flow Tracing

- Analysis history stores immutable JSON snapshots for usable runs. The normalized project tables remain only the latest usable projection.
- Failed reanalysis is recorded through project/job failure state and does not erase the previous usable run or its projection.
- Build Doctor is a static heuristic audit. It never compiles Delphi projects and never executes imported project files, scripts, binaries, MSBuild files, or commands.
- Build Doctor cannot prove third-party package availability when a dependency is supplied by an IDE library path that was not imported.
- UI-to-database flow tracing follows persisted static evidence only. Dynamic SQL, runtime event assignment, runtime-created components, inherited form behavior, and runtime data binding can be incomplete.
- Diff reports do not perform fuzzy file rename detection in v1.1.
