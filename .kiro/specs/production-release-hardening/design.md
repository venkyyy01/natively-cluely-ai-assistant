# Design Document: Production Release Hardening

## Overview

This design covers five hardening areas for the Natively macOS Electron application: build artifact checksums with runtime integrity validation, a sequential permission wizard on first launch, adaptive performance acceleration based on hardware resources, dependency wiring validation, and build speed optimization through parallel compilation and caching.

The architecture introduces three new modules and extends the existing build pipeline:
- `electron/integrity/IntegrityValidator.ts` — runtime boot-time integrity checks
- `electron/permissions/PermissionWizard.ts` — sequential first-launch permission flow
- Extended `electron/config/optimizations.ts` — adaptive hardware-based acceleration
- Enhanced `build-and-install.sh` — parallel compilation, checksums, wiring validation, install to `/Applications/Natively.app`

## Architecture

### System Context

```
┌─────────────────────────────────────────────────────────────────┐
│                    Build Pipeline (macOS)                         │
│                                                                   │
│  build-and-install.sh                                            │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────┐   │
│  │  Clean   │→ │ Parallel │→ │ Package  │→ │  Checksums   │   │
│  │  State   │  │ Compile  │  │ & Sign   │  │  & Wiring    │   │
│  └──────────┘  └──────────┘  └──────────┘  └──────────────┘   │
│                                                    │              │
│                                              ┌─────▼─────┐       │
│                                              │  Install   │       │
│                                              │ /Apps/     │       │
│                                              └───────────┘       │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                    Runtime (Electron App)                         │
│                                                                   │
│  bootstrap.ts → initializeApp()                                  │
│  ┌──────────────────┐  ┌─────────────────┐  ┌───────────────┐  │
│  │IntegrityValidator │→ │AdaptiveAccel    │→ │PermissionWiz  │  │
│  │ • native .node   │  │ • detect HW     │  │ • Mic         │  │
│  │ • TS imports      │  │ • classify tier │  │ • ScreenRec   │  │
│  │ • diagnostics     │  │ • scale workers │  │ • Accessibility│  │
│  └──────────────────┘  └─────────────────┘  └───────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### Boot Sequence

1. `initializeApp()` is called
2. **IntegrityValidator** runs synchronously before `app.whenReady()`
   - Verifies native `.node` binary loads for current arch
   - Verifies critical TS imports resolve (main entry, preload, stealth shell preload)
   - On failure: logs diagnostic, prevents window creation
   - On success: logs module count and validation duration
3. **AdaptiveAccelerator** initializes after integrity passes
   - Detects CPU cores and RAM
   - Classifies hardware tier
   - Applies worker count, heap size, and cache limits to `OptimizationFlags`
4. `app.whenReady()` fires
5. **PermissionWizard** runs (first launch only)
   - Sequential: Microphone → Screen Recording → Accessibility
   - Persists completion flag to skip on subsequent launches

## Components

### 1. IntegrityValidator (`electron/integrity/IntegrityValidator.ts`)

```typescript
export interface IntegrityResult {
  success: boolean;
  moduleCount: number;
  durationMs: number;
  errors: IntegrityError[];
}

export interface IntegrityError {
  type: 'native_module' | 'ts_import';
  path: string;
  error: string;
}

export interface IntegrityValidatorConfig {
  nativeModulePath: string;
  criticalImports: string[];
}

export async function validateIntegrity(
  config: IntegrityValidatorConfig
): Promise<IntegrityResult>;
```

**Responsibilities:**
- Load the `natively-audio` native `.node` binary via `require()` and catch `DLOPEN_FAILED` or load errors
- Resolve critical TypeScript module paths: `dist-electron/electron/main.js`, `dist-electron/electron/preload.js`, `dist-electron/electron/stealth/shellPreload.js`
- Return structured result with timing and error details
- Must complete within 2000ms

**Integration point:** Called from `bootstrap.ts` before `app.whenReady()`. If `result.success === false`, the app logs all errors and calls `app.exit(1)`.

### 2. PermissionWizard (`electron/permissions/PermissionWizard.ts`)

```typescript
export interface PermissionState {
  wizardCompleted: boolean;
  microphone: 'granted' | 'denied' | 'unknown';
  screenRecording: 'granted' | 'denied' | 'unknown';
  accessibility: 'granted' | 'denied' | 'unknown';
  lastChecked: string; // ISO 8601
}

export interface PermissionWizardConfig {
  stateFilePath: string; // path to permission-state.json in userData
}

export class PermissionWizard {
  constructor(config: PermissionWizardConfig);

  /** Run the full wizard flow (first launch) */
  async runWizard(): Promise<void>;

  /** Check for revoked permissions (subsequent launches) */
  async checkRevocations(): Promise<string[]>;

  /** Load persisted state */
  loadState(): PermissionState;

  /** Save state to disk */
  saveState(state: PermissionState): void;

  /** Determine if wizard should run */
  shouldRunWizard(): boolean;
}
```

**Sequential Flow:**
1. Show `dialog.showMessageBox()` explaining Microphone need → user clicks OK
2. Call `systemPreferences.askForMediaAccess('microphone')` → wait for response
3. Show `dialog.showMessageBox()` explaining Screen Recording need → user clicks OK
4. Open `x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture` via `shell.openExternal()`
5. Show `dialog.showMessageBox()` explaining Accessibility need → user clicks OK
6. Open `x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility` via `shell.openExternal()`
7. Persist `{ wizardCompleted: true, ... }` to `<userData>/permission-state.json`

**State file location:** `app.getPath('userData') + '/permission-state.json'`

**Subsequent launches:** If `wizardCompleted === true`, call `checkRevocations()` which uses `systemPreferences.getMediaAccessStatus()` and the macOS Accessibility API to detect revoked permissions. If any are revoked, show a targeted `Notification` identifying the specific permission.

### 3. Adaptive Accelerator (extends `electron/config/optimizations.ts`)

```typescript
export type HardwareTier = 'constrained' | 'standard' | 'high-capacity';

export interface HardwareProfile {
  cpuCores: number;
  ramGB: number;
  tier: HardwareTier;
  arch: 'arm64' | 'x64';
}

export function detectHardwareProfile(): HardwareProfile;
export function classifyTier(ramGB: number): HardwareTier;
export function computeWorkerCount(tier: HardwareTier, cpuCores: number): number;
export function computeHeapSize(tier: HardwareTier): number;
export function computeCacheLimit(tier: HardwareTier): number;
export function applyAdaptiveAcceleration(
  userOverrides?: Partial<Pick<OptimizationFlags, 'workerThreadCount' | 'maxCacheMemoryMB'>>
): HardwareProfile;
```

**Tier Classification:**
| RAM (GB) | Tier | Workers | Cache (MB) | V8 Heap (MB) |
|----------|------|---------|------------|--------------|
| ≤ 8 | constrained | max 2 | 50 | 512 |
| 9–16 | standard | cores-2, max 6 | 100 | 1024 |
| ≥ 17 | high-capacity | cores-2, max 12 | 200 | 2048 |

**User Override Logic:** Before applying auto-detected values, check if the user has manually set `workerThreadCount` or `maxCacheMemoryMB` in their settings. If so, skip auto-detection for that specific parameter.

**Integration:** Called from `bootstrap.ts` after integrity validation passes, before any `Worker` is spawned. The function calls `setOptimizationFlags()` with the computed values.

### 4. Build Script Enhancements (`build-and-install.sh`)

#### 4.1 Parallel Compilation

The existing Step 5 ("Build & Package") is restructured to run compilation tasks in parallel:

```bash
# Parallel compilation phase
parallel_compile() {
  local pids=()
  local start_time=$(date +%s)

  # Task 1: Vite renderer build
  npm run build:renderer > "$LOG_DIR/renderer.log" 2>&1 &
  pids+=($!)

  # Task 2: TypeScript electron compilation
  npx tsc -p tsconfig.electron.json > "$LOG_DIR/tsc.log" 2>&1 &
  pids+=($!)

  # Task 3: Rust native module (if sources changed)
  if rust_sources_changed; then
    (cd native-module && cargo build --release) > "$LOG_DIR/rust.log" 2>&1 &
    pids+=($!)
  fi

  # Wait for all, cancel on first failure
  for pid in "${pids[@]}"; do
    if ! wait "$pid"; then
      kill "${pids[@]}" 2>/dev/null || true
      return 1
    fi
  done

  local end_time=$(date +%s)
  info "Parallel compilation completed in $((end_time - start_time))s"
}
```

#### 4.2 Caching Strategy

- **Rust cache:** Compare `Cargo.toml` and `Cargo.lock` mtimes against `native-module/target/.cache-marker`. Skip Rust build if unchanged.
- **TypeScript cache:** Leverage `tsconfig.tsbuildinfo` for incremental compilation (already supported by `tsc --incremental`).
- **`--clean` flag:** When passed, delete all cache markers and `tsbuildinfo` files before compilation.

#### 4.3 SHA-256 Checksums

Added after packaging (new Step 5.5):

```bash
generate_checksums() {
  local release_dir="$1"
  local checksum_file="$release_dir/checksums.sha256"

  > "$checksum_file"  # Overwrite if exists

  for artifact in "$release_dir"/*.app "$release_dir"/*.dmg "$release_dir"/*.zip; do
    [[ -e "$artifact" ]] || continue
    if ! shasum -a 256 "$artifact" >> "$checksum_file"; then
      fail "Checksum generation failed for: $artifact"
    fi
  done

  success "Checksums written to $checksum_file"
}
```

**Format:** BSD `shasum -a 256` compatible — each line: `<64-char-hex-hash>  <filename>`

#### 4.4 Wiring Validation

Added after packaging and signing (enhanced Step 7):

```bash
validate_wiring() {
  local app_asar="$1"
  local unpacked_dir="$2"
  local arch="$3"
  local count=0

  # Check main entry in asar
  require_asar_entry "$app_asar" "/dist-electron/electron/main.js" "Electron main entry"
  ((count++))

  # Check native module index in asar
  require_asar_entry "$app_asar" "/node_modules/natively-audio/index.js" "Native audio module"
  ((count++))

  # Check preload scripts in unpacked
  require_file "$unpacked_dir/dist-electron/electron/preload.js" "Preload script"
  ((count++))
  require_file "$unpacked_dir/dist-electron/electron/stealth/shellPreload.js" "Stealth shell preload"
  ((count++))

  # Check sqlite binaries
  require_file "$unpacked_dir/node_modules/better-sqlite3/build/Release/better_sqlite3.node" "better-sqlite3"
  ((count++))
  require_file "$unpacked_dir/node_modules/sqlite3/build/Release/node_sqlite3.node" "sqlite3"
  ((count++))

  success "Wiring validation passed: $count entries verified"
}
```

#### 4.5 Enhanced Launch Probe

The existing launch probe (Step 8) is enhanced to check stdout/stderr for module loading errors:

```bash
enhanced_launch_probe() {
  local app_binary="$1"
  local log_file=$(mktemp)

  "$app_binary" > "$log_file" 2>&1 &
  local pid=$!
  sleep 4

  if ! kill -0 "$pid" 2>/dev/null; then
    fail "Launch probe: app did not survive 4 seconds"
  fi

  # Check for module loading errors
  if grep -qE 'MODULE_NOT_FOUND|DLOPEN_FAILED' "$log_file"; then
    local error_line=$(grep -E 'MODULE_NOT_FOUND|DLOPEN_FAILED' "$log_file" | head -1)
    kill "$pid" 2>/dev/null || true
    fail "Launch probe: module loading error detected: $error_line"
  fi

  # Verify native audio loaded
  if grep -q 'natively-audio' "$log_file"; then
    success "Launch probe: native audio module confirmed loaded"
  fi

  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true

  local boot_duration=4  # seconds survived
  success "Launch probe passed (boot duration: ${boot_duration}s)"
  rm -f "$log_file"
}
```

#### 4.6 Final Install Step

The final step of `build-and-install.sh` copies the built `.app` to `/Applications/Natively.app`, replacing any existing installation:

```bash
# Kill existing instance
pkill -x "$APP_NAME" 2>/dev/null || true
sleep 1

# Remove old installation
rm -rf "${INSTALL_DIR}/${APP_NAME}.app" || sudo rm -rf "${INSTALL_DIR}/${APP_NAME}.app"

# Copy new build
ditto "$APP_GLOB" "${INSTALL_DIR}/${APP_NAME}.app"

# Remove quarantine
xattr -d com.apple.quarantine "${INSTALL_DIR}/${APP_NAME}.app" 2>/dev/null || true
```

## Data Models

### Permission State File (`permission-state.json`)

```json
{
  "wizardCompleted": true,
  "microphone": "granted",
  "screenRecording": "granted",
  "accessibility": "granted",
  "lastChecked": "2024-01-15T10:30:00.000Z"
}
```

### Checksum File (`checksums.sha256`)

```
a1b2c3d4e5f6...  Natively-1.0.0-arm64.dmg
f6e5d4c3b2a1...  Natively-1.0.0-arm64.zip
```

### Integrity Validation Result

```typescript
{
  success: true,
  moduleCount: 4,
  durationMs: 127,
  errors: []
}
```

## Error Handling

| Component | Error Condition | Behavior |
|-----------|----------------|----------|
| IntegrityValidator | Native module load failure | Log path + error, exit app |
| IntegrityValidator | TS import unresolved | Log module path, prevent window creation |
| PermissionWizard | Permission revoked | Show targeted notification |
| PermissionWizard | State file corrupt | Reset state, re-run wizard |
| AdaptiveAccelerator | `os.cpus()` fails | Fall back to 4 cores |
| AdaptiveAccelerator | `os.totalmem()` fails | Fall back to standard tier |
| Build Script | Checksum generation fails | Exit non-zero, print failing path |
| Build Script | Parallel task fails | Cancel siblings, exit with first error |
| Build Script | Wiring check fails | Exit non-zero, report missing module |
| Build Script | Launch probe module error | Report error line, exit non-zero |
| Build Script | Permission denied on clean | Exit non-zero, report path |

## Interfaces

### IntegrityValidator ↔ Bootstrap

```typescript
// In bootstrap.ts, before app.whenReady():
import { validateIntegrity } from '../integrity/IntegrityValidator';

const integrityResult = await validateIntegrity({
  nativeModulePath: path.join(__dirname, '../../node_modules/natively-audio'),
  criticalImports: [
    'dist-electron/electron/main.js',
    'dist-electron/electron/preload.js',
    'dist-electron/electron/stealth/shellPreload.js',
  ],
});

if (!integrityResult.success) {
  for (const err of integrityResult.errors) {
    console.error(`[Integrity] ${err.type}: ${err.path} — ${err.error}`);
  }
  app.exit(1);
}
console.log(`[Integrity] Validated ${integrityResult.moduleCount} modules in ${integrityResult.durationMs}ms`);
```

### AdaptiveAccelerator ↔ OptimizationFlags

```typescript
// In bootstrap.ts, after integrity passes:
import { applyAdaptiveAcceleration } from '../config/optimizations';

const userSettings = loadUserSettings(); // from settings store
const profile = applyAdaptiveAcceleration({
  workerThreadCount: userSettings.workerThreadCount,
  maxCacheMemoryMB: userSettings.maxCacheMemoryMB,
});
console.log(`[Adaptive] ${profile.tier} tier: ${profile.cpuCores} cores, ${profile.ramGB}GB RAM`);
```

### PermissionWizard ↔ Bootstrap

```typescript
// In bootstrap.ts, inside app.whenReady():
import { PermissionWizard } from '../permissions/PermissionWizard';

const wizard = new PermissionWizard({
  stateFilePath: path.join(app.getPath('userData'), 'permission-state.json'),
});

if (wizard.shouldRunWizard()) {
  await wizard.runWizard();
} else {
  const revoked = await wizard.checkRevocations();
  if (revoked.length > 0) {
    // Show notification for each revoked permission
  }
}
```

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system — essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Property 1: Checksum format validity

*For any* build artifact file with non-empty content, the generated checksum line SHALL match the BSD `shasum -a 256` format: a 64-character lowercase hexadecimal hash followed by two spaces and the filename.

**Validates: Requirements 1.1, 1.4**

### Property 2: Integrity validation error reporting

*For any* module path that fails to load or resolve, the IntegrityValidator SHALL produce an error entry containing both the exact path that failed and a non-empty error description string.

**Validates: Requirements 2.3, 2.4**

### Property 3: Integrity validation success reporting

*For any* set of N valid modules where all load successfully, the IntegrityValidator SHALL report `success: true` with `moduleCount` equal to N and `durationMs` as a non-negative number.

**Validates: Requirements 2.5**

### Property 4: Hardware tier classification

*For any* positive RAM value in gigabytes, `classifyTier(ramGB)` SHALL return exactly one tier: `'constrained'` if ramGB ≤ 8, `'standard'` if 9 ≤ ramGB ≤ 16, or `'high-capacity'` if ramGB ≥ 17.

**Validates: Requirements 7.3**

### Property 5: Worker thread scaling

*For any* hardware profile with a given tier and CPU core count ≥ 1, `computeWorkerCount(tier, cores)` SHALL return: at most 2 for constrained, `min(cores - 2, 6)` clamped to [2, 6] for standard, and `min(cores - 2, 12)` clamped to [2, 12] for high-capacity.

**Validates: Requirements 8.1, 8.2, 8.3**

### Property 6: Heap and cache scaling

*For any* hardware tier, `computeHeapSize(tier)` and `computeCacheLimit(tier)` SHALL return the exact values: constrained → (512, 50), standard → (1024, 100), high-capacity → (2048, 200).

**Validates: Requirements 9.1, 9.2, 9.3**

### Property 7: User override precedence

*For any* user-configured value for `workerThreadCount` or `maxCacheMemoryMB`, `applyAdaptiveAcceleration` SHALL use the user-provided value for that parameter and only auto-detect the parameters not overridden.

**Validates: Requirements 9.5**

### Property 8: Permission state round-trip

*For any* valid `PermissionState` object, serializing it to JSON and deserializing it back SHALL produce an object equal to the original.

**Validates: Requirements 5.7, 6.3**

### Property 9: Wizard non-re-trigger invariant

*For any* number of app launches after the wizard has completed (wizardCompleted flag is true), the full sequential wizard flow SHALL NOT be triggered.

**Validates: Requirements 6.4**

### Property 10: Revocation detection

*For any* permission that was previously recorded as `'granted'` in the state file but whose current system status is not granted, `checkRevocations()` SHALL include that permission in its returned list.

**Validates: Requirements 6.2**

### Property 11: Native module architecture match

*For any* target build architecture (arm64 or x64), the dependency verification step SHALL confirm that the native audio `.node` binary file name contains the matching architecture identifier.

**Validates: Requirements 4.2**

### Property 12: Launch probe error detection

*For any* stdout/stderr output from the launch probe that contains the string `MODULE_NOT_FOUND` or `DLOPEN_FAILED`, the probe SHALL report a failure with a non-zero exit status.

**Validates: Requirements 13.2, 13.3**

### Property 13: Wiring validator failure reporting

*For any* module in the expected wiring set that is absent from the packaged app, the Wiring_Validator SHALL report that specific module's name or path in its error output.

**Validates: Requirements 10.5**

### Property 14: Rust cache invalidation

*For any* modification to `Cargo.toml` or `Cargo.lock` (changed mtime), the build script SHALL invalidate the Rust compilation cache and trigger a full native module rebuild.

**Validates: Requirements 12.4**
