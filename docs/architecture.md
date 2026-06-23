# Legacy Lens Architecture Notes

This document captures the operational boundaries that matter for real deployments and regression testing.

## Project Job Workflow

- `projectJobs` is the single source of truth for import/analyze work.
- Enqueue writes the job row and project status in the same transaction.
- Only one active job per project is allowed through the `(projectId, activeKey)` unique index and transaction-time conflict checks.
- The worker claims queued jobs from MySQL instead of relying on process-local promises.
- Running jobs are leased with `lockedBy`, `leaseUntil`, `heartbeatAt`, `attemptCount`, and `maxAttempts`.
- Multiple web replicas are supported, and multiple worker replicas are supported when they share the same MySQL database.
- Claiming is distributed-safe through a DB-filtered candidate query plus an atomic conditional update. Competing workers may read the same candidate row, but only one claim update is allowed to win.
- Workers heartbeat the lease while processing. Heartbeats, retry decisions, and finalization are fenced with `lockedBy + attemptCount`, so stale workers cannot overwrite a reclaimed job or its project state.
- If the heartbeat stops and the lease expires, the job can be retried safely until `maxAttempts` is reached. Stale worker finalization is rejected and logged.
- Startup recovery re-queues stale `running` jobs, resumes `queued` jobs, and marks `projects.status in (importing, analyzing)` as failed when no active job remains.
- Startup recovery does not reset still-valid leases. Older rows without lease metadata fall back to the legacy stale-window check.
- `PROJECT_JOB_STALE_MS` controls when a running job is considered stale.
- If an environment cannot guarantee reliable shared-database semantics, use a single worker replica rather than disabling atomic claims.
- Projects with queued/running jobs cannot be deleted. Deletion is rejected until the active work finishes or fails.

## tRPC Rate Limiting

- Express path-based limiters remain as coarse protection.
- Procedure-level rate limiting runs inside tRPC middleware so batched requests cannot bypass heavy procedure buckets.
- Buckets are split by workload:
  - upload/import
  - clone/git
  - analysis trigger
  - heavy read / snapshot
  - general query
- Rate-limit identity prefers `userId`, then session cookie, then client IP.

## Import Safety

### ZIP

- ZIP archives are inspected through central-directory metadata plus streaming extraction.
- Limits are enforced before or during extraction:
  - raw zip bytes
  - total archive entries
  - supported source file count
  - per-file extracted size
  - total extracted bytes
- Unsafe archive paths reject the whole import.
- Unsafe archive paths return `ZIP_UNSAFE_PATH` and require the archive to be fixed and re-uploaded; partial file skipping is intentionally not supported for traversal cases.
- Oversize supported files are skipped with persisted warnings instead of exhausting memory.
- Upload temp-file cleanup preserves ZIPs that are still referenced by active queued/running `import_zip` jobs.

## Worker Deployment

- Set `PROJECT_WORKER_ENABLED=false` on web-only replicas.
- Multiple worker-enabled replicas are supported when they share the same MySQL database.
- Project job claiming relies on `lockedBy`, `leaseUntil`, `heartbeatAt`, and an atomic conditional update so only one worker can own a lease at a time.
- If a worker dies and its lease expires, another worker may reclaim the job within the configured retry budget.
- If your deployment cannot rely on shared-database conditional updates and transactions, run a single worker replica.
- SQLite or in-memory test doubles are useful for development/testing, but they are not the reference deployment path for multi-worker safety.

### Git

- Git import validates hostnames and resolved IPs before clone.
- Loopback, link-local, and private-network targets are rejected.
- Production imports should still run behind outbound network policy; app-level validation is not a full SSRF substitute.
- Production deployments should keep `LEGACY_LENS_GIT_HOST_ALLOWLIST` narrow and enforce outbound egress policy at the deployment layer.
- Higher-security environments should run Git clone/import inside an isolated worker or container instead of the main web process.

## Analysis Semantics

- `completed`: analysis succeeded without skipped or degraded files.
- `completed_with_warnings`: analysis succeeded and a usable snapshot was persisted, but the final result still carries warning-only caveats.
- `partial`: analysis succeeded, but some files were skipped or degraded.
- `failed`: no usable analysis result was produced.
- Heuristic notes are preserved, but they do not automatically downgrade a successful result to `partial`.
- The active analysis snapshot and the latest analysis job status are separate concepts. A project may keep serving a previous `completed` or `partial` snapshot while the latest re-analysis job is `failed`.
- UI and report download flows should use the active persisted snapshot for report availability, while also surfacing the latest job failure so users know the current view is the last successful result.

## Persistence Model

- Reports are generated from persisted analysis snapshots only.
- Report ZIP export performs a preflight size estimate before `jszip.generateAsync()` so oversized archives fail before allocating the full buffer.
- Home/detail polling speeds up only while a project or latest job is active.
- `projects.lastAnalyzedAt` tracks the latest successful analysis completion time.
