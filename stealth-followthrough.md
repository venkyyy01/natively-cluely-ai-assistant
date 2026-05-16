# Stealth Followthrough

## Goal
Finish the remaining repo-feasible stealth implementation work after the Phase 1 native manager commit.

## Tasks
- [ ] Map Phase 2 items to this repo's real runtime surfaces and skip separate-project work -> Verify: clear file list and bounded scope
- [ ] Add failing tests for runtime flags, capture watchdog, and macOS private API gating -> Verify: focused stealth test fails for expected reasons
- [ ] Implement runtime stealth feature flags and capture watchdog in `StealthManager` -> Verify: focused stealth test passes
- [ ] Add native macOS private API gating with safe fallback logging -> Verify: native build succeeds and JS bindings expose the flag path
- [ ] Run Electron tests, native tests, typecheck, and native build again -> Verify: commands exit successfully

## Done When
- [ ] Phase 2 repo-feasible stealth features are implemented and verified without touching unrelated work
