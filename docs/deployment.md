# Deployment Notes

This document summarizes the production-facing boundaries that matter for Legacy Lens deployments.

## Runtime Configuration

- Runtime numeric env values are strictly parsed before use. Invalid configured values fail fast instead of falling back silently.
- Positive-integer settings reject `0`, negative values, decimals, blanks, and mixed strings such as `30abc`.
- `DB_QUEUE_LIMIT` is intentionally non-negative and may be set to `0`; all job lease, timeout, polling, upload cleanup, throttle, connection-limit, and port settings must be positive integers.
- Keep `.env.example` aligned with production runtime settings when adding new env reads.

## Worker Topology

- Web replicas and worker-enabled replicas can share the same MySQL database.
- Job claiming is lease-based and ownership-fenced with `lockedBy + attemptCount`.
- Heartbeat, retry, and finalization writes are conditional; stale workers are rejected and logged instead of overwriting a reclaimed job.
- Lease renewal is owned by the parent worker dispatcher, not by the CPU-bound worker thread, and stops when the dispatched job resolves, rejects, loses ownership, or worker polling is stopped.
- Worker-enabled replicas poll MySQL for `queued` jobs and expired `running` leases, so a web-only replica can enqueue work without directly waking a local worker process.
- `PROJECT_JOB_EXECUTION_TIMEOUT_MS` bounds one claimed worker-thread execution. When it expires, the stuck worker thread is terminated and the DB lease/stale recovery path is responsible for retrying the job.
- `PROJECT_WORKER_POLL_INTERVAL_MS` defaults to `2000` ms and must be set to a positive integer when overridden.
- `PROJECT_JOB_LEASE_MS`, `PROJECT_JOB_HEARTBEAT_MS`, `PROJECT_JOB_STALE_MS`, `PROJECT_JOB_MAX_ATTEMPTS`, and worker timeout env values are all strict positive integers when overridden.
- `PROJECT_JOB_HEARTBEAT_MS` must be lower than `PROJECT_JOB_LEASE_MS` and no more than one third of the lease duration; invalid production values fail fast.
- If your environment cannot guarantee shared-database conditional-update semantics, run a single worker replica.
- Set `PROJECT_WORKER_ENABLED=false` on web-only replicas.
- Graceful shutdown clears the worker polling timer and any pending scheduler retry timer before closing shared resources.

## Rate Limiting

- HTTP and tRPC procedure rate limits currently use process-local memory stores.
- The supported production topology is a single app replica for rate-limit correctness unless Redis or another external shared store is introduced.
- Worker replicas may still be scaled separately when they share MySQL and preserve the DB-lease ownership rules described above.
- `LEGACY_LENS_TRUST_PROXY` affects trusted proxy/IP parsing only; it does not make the limiter shared across app processes.
- Current built-in buckets are `auth`, `api`, `read`, `upload`, `clone`, `analysis`, and `heavyRead`.
- If the Express rate-limit middleware cannot initialize in production, the app fails closed instead of silently allowing unlimited requests.

## Security Headers

- Production responses include `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options`, Content Security Policy with `frame-ancestors 'none'`, and HSTS.
- CSP is intentionally registered in the Express production path so same-origin static assets from the production build continue to load.
- `CSP_ALLOW_UNSAFE_EVAL` is evaluated at request runtime, not module-load time. Only explicit truthy values (`true`, `1`, `yes`) add `'unsafe-eval'` to `script-src`.
- `docker-compose.demo.yml` leaves `CSP_ALLOW_UNSAFE_EVAL` unset. Set it only as an explicit local escape hatch if a future frontend bundle introduces an evaluated-code dependency.
- Real production deployments should leave `CSP_ALLOW_UNSAFE_EVAL` unset unless that risk has been explicitly reviewed and accepted.
- Development keeps CSP relaxed enough for the Vite dev server.

## Git Import Security

- Legacy Lens blocks loopback, link-local, and private-network Git targets at the application layer.
- App-level DNS/IP validation is not a complete SSRF boundary and does not remove DNS rebinding / TOCTOU risk.
- Production deployments should keep `LEGACY_LENS_GIT_HOST_ALLOWLIST` narrow.
- Production deployments should also restrict outbound egress at the platform, container, or network layer.
- Higher-security environments should run Git clone/import in an isolated worker or container instead of the main web process.

## Upload Contract

- New project imports use `POST /api/projects/import` with `multipart/form-data`; this is the route used by the frontend import page.
- Existing project re-imports use `POST /api/projects/:projectId/upload` with `multipart/form-data`.
- Legacy tRPC compatibility routes remain for older callers: `projects.uploadFiles` is capped to small base64 ZIP payloads, and `projects.cloneGit` re-imports Git into an existing project.
- Expired temp ZIP uploads are cleaned on startup and periodically via `UPLOAD_TEMP_ZIP_CLEANUP_INTERVAL_MS`.
- Cleanup skips temp ZIP paths still referenced by queued or running import jobs.
- Send exactly one source per request:
  - `file=@project.zip`
  - `gitUrl=https://github.com/example/repo.git`
- Non-`.zip` file uploads are rejected server-side with `ZIP_INVALID`.

Example:

```bash
curl -X POST "http://localhost:3000/api/projects/import" \
  -H "Cookie: app_session_id=..." \
  -F "name=legacy-erp" \
  -F "focusLanguage=go" \
  -F "sourceType=upload" \
  -F "file=@./project.zip;type=application/zip"
```

## Runtime Baseline

- Node.js: `22.x` in CI/Docker
- pnpm: `10.4.1`
- Database: MySQL 8+

## Windows Demo Startup

For the local demo stack in VS Code:
- open the repository root as the workspace
- press `F5`
- wait for the launcher to pass the Docker checks and the `/ready` probe
- Legacy Lens opens in the default browser automatically

The launcher uses `scripts/f5-start.ps1`, starts the demo stack in detached mode, waits up to 180 seconds for `http://localhost:$LEGACY_LENS_PORT/ready`, and writes verbose Docker output to `.tmp/f5-start.log`.

Operational notes:
- `Terminal -> Run Task -> Legacy Lens: Stop Demo` stops containers without deleting the demo database volume.
- `Terminal -> Run Task -> Legacy Lens: Show Demo Logs` streams `app`, `migrate`, and `db` logs only when you ask for them.
- `Terminal -> Run Task -> Legacy Lens: Reset Demo DB` runs `docker compose -f docker-compose.demo.yml down -v` and deletes the local demo database volume.
- `LEGACY_LENS_PORT` and `LEGACY_LENS_DB_PORT` can be set before launch to move the app or MySQL host ports.
- If Docker Desktop is not running or the configured ports are occupied, the launcher fails fast with concise diagnostics plus compose status and recent logs.

For reproducible installs in a clean environment:

```bash
corepack prepare pnpm@10.4.1 --activate
pnpm install --frozen-lockfile
```

For a raw production process outside Docker, build and migrate before starting:

```bash
pnpm build
pnpm db:migrate
pnpm start
```

`pnpm start` does not run migrations. The production-like Docker Compose setup uses a separate `migrate` service, so app startup and schema migration remain distinct operational steps.
