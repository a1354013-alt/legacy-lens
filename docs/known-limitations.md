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
- The locale helper exists, but the app is not yet fully localized end-to-end.
- Some older screens still contain hard-coded UI copy and should be normalized gradually instead of through a risky bulk rewrite.

## Worker / Deployment Boundaries

- Distributed-safe worker leasing is not implemented.
- In multi-instance deployments, enable `PROJECT_WORKER_ENABLED=true` on exactly one instance and `false` on the rest.

## Report Export Boundaries

- Report ZIP generation is capped by `MAX_REPORT_ARCHIVE_BYTES`.
- Very large projects may need to be imported and reviewed in smaller slices, or the limit must be raised deliberately with matching infrastructure review.
