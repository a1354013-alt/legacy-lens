# Testing Notes

Use this sequence for local acceptance before shipping changes:

```bash
corepack prepare pnpm@10.4.1 --activate
pnpm install --frozen-lockfile
pnpm audit --audit-level high
pnpm lint
pnpm check
pnpm test
pnpm build
pnpm docker:smoke
```

## What The Tests Cover

- Project job claiming, lease expiry, retry, and startup recovery
- Ownership-fenced heartbeat/finalization so stale workers cannot overwrite reclaimed jobs
- ZIP upload route contract (`multipart/form-data`) and server-side `.zip` validation
- ZIP/Git import safety boundaries
- Analysis persistence and report export

## Clean-Environment Expectations

- `pnpm install --frozen-lockfile` should succeed without regenerating the lockfile.
- `pnpm audit --audit-level high` is expected to pass.
- Moderate advisories may still exist in tooling or narrowly scoped packages and are tracked separately in `docs/security-audit-accepted-risks.md`.

## Notes

- CI runs on Node `22.18.0`; local Node `24.x` may emit an engine warning because `package.json` currently targets `>=20 <23`.
- `corepack enable` can require elevated filesystem access on some Windows setups. If it fails with an OS permission error, use the already-prepared `pnpm@10.4.1` binary instead of changing the repo configuration.
