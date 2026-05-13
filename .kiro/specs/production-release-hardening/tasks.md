# Implementation Plan: Production Release Hardening

## Overview

This plan implements five hardening areas for the Natively macOS Electron app: build artifact checksums with runtime integrity validation, a sequential permission wizard on first launch, adaptive performance acceleration based on hardware resources, dependency wiring validation, and build speed optimization through parallel compilation. The implementation uses TypeScript for runtime modules and Bash for build script enhancements, leveraging the existing Node built-in test runner (`node --test`) for testing.

## Tasks

- [x] 1. Implement Adaptive Accelerator module
  - [x] 1.1 Create hardware detection and tier classification functions in `electron/config/optimizations.ts`
    - Add `HardwareTier`, `HardwareProfile` types
    - Implement `detectHardwareProfile()` using `os.cpus()` and `os.totalmem()`
    - Implement `classifyTier(ramGB)` with boundaries: ≤8 → constrained, 9–16 → standard, ≥17 → high-capacity
    - Implement `computeWorkerCount(tier, cpuCores)` with tier-specific clamping
    - Implement `computeHeapSize(tier)` and `computeCacheLimit(tier)` returning exact tier values
    - Implement `applyAdaptiveAcceleration(userOverrides?)` that detects hardware, classifies tier, respects user overrides, applies `setOptimizationFlags()`, and appends Chromium command-line switches
    - Log detected hardware profile and applied acceleration flags at startup
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 8.1, 8.2, 8.3, 8.4, 9.1, 9.2, 9.3, 9.4, 9.5, 12.1, 12.2, 12.3, 12.4, 12.5_

  - [ ]* 1.2 Write property tests for tier classification (Property 4)
    - **Property 4: Hardware tier classification**
    - For any positive RAM value, `classifyTier(ramGB)` returns exactly one correct tier
    - **Validates: Requirements 7.3**

  - [ ]* 1.3 Write property tests for worker thread scaling (Property 5)
    - **Property 5: Worker thread scaling**
    - For any tier and CPU core count ≥ 1, `computeWorkerCount` returns correct clamped value
    - **Validates: Requirements 8.1, 8.2, 8.3**

  - [ ]* 1.4 Write property tests for heap and cache scaling (Property 6)
    - **Property 6: Heap and cache scaling**
    - For any tier, `computeHeapSize` and `computeCacheLimit` return exact specified values
    - **Validates: Requirements 9.1, 9.2, 9.3**

  - [ ]* 1.5 Write property tests for user override precedence (Property 7)
    - **Property 7: User override precedence**
    - For any user-configured value, `applyAdaptiveAcceleration` uses user value and auto-detects only non-overridden params
    - **Validates: Requirements 9.5**

- [x] 2. Implement IntegrityValidator module
  - [x] 2.1 Create `electron/integrity/IntegrityValidator.ts` with validation logic
    - Define `IntegrityResult`, `IntegrityError`, `IntegrityValidatorConfig` interfaces
    - Implement `validateIntegrity(config)` that:
      - Loads native `.node` binary via `require()` and catches DLOPEN_FAILED/load errors
      - Resolves critical TypeScript module paths (main.js, preload.js, shellPreload.js)
      - Returns structured result with timing, module count, and error details
      - Completes within 2000ms timeout
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6_

  - [ ]* 2.2 Write property tests for integrity error reporting (Property 2)
    - **Property 2: Integrity validation error reporting**
    - For any module path that fails, the validator produces an error entry with exact path and non-empty error string
    - **Validates: Requirements 2.3, 2.4**

  - [ ]* 2.3 Write property tests for integrity success reporting (Property 3)
    - **Property 3: Integrity validation success reporting**
    - For any set of N valid modules, reports `success: true` with `moduleCount === N` and non-negative `durationMs`
    - **Validates: Requirements 2.5**

- [x] 3. Implement PermissionWizard module
  - [x] 3.1 Create `electron/permissions/PermissionWizard.ts` with sequential flow
    - Define `PermissionState`, `PermissionWizardConfig` interfaces
    - Implement `PermissionWizard` class with:
      - `loadState()` / `saveState()` for JSON persistence in userData
      - `shouldRunWizard()` checking wizardCompleted flag
      - `runWizard()` sequential flow: Mic dialog → askForMediaAccess → Screen Recording dialog → openExternal → Accessibility dialog → openExternal → persist completion
      - `checkRevocations()` using `systemPreferences.getMediaAccessStatus()` to detect revoked permissions
    - Handle corrupt state file by resetting and re-running wizard
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 6.1, 6.2, 6.3, 6.4_

  - [ ]* 3.2 Write property tests for permission state round-trip (Property 8)
    - **Property 8: Permission state round-trip**
    - For any valid `PermissionState`, serialize to JSON and deserialize back produces equal object
    - **Validates: Requirements 5.7, 6.3**

  - [ ]* 3.3 Write property tests for wizard non-re-trigger invariant (Property 9)
    - **Property 9: Wizard non-re-trigger invariant**
    - After wizard completes (wizardCompleted=true), `shouldRunWizard()` always returns false
    - **Validates: Requirements 6.4**

  - [ ]* 3.4 Write property tests for revocation detection (Property 10)
    - **Property 10: Revocation detection**
    - For any permission previously 'granted' but currently not granted, `checkRevocations()` includes it
    - **Validates: Requirements 6.2**

- [x] 4. Checkpoint — Core modules complete
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Integrate runtime modules into bootstrap
  - [x] 5.1 Wire IntegrityValidator into `electron/main/bootstrap.ts`
    - Call `validateIntegrity()` before `app.whenReady()`
    - On failure: log all errors and call `app.exit(1)`
    - On success: log module count and validation duration
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5_

  - [x] 5.2 Wire AdaptiveAccelerator into `electron/main/bootstrap.ts`
    - Call `applyAdaptiveAcceleration()` after integrity passes, before any Worker spawns
    - Pass user settings overrides for `workerThreadCount` and `maxCacheMemoryMB`
    - Log tier classification and applied settings
    - _Requirements: 8.4, 9.4, 9.5, 12.1, 12.2, 12.3_

  - [x] 5.3 Wire PermissionWizard into `electron/main/bootstrap.ts`
    - Inside `app.whenReady()`: instantiate wizard with userData path
    - If `shouldRunWizard()`: run full sequential flow
    - Else: call `checkRevocations()` and show notification for revoked permissions
    - _Requirements: 5.1, 5.7, 6.1, 6.2, 6.4_

- [x] 6. Enhance build script — parallel compilation and caching
  - [x] 6.1 Add parallel compilation to `build-and-install.sh`
    - Implement `parallel_compile()` function running Vite renderer, TypeScript electron, and Rust native module concurrently as background processes
    - Detect CPU cores and pass `--jobs=$(nproc)` to Cargo
    - Set `NODE_OPTIONS=--max-old-space-size=4096` for TypeScript compilation
    - Cancel all sibling tasks on first failure
    - Report total wall-clock time for parallel phase
    - Use `npm ci --prefer-offline` for dependency installation
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 11.7_

  - [x] 6.2 Add clean build enforcement to `build-and-install.sh`
    - Remove all previous build outputs (dist, dist-electron, release, native-module/target) on every run
    - Remove architecture-specific `.node` binaries
    - Remove `tsconfig.tsbuildinfo` files
    - Always use `npm ci` for reproducible fresh dependency tree
    - Exit non-zero with path report on permission failure
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6_

- [ ] 7. Enhance build script — checksums and wiring validation
  - [ ] 7.1 Add SHA-256 checksum generation to `build-and-install.sh`
    - Implement `generate_checksums()` function after packaging step
    - Write `checksums.sha256` in release directory using BSD `shasum -a 256` format
    - Overwrite existing checksum file with fresh values
    - Exit non-zero on checksum generation failure with failing artifact path
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5_

  - [ ]* 7.2 Write property tests for checksum format validity (Property 1)
    - **Property 1: Checksum format validity**
    - For any non-empty artifact, the generated checksum line matches: 64-char lowercase hex + two spaces + filename
    - **Validates: Requirements 1.1, 1.4**

  - [ ] 7.3 Add wiring validation to `build-and-install.sh`
    - Implement `validate_wiring()` checking: main entry in asar, native audio module in asar, preload scripts in unpacked, sqlite binaries in unpacked
    - Exit non-zero reporting specific missing module on failure
    - Print summary count on success
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6_

  - [ ]* 7.4 Write property tests for wiring validator failure reporting (Property 13)
    - **Property 13: Wiring validator failure reporting**
    - For any module absent from the expected set, the validator reports that module's path in error output
    - **Validates: Requirements 10.5**

- [ ] 8. Enhance build script — launch probe and install
  - [ ] 8.1 Enhance launch probe in `build-and-install.sh`
    - Capture stdout/stderr during 4-second survival check
    - Grep for `MODULE_NOT_FOUND` or `DLOPEN_FAILED` in output
    - On module error: report error line and exit non-zero
    - On success: log boot duration and confirm native audio module loaded
    - _Requirements: 13.1, 13.2, 13.3, 13.4_

  - [ ]* 8.2 Write property tests for launch probe error detection (Property 12)
    - **Property 12: Launch probe error detection**
    - For any output containing MODULE_NOT_FOUND or DLOPEN_FAILED, the probe reports failure with non-zero exit
    - **Validates: Requirements 13.2, 13.3**

  - [ ] 8.3 Ensure final install step copies to `/Applications/Natively.app`
    - Kill existing instance with `pkill -x`
    - Remove old installation (with sudo fallback)
    - Copy via `ditto` to `/Applications/Natively.app`
    - Remove quarantine attribute
    - Verify installed binary architecture matches target
    - _Requirements: 3.1 (install replaces existing)_

- [ ] 9. Add dependency verification and Rust cache invalidation
  - [x] 9.1 Add dependency verification to `build-and-install.sh`
    - After `npm ci`, verify `electron`, `electron-builder`, and `tsc` binaries present
    - Verify native audio `.node` binary matches target architecture
    - Verify `better-sqlite3` and `sqlite3` native binaries present and loadable
    - Exit non-zero listing missing dependencies on failure
    - _Requirements: 4.1, 4.2, 4.3, 4.4_

  - [ ]* 9.2 Write property tests for native module architecture match (Property 11)
    - **Property 11: Native module architecture match**
    - For any target arch (arm64/x64), verification confirms the `.node` binary filename contains the arch identifier
    - **Validates: Requirements 4.2**

  - [ ]* 9.3 Write property tests for Rust cache invalidation (Property 14)
    - **Property 14: Rust cache invalidation**
    - For any modification to Cargo.toml or Cargo.lock (changed mtime), the build invalidates Rust cache and triggers full rebuild
    - **Validates: Requirements 12.4**

- [ ] 10. Final checkpoint — End-to-end validation
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- Unit tests validate specific examples and edge cases
- The project uses Node's built-in test runner (`node --test`) — all test files go in `electron/tests/`
- The build script pipeline order is: clean → compile (parallel) → package → sign → checksum → validate wiring → install → launch probe
- The PermissionWizard runs on first launch after install (inside `app.whenReady()`)
- Adaptive acceleration applies before any worker threads spawn (after integrity, before `app.whenReady()`)

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "2.1", "3.1"] },
    { "id": 1, "tasks": ["1.2", "1.3", "1.4", "1.5", "2.2", "2.3", "3.2", "3.3", "3.4"] },
    { "id": 2, "tasks": ["5.1", "5.2", "5.3", "6.1", "6.2"] },
    { "id": 3, "tasks": ["7.1", "7.3", "8.1", "8.3", "9.1"] },
    { "id": 4, "tasks": ["7.2", "7.4", "8.2", "9.2", "9.3"] }
  ]
}
```
