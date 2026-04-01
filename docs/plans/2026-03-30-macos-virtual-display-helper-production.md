# macOS Virtual Display Helper Production Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Complete production-ready macOS virtual display helper with proper code signing, notarization, and integration into the Electron app build pipeline.

**Architecture:** The helper is a Swift command-line tool using CGVirtualDisplay API to create virtual displays. It communicates with the Electron app via stdin/stdout JSON protocol. The helper needs code signing, notarization, and entitlements for hardened runtime compatibility.

**Tech Stack:** Swift 5.9, CGVirtualDisplay, Metal, AppKit, ScreenCaptureKit

---

## Current State Analysis

**Already Implemented:**
- Swift helper binary builds successfully (30 tests pass)
- CGVirtualDisplay backend for creating virtual displays
- Layer 3 capability probing (checks macOS 14+, Metal, ScreenCaptureKit)
- Layer 3 validation probe (checks if windows are enumerable via ScreenCaptureKit)
- AppKit Metal presenter host for fullscreen presentation
- File-based session store with locking
- File-based telemetry store
- JSON stdin/stdout protocol with all commands
- Electron client (`MacosVirtualDisplayClient.ts`) for communicating with helper
- Build script (`prepare-macos-virtual-display-helper.js`)
- Package.json extraResources includes helper in app bundle

**Needs Implementation:**
1. Helper entitlements for hardened runtime
2. Code signing configuration
3. Notarization workflow
4. Integration tests with actual virtual display
5. Error recovery for display creation failures
6. Documentation for signing workflow

---

## Task 1: Create Helper Entitlements

**Files:**
- Create: `stealth-projects/macos-virtual-display-helper/entitlements.plist`

**Step 1: Write entitlements file**

The helper needs entitlements for:
- Metal rendering
- Screen capture (for validation probe)
- AppKit window management

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>com.apple.security.cs.allow-jit</key>
    <true/>
    <key>com.apple.security.cs.disable-library-validation</key>
    <true/>
    <key>com.apple.security.device.camera</key>
    <true/>
    <key>com.apple.security.device.audio-input</key>
    <true/>
</dict>
</plist>
```

**Step 2: Commit**
```bash
git add stealth-projects/macos-virtual-display-helper/entitlements.plist
git commit -m "feat(stealth): add entitlements for virtual display helper"
```

---

## Task 2: Add Code Signing to Build Script

**Files:**
- Modify: `scripts/prepare-macos-virtual-display-helper.js`

**Step 1: Add signing function**

Add after line 21 (after `pathExists` function):

```javascript
function signBinary(binaryPath) {
    const identity = process.env.CODESIGN_IDENTITY || '-';
    const entitlementsPath = path.join(packageDir, 'entitlements.plist');
    
    if (!pathExists(entitlementsPath)) {
        log('Warning: entitlements.plist not found, skipping signing');
        return false;
    }
    
    try {
        const args = [
            '--sign', identity,
            '--force',
            '--options', 'runtime',
            '--entitlements', entitlementsPath,
            binaryPath
        ];
        execFileSync('codesign', args, { stdio: 'inherit' });
        log(`Signed ${binaryPath} with entitlements`);
        return true;
    } catch (error) {
        log(`Warning: codesign failed: ${error.message}`);
        return false;
    }
}
```

**Step 2: Call signing in main function**

Modify the main function to sign after copying. After line 51 (`fs.copyFileSync(builtBinary, outputBinary);`), add:

```javascript
    if (process.env.SKIP_CODESIGN !== '1') {
        signBinary(outputBinary);
    }
```

**Step 3: Commit**
```bash
git add scripts/prepare-macos-virtual-display-helper.js
git commit -m "feat(stealth): add codesign to helper build script"
```

---

## Task 3: Add Notarization Support

**Files:**
- Create: `scripts/notarize-macos-helper.js`

**Step 1: Create notarization script**

```javascript
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const root = path.resolve(__dirname, '..');
const helperPath = path.join(root, 'assets', 'bin', 'macos', 'stealth-virtual-display-helper');

function log(message) {
    process.stdout.write(`[notarize-macos-helper] ${message}\n`);
}

function run(command, args, options = {}) {
    try {
        return execFileSync(command, args, { 
            stdio: options.silent ? 'pipe' : 'inherit',
            ...options 
        });
    } catch (error) {
        if (!options.silent) {
            throw error;
        }
        return null;
    }
}

async function notarize() {
    if (process.platform !== 'darwin') {
        log('Skipping notarization on non-macOS host');
        return;
    }

    if (!fs.existsSync(helperPath)) {
        log('Helper binary not found, skipping notarization');
        return;
    }

    const appleId = process.env.APPLE_ID;
    const appleIdPassword = process.env.APPLE_ID_PASSWORD;
    const teamId = process.env.APPLE_TEAM_ID;

    if (!appleId || !appleIdPassword || !teamId) {
        log('Skipping notarization: APPLE_ID, APPLE_ID_PASSWORD, or APPLE_TEAM_ID not set');
        return;
    }

    log('Submitting helper for notarization...');
    
    run('xcrun', [
        'notarytool', 'submit',
        helperPath,
        '--apple-id', appleId,
        '--password', appleIdPassword,
        '--team-id', teamId,
        '--wait'
    ]);

    log('Stapling notarization ticket...');
    run('xcrun', ['stapler', 'staple', helperPath]);

    log('Notarization complete');
}

notarize().catch(error => {
    console.error('Notarization failed:', error.message);
    process.exit(1);
});
```

**Step 2: Add npm script**

Add to package.json scripts section:
```json
"notarize:helper": "node scripts/notarize-macos-helper.js"
```

**Step 3: Commit**
```bash
git add scripts/notarize-macos-helper.js package.json
git commit -m "feat(stealth): add notarization script for helper"
```

---

## Task 4: Add Integration Test

**Files:**
- Create: `electron/tests/macosVirtualDisplay.integration.test.ts`

**Step 1: Write integration test**

```typescript
import { describe, it, beforeAll, afterAll } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { spawn } from 'node:child_process';

describe('MacOS Virtual Display Helper Integration', { skip: process.platform !== 'darwin' }, () => {
    const helperPath = process.env.NATIVELY_MACOS_VIRTUAL_DISPLAY_HELPER || 
        path.join(process.cwd(), 'assets/bin/macos/stealth-virtual-display-helper');

    beforeAll(() => {
        if (!require('fs').existsSync(helperPath)) {
            throw new Error(`Helper not found at ${helperPath}`);
        }
    });

    it('returns status with layer3 candidate report', async () => {
        const result = await runHelper(['status']);
        const status = JSON.parse(result);
        
        assert.strictEqual(status.component, 'macos-virtual-display-helper');
        assert.ok(['cgvirtualdisplay', 'unsupported'].includes(status.backend));
        assert.ok(typeof status.layer3Candidate === 'object');
    });

    it('probes capabilities', async () => {
        const result = await runHelper(['probe-capabilities']);
        const response = JSON.parse(result);
        
        assert.ok(['ok', 'blocked'].includes(response.outcome));
        assert.ok(response.data);
        assert.ok(response.data.candidateRenderer);
    });

    it('creates and releases session via serve mode', async () => {
        const child = spawn(helperPath, ['serve'], { stdio: ['pipe', 'pipe', 'pipe'] });
        
        try {
            const response1 = await sendRequest(child, {
                id: 'test-1',
                command: 'create-session',
                sessionId: 'integration-test-1',
                windowId: 'window-1',
                width: 1280,
                height: 720
            });
            
            assert.strictEqual(response1.ok, true);
            assert.strictEqual(response1.result.sessionId, 'integration-test-1');

            const response2 = await sendRequest(child, {
                id: 'test-2',
                command: 'release-session',
                sessionId: 'integration-test-1'
            });
            
            assert.strictEqual(response2.ok, true);
        } finally {
            child.kill();
        }
    });
});

async function runHelper(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        const helperPath = process.env.NATIVELY_MACOS_VIRTUAL_DISPLAY_HELPER || 
            path.join(process.cwd(), 'assets/bin/macos/stealth-virtual-display-helper');
        
        const child = spawn(helperPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        
        child.stdout.on('data', (data) => { stdout += data; });
        child.stderr.on('data', (data) => { stderr += data; });
        
        child.on('close', (code) => {
            if (code === 0) {
                resolve(stdout.trim());
            } else {
                reject(new Error(`Helper exited with code ${code}: ${stderr}`));
            }
        });
        
        child.on('error', reject);
    });
}

async function sendRequest(child: ReturnType<typeof spawn>, request: object): Promise<any> {
    return new Promise((resolve, reject) => {
        let buffer = '';
        const timeout = setTimeout(() => {
            reject(new Error('Request timeout'));
        }, 10000);
        
        const onData = (data: Buffer) => {
            buffer += data.toString();
            const newlineIndex = buffer.indexOf('\n');
            if (newlineIndex >= 0) {
                const line = buffer.slice(0, newlineIndex);
                clearTimeout(timeout);
                child.stdout.off('data', onData);
                try {
                    resolve(JSON.parse(line));
                } catch (e) {
                    reject(e);
                }
            }
        };
        
        child.stdout.on('data', onData);
        child.stdin.write(JSON.stringify(request) + '\n');
    });
}
```

**Step 2: Commit**
```bash
git add electron/tests/macosVirtualDisplay.integration.test.ts
git commit -m "test(stealth): add integration tests for virtual display helper"
```

---

## Task 5: Add README Documentation

**Files:**
- Create: `stealth-projects/macos-virtual-display-helper/README.md`

**Step 1: Write README**

```markdown
# macOS Virtual Display Helper

A Swift command-line tool that creates virtual displays using Apple's CGVirtualDisplay API for secure, capture-resistant presentation.

## Requirements

- macOS 12.4 or later
- Xcode 15.0+ (for Swift 5.9)
- Screen Recording permission (for validation)

## Building

```bash
# Debug build
swift build

# Release build
swift build -c release

# Run tests
swift test
```

## Usage

The helper supports both one-shot and server modes:

### One-shot Mode

```bash
# Check status
./stealth-virtual-display-helper status

# Create session
echo '{"sessionId":"s1","windowId":"w1","width":1280,"height":720}' | \
  ./stealth-virtual-display-helper create-session

# Probe Layer 3 capabilities
./stealth-virtual-display-helper probe-capabilities
```

### Server Mode

```bash
# Start server
./stealth-virtual-display-helper serve

# Send JSON requests via stdin
echo '{"id":"req-1","command":"status"}' | nc -U /dev/stdin
```

## Code Signing

For production builds, the helper must be code-signed with hardened runtime:

```bash
# Set your signing identity
export CODESIGN_IDENTITY="Developer ID Application: Your Name (TEAMID)"

# Build with signing
npm run prepare:macos:virtual-display-helper
```

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Electron App                          │
│  ┌──────────────────────────────────────────────────┐   │
│  │         MacosVirtualDisplayClient                │   │
│  │         (TypeScript)                             │   │
│  └────────────────────┬─────────────────────────────┘   │
│                       │ spawn + JSON IPC                 │
└───────────────────────┼─────────────────────────────────┘
                        │
┌───────────────────────┼─────────────────────────────────┐
│                       ▼                                 │
│  ┌──────────────────────────────────────────────────┐   │
│  │         VirtualDisplayService                    │   │
│  │         (Swift)                                  │   │
│  └────────────────────┬─────────────────────────────┘   │
│                       │                                 │
│  ┌────────────────────┼─────────────────────────────┐   │
│  │                    ▼                             │   │
│  │  ┌────────────────────────────────────────────┐ │   │
│  │  │     CGVirtualDisplayBackend                │ │   │
│  │  │     (CoreGraphics Virtual Display API)     │ │   │
│  │  └────────────────────────────────────────────┘ │   │
│  │                                                 │   │
│  │  ┌────────────────────────────────────────────┐ │   │
│  │  │     AppKitMetalPresenterHost               │ │   │
│  │  │     (Metal-backed fullscreen window)       │ │   │
│  │  └────────────────────────────────────────────┘ │   │
│  └─────────────────────────────────────────────────┘   │
│                                                         │
│                 stealth-virtual-display-helper          │
└─────────────────────────────────────────────────────────┘
```

## Layer 3 Validation

The helper implements a "Layer 3" stealth validation program:

1. **Capability Probe** (`probe-capabilities`): Checks if the system supports:
   - macOS 14+ (required for validation program)
   - CGVirtualDisplay API availability
   - Metal device and command queue
   - ScreenCaptureKit availability
   - Screen Recording permission

2. **Protected Session** (`create-protected-session`): Creates a session for secure presentation

3. **Surface Attachment** (`attach-surface`): Attaches a Metal surface to the virtual display

4. **Presentation** (`present`): Activates/deactivates the presentation window

5. **Validation** (`validate-session`): Checks if the presentation is visible to:
   - CGWindowListCopyWindowInfo (window enumeration)
   - SCShareableContent (ScreenCaptureKit)

## Security Notes

- The helper creates windows at `NSScreenSaver` level for maximum visibility
- Windows are borderless and configured with specific collection behaviors
- The validation probe confirms whether the window is visible to screen capture APIs
- **Note**: The validation returns "failed" or "inconclusive" - it does not prove invisibility
```

**Step 2: Commit**
```bash
git add stealth-projects/macos-virtual-display-helper/README.md
git commit -m "docs(stealth): add README for virtual display helper"
```

---

## Task 6: Update Package.json Build Script

**Files:**
- Modify: `package.json`

**Step 1: Add notarize step to app:build**

The current `app:build` script should include notarization. Modify the script to:

```json
"app:build": "node scripts/ensure-electron-native-deps.js && npm run build && npm run build:native && npm run prepare:macos:virtual-display-helper && npm run notarize:helper && tsc -p electron/tsconfig.json && electron-builder"
```

**Step 2: Commit**
```bash
git add package.json
git commit -m "feat(stealth): integrate helper notarization into app build"
```

---

## Task 7: Run Full Build Verification

**Step 1: Build the helper**
```bash
cd stealth-projects/macos-virtual-display-helper
swift build -c release
```

Expected: Build succeeds with no errors

**Step 2: Run tests**
```bash
swift test
```

Expected: All 30 tests pass

**Step 3: Prepare helper for app bundle**
```bash
cd ../..
npm run prepare:macos:virtual-display-helper
```

Expected: Helper copied to `assets/bin/macos/stealth-virtual-display-helper`

**Step 4: Run Electron tests**
```bash
npm run test:electron
```

Expected: All tests pass

**Step 5: Typecheck**
```bash
npm run typecheck
```

Expected: No errors

**Step 6: Commit verification**
```bash
git add -A
git commit -m "chore(stealth): verify helper builds and integrates correctly"
```

---

## Execution Handoff

**Plan complete and saved to `docs/plans/2026-03-30-macos-virtual-display-helper-production.md`.**

Two execution options:

**1. Subagent-Driven (this session)** - I dispatch fresh subagent per task, review between tasks, fast iteration

**2. Parallel Session (separate)** - Open new session with executing-plans, batch execution with checkpoints

Which approach?
