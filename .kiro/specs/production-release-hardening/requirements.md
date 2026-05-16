# Requirements Document

## Introduction

Production Release Hardening prepares the Natively macOS Electron application for reliable end-user distribution. The feature covers five areas: build script hardening with SHA-256 checksums and runtime integrity validation, a sequential permission wizard on first launch, adaptive performance acceleration based on detected hardware resources, dependency wiring validation to prevent regressions, and build speed optimization through maximum hardware utilization and parallel compilation (always fresh builds, no caches).

## Glossary

- **Build_Script**: The `build-and-install.sh` shell script that orchestrates the 8-step macOS release pipeline (clean, install deps, quality gates, build/package, sign, verify manifest, install, launch).
- **Permission_Wizard**: A sequential first-launch flow that explains required macOS permissions and triggers native system dialogs or guides the user to System Settings.
- **Adaptive_Accelerator**: The subsystem that detects CPU core count, RAM capacity, and scales worker thread counts, V8 heap size, and cache limits accordingly.
- **Integrity_Validator**: The component that generates SHA-256 checksums for build artifacts and verifies at runtime that native `.node` binaries load and TypeScript imports resolve.
- **Wiring_Validator**: A post-build verification step that confirms all critical imports resolve, native modules load, and no regressions exist from stealth hardening changes.
- **Bootstrap**: The `electron/main/bootstrap.ts` → `initializeApp()` entry point that initializes the Electron application.
- **Native_Module**: The Rust-based `natively-audio` NAPI addon compiled per-architecture (arm64/x64).
- **Worker_Thread**: Background threads running VectorStore, LiveRAGIndexer, or ParallelContextAssembler workloads.
- **System_Settings_Guide**: A native macOS dialog or in-app panel that directs the user to the correct System Settings pane for permissions that cannot be programmatically prompted.

## Requirements

### Requirement 1: Build Artifact Checksums

**User Story:** As a developer, I want SHA-256 checksums generated for all build artifacts, so that I can verify artifact integrity before distribution.

#### Acceptance Criteria

1. WHEN the Build_Script completes the packaging step, THE Build_Script SHALL generate a SHA-256 checksum file for each output artifact (.app, .dmg, .zip).
2. THE Build_Script SHALL write all checksums to a `checksums.sha256` file in the release directory.
3. WHEN a checksum file already exists in the release directory, THE Build_Script SHALL overwrite the existing checksum file with freshly computed values.
4. THE Build_Script SHALL include the artifact filename and its corresponding SHA-256 hash on each line of the checksum file in BSD `shasum -a 256` compatible format.
5. IF the checksum generation fails for any artifact, THEN THE Build_Script SHALL exit with a non-zero status code and print the failing artifact path.

### Requirement 2: Runtime Integrity Validation

**User Story:** As a developer, I want the app to verify its own integrity at boot, so that corrupted or tampered installations are detected early.

#### Acceptance Criteria

1. WHEN Bootstrap calls `initializeApp()`, THE Integrity_Validator SHALL verify that the Native_Module binary (`.node` file) loads without error for the current architecture.
2. WHEN Bootstrap calls `initializeApp()`, THE Integrity_Validator SHALL verify that critical TypeScript module imports resolve (electron main entry, preload scripts, stealth shell preload).
3. IF the Native_Module fails to load, THEN THE Integrity_Validator SHALL log a diagnostic error message including the expected binary path and the load error.
4. IF any critical TypeScript import fails to resolve, THEN THE Integrity_Validator SHALL log the unresolved module path and prevent the app from proceeding to window creation.
5. WHEN all integrity checks pass, THE Integrity_Validator SHALL log a success confirmation with the validated module count and total validation duration in milliseconds.
6. THE Integrity_Validator SHALL complete all checks within 2000 milliseconds on a machine with 8 GB RAM.

### Requirement 3: Clean Build Enforcement

**User Story:** As a developer, I want the build script to always perform a fresh build from scratch, so that stale artifacts, caches, or incremental state never contaminate a release.

#### Acceptance Criteria

1. THE Build_Script SHALL remove all previous build output directories (dist, dist-electron, release, native-module/target) before starting compilation on every run.
2. THE Build_Script SHALL remove architecture-specific `.node` binaries from the native-module directory before rebuilding on every run.
3. THE Build_Script SHALL remove any TypeScript incremental compilation caches (`tsconfig.tsbuildinfo`) before compilation.
4. THE Build_Script SHALL always run `npm ci` (not `npm install`) to guarantee a reproducible, fresh dependency tree.
5. IF any artifact removal fails due to filesystem permissions, THEN THE Build_Script SHALL exit with a non-zero status code and report the path that could not be removed.
6. THE Build_Script SHALL NOT support incremental or cached builds — every invocation produces a complete fresh build from source.

### Requirement 4: Dependency Verification

**User Story:** As a developer, I want the build to verify that critical dependencies are present and correctly linked, so that missing or broken dependencies are caught before packaging.

#### Acceptance Criteria

1. WHEN dependency installation completes, THE Build_Script SHALL verify that `electron`, `electron-builder`, and `tsc` binaries are present in node_modules.
2. WHEN native dependency verification runs, THE Build_Script SHALL confirm that the native audio `.node` binary matches the target build architecture.
3. IF any required dependency is missing after installation, THEN THE Build_Script SHALL exit with a non-zero status code and list the missing dependencies.
4. THE Build_Script SHALL verify that `better-sqlite3` and `sqlite3` native binaries are present and loadable for the target architecture.

### Requirement 5: Permission Wizard — Sequential Flow

**User Story:** As a user launching Natively for the first time, I want to understand what permissions are needed and grant them one at a time, so that I am not overwhelmed by simultaneous system dialogs.

#### Acceptance Criteria

1. WHEN the app launches for the first time on macOS, THE Permission_Wizard SHALL display a native explanation dialog for Microphone access before triggering the system permission prompt.
2. WHEN the user acknowledges the Microphone explanation, THE Permission_Wizard SHALL call `systemPreferences.askForMediaAccess('microphone')` and wait for the user response.
3. WHEN the Microphone permission flow completes, THE Permission_Wizard SHALL display a native explanation dialog for Screen Recording access.
4. WHEN the user acknowledges the Screen Recording explanation, THE Permission_Wizard SHALL open the System Settings Privacy pane for Screen Recording using the `x-apple.systempreferences` URL scheme.
5. WHEN the Screen Recording guidance completes, THE Permission_Wizard SHALL display a native explanation dialog for Accessibility access.
6. WHEN the user acknowledges the Accessibility explanation, THE Permission_Wizard SHALL open the System Settings Privacy pane for Accessibility using the `x-apple.systempreferences` URL scheme.
7. THE Permission_Wizard SHALL persist a flag indicating the wizard has completed, so that subsequent launches skip the wizard flow.

### Requirement 6: Permission Wizard — State Tracking

**User Story:** As a user, I want the app to remember which permissions I have already granted, so that I am only prompted for missing permissions on subsequent launches.

#### Acceptance Criteria

1. WHEN the app launches and the wizard-completed flag is set, THE Permission_Wizard SHALL check the current grant status of Microphone, Screen Recording, and Accessibility permissions.
2. IF any previously granted permission has been revoked, THEN THE Permission_Wizard SHALL display a targeted notification identifying the revoked permission and guiding the user to re-enable it.
3. THE Permission_Wizard SHALL store permission state in the app's userData directory using a JSON configuration file.
4. THE Permission_Wizard SHALL NOT re-trigger the full sequential wizard after the initial completion.

### Requirement 7: Adaptive Acceleration — Resource Detection

**User Story:** As a user running Natively on hardware ranging from 8 GB to 32 GB RAM, I want the app to automatically tune its performance settings to my machine, so that it runs well without manual configuration.

#### Acceptance Criteria

1. WHEN the Adaptive_Accelerator initializes, THE Adaptive_Accelerator SHALL detect the number of available CPU cores using `os.cpus().length`.
2. WHEN the Adaptive_Accelerator initializes, THE Adaptive_Accelerator SHALL detect the total system RAM in gigabytes using `os.totalmem()`.
3. THE Adaptive_Accelerator SHALL classify the machine into one of three tiers: constrained (8 GB or fewer), standard (9–16 GB), or high-capacity (17 GB or more).
4. THE Adaptive_Accelerator SHALL log the detected hardware profile (core count, RAM tier, architecture) at startup.

### Requirement 8: Adaptive Acceleration — Worker Scaling

**User Story:** As a user, I want worker thread counts scaled to my hardware, so that the app uses available cores without overloading constrained machines.

#### Acceptance Criteria

1. WHILE the machine is classified as constrained, THE Adaptive_Accelerator SHALL set the worker thread count to a maximum of 2.
2. WHILE the machine is classified as standard, THE Adaptive_Accelerator SHALL set the worker thread count to `CPU_cores - 2`, clamped to a maximum of 6.
3. WHILE the machine is classified as high-capacity, THE Adaptive_Accelerator SHALL set the worker thread count to `CPU_cores - 2`, clamped to a maximum of 12.
4. THE Adaptive_Accelerator SHALL apply the computed worker count to the `workerThreadCount` field in the optimization flags before any Worker_Thread is spawned.

### Requirement 9: Adaptive Acceleration — Heap and Cache Scaling

**User Story:** As a user, I want V8 heap size and cache limits tuned to my available RAM, so that the app avoids out-of-memory crashes on constrained machines and leverages extra memory on capable ones.

#### Acceptance Criteria

1. WHILE the machine is classified as constrained, THE Adaptive_Accelerator SHALL set `maxCacheMemoryMB` to 50 and the V8 max-old-space-size to 512 MB.
2. WHILE the machine is classified as standard, THE Adaptive_Accelerator SHALL set `maxCacheMemoryMB` to 100 and the V8 max-old-space-size to 1024 MB.
3. WHILE the machine is classified as high-capacity, THE Adaptive_Accelerator SHALL set `maxCacheMemoryMB` to 200 and the V8 max-old-space-size to 2048 MB.
4. THE Adaptive_Accelerator SHALL apply heap and cache settings before the first Worker_Thread is spawned.
5. IF the user has manually configured a `workerThreadCount` or `maxCacheMemoryMB` value in settings, THEN THE Adaptive_Accelerator SHALL respect the user override and skip auto-detection for that parameter.

### Requirement 10: Dependency Wiring Validation

**User Story:** As a developer, I want a post-build validation step that confirms all critical imports resolve and native modules load, so that stealth hardening changes do not introduce silent regressions.

#### Acceptance Criteria

1. WHEN the Build_Script completes packaging, THE Wiring_Validator SHALL attempt to require the packaged Electron main entry (`dist-electron/electron/main.js`) from within the app.asar.
2. WHEN the Wiring_Validator runs, THE Wiring_Validator SHALL verify that the `natively-audio` native module index file is present in app.asar.
3. WHEN the Wiring_Validator runs, THE Wiring_Validator SHALL verify that the preload script and stealth shell preload are present in the asar-unpacked directory.
4. WHEN the Wiring_Validator runs, THE Wiring_Validator SHALL verify that `better-sqlite3` and `sqlite3` native binaries exist in the asar-unpacked directory for the target architecture.
5. IF any wiring check fails, THEN THE Wiring_Validator SHALL exit with a non-zero status code and report the specific missing or unresolvable module.
6. WHEN all wiring checks pass, THE Wiring_Validator SHALL print a summary listing the count of validated entries.

### Requirement 11: Build Speed — Maximum Hardware Utilization

**User Story:** As a developer, I want the build to use all available CPU cores and memory to compile as fast as possible, so that fresh builds complete in minimum wall-clock time.

#### Acceptance Criteria

1. THE Build_Script SHALL detect the number of available CPU cores and use all of them for parallel compilation tasks.
2. THE Build_Script SHALL run the Vite renderer build, TypeScript electron compilation, and Rust native module compilation concurrently using background processes.
3. THE Build_Script SHALL pass `--jobs=$(nproc)` or equivalent to Rust/Cargo compilation to maximize core utilization.
4. THE Build_Script SHALL set `NODE_OPTIONS=--max-old-space-size=4096` during TypeScript compilation to prevent OOM on large codebases.
5. IF any parallel compilation step fails, THEN THE Build_Script SHALL cancel remaining parallel tasks and exit with the first failure's status code and error output.
6. THE Build_Script SHALL report the total wall-clock time for the parallel compilation phase.
7. THE Build_Script SHALL use `npm ci --prefer-offline` for dependency installation to minimize network latency while still guaranteeing a fresh lockfile-based install.

### Requirement 12: GPU and Hardware Acceleration

**User Story:** As a user, I want the app to leverage GPU acceleration and hardware features, so that rendering and compute-heavy operations are as fast as possible.

#### Acceptance Criteria

1. THE Build_Script SHALL enable Chromium hardware acceleration flags (`--enable-gpu-rasterization`, `--enable-zero-copy`) in the Electron app's command-line switches.
2. THE Adaptive_Accelerator SHALL enable `app.commandLine.appendSwitch('enable-features', 'VaapiVideoDecoder,CanvasOopRasterization')` on supported hardware.
3. THE Adaptive_Accelerator SHALL set `app.commandLine.appendSwitch('js-flags', '--max-old-space-size=<computed>')` based on the detected RAM tier.
4. WHILE the machine is classified as high-capacity, THE Adaptive_Accelerator SHALL enable `SharedArrayBuffer` and `Atomics` for worker thread communication.
5. THE Adaptive_Accelerator SHALL log all applied hardware acceleration flags at startup.

### Requirement 13: Launch Probe Enhancement

**User Story:** As a developer, I want the post-install launch probe to validate more than just process survival, so that boot-time regressions in module loading are caught before distribution.

#### Acceptance Criteria

1. WHEN the launch probe runs, THE Build_Script SHALL verify that the app process survives for at least 4 seconds (existing behavior).
2. WHEN the launch probe runs, THE Build_Script SHALL capture stdout/stderr and verify that no `MODULE_NOT_FOUND` or `DLOPEN_FAILED` errors appear in the output.
3. IF the launch probe detects a module loading error in the output, THEN THE Build_Script SHALL report the error and exit with a non-zero status code.
4. WHEN the launch probe passes, THE Build_Script SHALL log the boot duration and confirm that the native audio module loaded.
