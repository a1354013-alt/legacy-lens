# Testing Notes

Use this sequence for local acceptance before shipping changes:

```bash
corepack prepare pnpm@10.4.1 --activate
pnpm install --frozen-lockfile
pnpm audit --audit-level high
pnpm lint
pnpm check
pnpm test
pnpm test:migration
pnpm build
pnpm docker:smoke
```

## What The Tests Cover

- Project job claiming, lease expiry, retry, and startup recovery
- Worker polling, including disabled web-only replicas, periodic wake-ups on worker-enabled replicas, and non-reentrant loop scheduling
- Ownership-fenced heartbeat/finalization so stale workers cannot overwrite reclaimed jobs
- ZIP upload route contract (`multipart/form-data`) and server-side `.zip` validation
- New-project import route contract (`POST /api/projects/import`) and existing-project re-import route contract (`POST /api/projects/:projectId/upload`)
- ZIP/Git import safety boundaries
- Analysis persistence and report export
- Strict env integer parsing, including invalid production env fail-fast behavior
- Dependency `targetKind` separation for `internal`, `external`, and `unresolved`
- Static F5 launcher validation for `.vscode/launch.json`, `.vscode/tasks.json`, detached Docker startup, `/ready` polling, bounded timeout, browser opening, and ignored temporary logs

## Clean-Environment Expectations

- `pnpm install --frozen-lockfile` should succeed without regenerating the lockfile.
- `pnpm audit --audit-level high` is expected to pass.
- Moderate advisories may still exist in tooling or narrowly scoped packages and are tracked separately in `docs/security-audit-accepted-risks.md`.

## Notes

- CI runs on Node `22.18.0`; local Node `24.x` may emit an engine warning because `package.json` currently targets `>=20 <23`.
- `corepack enable` can require elevated filesystem access on some Windows setups. If it fails with an OS permission error, use the already-prepared `pnpm@10.4.1` binary instead of changing the repo configuration.
- When testing multi-replica job pickup locally, simulate a web-only process with `PROJECT_WORKER_ENABLED=false`, enqueue the job, then run a worker-enabled process and confirm it picks the queued row through polling instead of relying on an in-process wake-up.
## v1.1 Validation Focus

Run the normal gates for release candidates:

```bash
pnpm check
pnpm lint
pnpm test
pnpm build
```

When a real MySQL `DATABASE_URL` is configured, also run:

```bash
pnpm test:migration
```

When Docker is available, also run:

```bash
pnpm docker:smoke
```

History, Build Doctor, and flow-tracing tests should keep strict assertions for immutable run creation, legacy backfill, deterministic fingerprints, baseline ownership, diff truncation, Build Doctor scoring/finding codes, and trace confidence/truncation.

## Windows F5 Validation

The static launcher tests do not require Docker Desktop. They verify:
- `.vscode/launch.json` stays valid JSON with exactly one primary `F5` configuration
- the `F5` command calls `scripts/f5-start.ps1`
- the launcher starts Docker Compose with `up -d --build`
- the launcher polls `/ready`, opens the configured application URL, and uses a bounded timeout
- reset remains a separate explicit task
- temporary startup logs remain ignored by Git

When Docker Desktop is available on Windows, also validate the live launcher manually:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\f5-start.ps1
```

Expected behavior:
- the terminal shows concise progress messages instead of continuous Docker logs
- the browser opens automatically after `/ready` succeeds
- a second run detects an already healthy app and opens the browser without rebuilding
- `Legacy Lens: Stop Demo` stops containers without deleting data
- `Legacy Lens: Reset Demo DB` remains a separate destructive action
