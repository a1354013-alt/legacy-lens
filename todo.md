# Legacy Lens TODO

This file tracks post-release work only.

## Near-term follow-up

- Add more analyzer fixtures for cross-file Delphi and SQL edge cases.
- Improve dependency recovery for ambiguous symbols only when a deterministic resolver exists.
- Add end-to-end tests against a real MySQL instance in CI.
- Add background-job execution for long-running import and analysis workflows.
- Expand manual QA coverage for large ZIP archives and Git clone failures.

## Longer-term

- Support additional languages with explicit capability flags.
- Add richer report diffing between analysis runs.
- Add project-level audit history for import and analysis operations.
