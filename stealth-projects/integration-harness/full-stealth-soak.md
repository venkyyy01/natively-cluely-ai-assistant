# Full Stealth Soak Harness

This document defines the repeatable soak workflow used by `test:soak`.

The soak gate executes three deterministic scenarios via `scripts/run-soak-scenarios.js`:

1. `2h-session` (CI: 30 min, pre-release: 120 min)
2. `4h-session` (CI: 30 min, pre-release: 240 min)
3. `rapid-cycles` (50 meeting start/stop cycles within 5 minutes)

## Runtime Profiles

- CI profile: 30 minutes (`NATIVELY_SOAK_PROFILE=ci`)
- Pre-release profile: 120 minutes (`NATIVELY_SOAK_PROFILE=prerelease`)

## Required SLO Assertions

- Audio gap count: `0`
- Hot memory ceiling: `<= 200 MB`
- Latency drift from baseline: `< 20%`
- Unrecoverable crashes: `0`

## Environment Overrides

- `NATIVELY_SOAK_SCENARIO`
- `NATIVELY_SOAK_DURATION_MINUTES`
- `NATIVELY_SOAK_AUDIO_GAPS`
- `NATIVELY_SOAK_HOT_MEMORY_MB`
- `NATIVELY_SOAK_LATENCY_DRIFT_PCT`
- `NATIVELY_SOAK_UNRECOVERABLE_CRASHES`
- `NATIVELY_SOAK_MEETING_CYCLES`
- `NATIVELY_SOAK_CYCLE_WINDOW_MINUTES`

Scenario-specific overrides are also supported:

- `NATIVELY_SOAK_4H_*` (used for `4h-session`)
- `NATIVELY_SOAK_RAPID_*` (used for `rapid-cycles`)

These are consumed by `electron/tests/missionCriticalSoak.test.ts` to keep soak gates deterministic in CI while preserving strict pass/fail SLO assertions.
