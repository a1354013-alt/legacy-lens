# Deployment Notes

This document summarizes the production-facing boundaries that matter for Legacy Lens deployments.

## Worker Topology

- Web replicas and worker-enabled replicas can share the same MySQL database.
- Job claiming is lease-based and ownership-fenced with `lockedBy + attemptCount`.
- Heartbeat, retry, and finalization writes are conditional; stale workers are rejected and logged instead of overwriting a reclaimed job.
- If your environment cannot guarantee shared-database conditional-update semantics, run a single worker replica.
- Set `PROJECT_WORKER_ENABLED=false` on web-only replicas.

## Git Import Security

- Legacy Lens blocks loopback, link-local, and private-network Git targets at the application layer.
- App-level DNS/IP validation is not a complete SSRF boundary and does not remove DNS rebinding / TOCTOU risk.
- Production deployments should keep `LEGACY_LENS_GIT_HOST_ALLOWLIST` narrow.
- Production deployments should also restrict outbound egress at the platform, container, or network layer.
- Higher-security environments should run Git clone/import in an isolated worker or container instead of the main web process.

## Upload Contract

- `POST /api/projects/:projectId/upload` accepts `multipart/form-data` only.
- Send exactly one source per request:
  - `file=@project.zip`
  - `gitUrl=https://github.com/example/repo.git`
- Non-`.zip` file uploads are rejected server-side with `ZIP_INVALID`.

Example:

```bash
curl -X POST "http://localhost:3000/api/projects/42/upload" \
  -H "Cookie: app_session_id=..." \
  -F "file=@./project.zip;type=application/zip"
```

## Runtime Baseline

- Node.js: `22.x` in CI/Docker
- pnpm: `10.4.1`
- Database: MySQL 8+

For reproducible installs in a clean environment:

```bash
corepack prepare pnpm@10.4.1 --activate
pnpm install --frozen-lockfile
```
