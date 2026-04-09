# Full Stealth Soak Harness

This document defines the repeatable soak workflow used by `test:soak`.

## Runtime Profiles

- CI profile: 30 minutes (`NATIVELY_SOAK_PROFILE=ci`)
- Pre-release profile: 120 minutes (`NATIVELY_SOAK_PROFILE=prerelease`)

## Required SLO Assertions

- Audio gap count: `0`
- Hot memory ceiling: `<= 200 MB`
- Latency drift from baseline: `< 20%`
- Unrecoverable crashes: `0`

## Environment Overrides

- `NATIVELY_SOAK_AUDIO_GAPS`
- `NATIVELY_SOAK_HOT_MEMORY_MB`
- `NATIVELY_SOAK_LATENCY_DRIFT_PCT`
- `NATIVELY_SOAK_UNRECOVERABLE_CRASHES`

These are consumed by `electron/tests/missionCriticalSoak.test.ts` to keep soak gates deterministic in CI.
