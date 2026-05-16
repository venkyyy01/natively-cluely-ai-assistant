# Natively Codebase Implementation Plan

**Document Version:** 1.0  
**Date:** March 2026  
**Prepared By:** Principal Engineering Review  
**Status:** Ready for Execution

---

## Executive Summary

This document provides a **prioritized, actionable implementation plan** for addressing 40+ identified issues across the Natively codebase. The plan is organized into **sprints** with clear ownership, effort estimates, and acceptance criteria.

### Effort Legend
| Symbol | Duration | Description |
|--------|----------|-------------|
|  | < 2 hours | Quick fix, single file |
| 🟡 | 2-8 hours | Moderate change, 2-4 files |
| 🔴 | 1-3 days | Complex change, 5+ files, testing required |
| 🟣 | 1+ week | Major refactor, cross-cutting concern |

---

## Phase 0: Critical Production Fixes (Week 1)

**Goal:** Eliminate P0 bugs that cause data loss, system instability, or user-facing failures.

---

### Task 0.1: Fix ElevenLabs WebSocket Race Condition

**Priority:** P0 | **Effort:** 🟡 | **Owner:** Backend Engineer

**Problem:** `stop()` + `start()` race nulls out new WebSocket via stale close handler.

**Files to Change:**
- `electron/audio/ElevenLabsStreamingSTT.ts`

**Implementation:**

```typescript
// Line 35: Add instance ID tracking
private instanceId = Date.now() + Math.random();
private currentInstanceId = this.instanceId;

// Line 301-313: Guard close handler
this.ws.on('close', (code: number, reason: Buffer) => {
    // GUARD: Only null out if this is still the current instance
    if (this.instanceId !== this.currentInstanceId) {
        console.log(`[ElevenLabs] Stale close handler (instance ${this.instanceId} vs ${this.currentInstanceId})`);
        return;
    }
    
    this.isConnecting = false;
    this.clearKeepAlive();
    console.log(`[ElevenLabs] Closed (code=${code})`);
    
    if (this.shouldReconnect && code !== 1000) {
        this.scheduleReconnect();
    }
});

// Line 88-110: Update stop() to increment instance ID
public stop(): void {
    this.shouldReconnect = false;
    // ... existing cleanup ...
    this.currentInstanceId = Date.now() + Math.random(); // NEW: invalidate old close handlers
    this.isActive = false;
    // ...
}
```

**Testing:**
- [ ] Rapid language switch 10x without crash
- [ ] Verify transcript continues after 5th switch
- [ ] No memory leak after 50 start/stop cycles

**Acceptance Criteria:**
- [ ] No WebSocket null-out after language change
- [ ] Transcript streaming resumes within 2s of switch
- [ ] Unit test added for race condition

---

### Task 0.2: Fix OpenAI STT Double-Failure Counting

**Priority:** P0 | **Effort:** 🟢 | **Owner:** Backend Engineer

**Problem:** Timeout handlers manually call `_handleWsClose`, which is called again by close event.

**Files to Change:**
- `electron/audio/OpenAIStreamingSTT.ts`

**Implementation:**

```typescript
// Line 45: Add re-entrancy guard
private isHandlingClose = false;

// Line 336-373: Guard _handleWsClose
private _handleWsClose(code: number, reason: Buffer): void {
    // GUARD: Prevent double-processing
    if (this.isHandlingClose) {
        console.log('[OpenAIStreaming] Duplicate close handler ignored');
        return;
    }
    this.isHandlingClose = true;
    
    try {
        // ... existing logic ...
    } finally {
        this.isHandlingClose = false;
    }
}

// Line 256-263, 277-284: Remove manual _handleWsClose calls
// OLD: this._handleWsClose(1006, Buffer.from('Connection Timeout'));
// NEW: Just close, let event handler process
this.ws.removeAllListeners();
this.ws.close();
this.ws = null;
this.isConnecting = false;
// Let the 'close' event fire naturally
```

**Testing:**
- [ ] Simulate timeout, verify `wsFailures` increments only once
- [ ] Verify fallback to REST after 3 actual failures (not 1-2)

**Acceptance Criteria:**
- [ ] `wsFailures` increments once per failure
- [ ] Model doesn't prematurely exhaust failure budget

---

### Task 0.3: Add Audio Resource Teardown on Quit

**Priority:** P0 | **Effort:** 🟢 | **Owner:** Backend Engineer

**Problem:** Native audio handles unreleased on quit, causing system audio distortion.

**Files to Change:**
- `electron/main.ts`

**Implementation:**

```typescript
// Line 2030-2043: Update before-quit handler
app.on("before-quit", async () => {
    console.log("App is quitting, cleaning up resources...");
    
    // NEW: End active meeting first
    if (this.isMeetingActive) {
        console.log('[Main] Ending active meeting before quit...');
        await this.endMeeting().catch(e => {
            console.error('[Main] endMeeting failed during quit:', e);
        });
    }
    
    // NEW: Stop any stray audio captures
    if (this.systemAudioCapture) {
        this.systemAudioCapture.stop();
        this.systemAudioCapture = null;
    }
    if (this.microphoneCapture) {
        this.microphoneCapture.stop();
        this.microphoneCapture = null;
    }
    if (this.audioTestCapture) {
        this.audioTestCapture.stop();
        this.audioTestCapture = null;
    }
    
    // Kill Ollama if we started it
    OllamaManager.getInstance().stop();

    try {
        const { CredentialsManager } = require('./services/CredentialsManager');
        CredentialsManager.getInstance().scrubMemory();
        appState.processingHelper.getLLMHelper().scrubKeys();
        console.log('[Main] Credentials scrubbed from memory on quit');
    } catch (e) {
        console.error('[Main] Failed to scrub credentials on quit:', e);
    }
});
```

**Testing:**
- [ ] Start meeting, quit app, verify no audio distortion in other apps
- [ ] Check Activity Monitor for unreleased audio handles
- [ ] Verify no crash on quit

**Acceptance Criteria:**
- [ ] `endMeeting()` called before quit
- [ ] All audio captures stopped
- [ ] No system audio distortion after quit

---

### Task 0.4: Fix Uncontrolled Opacity Slider

**Priority:** P0 | **Effort:** 🟢 | **Owner:** Frontend Engineer

**Problem:** Slider uses `defaultValue`, desyncs from React state.

**Files to Change:**
- `src/components/SettingsOverlay.tsx`

**Implementation:**

```typescript
// Line 1564: Change defaultValue to value
<input
    type="range"
    min={0.35}
    max={1.0}
    step={0.01}
-   defaultValue={overlayOpacity}
+   value={overlayOpacity}
    onChange={(e) => handleOpacityChange(parseFloat(e.target.value))}
    onPointerDown={startPreviewingOpacity}
    onPointerUp={stopPreviewingOpacity}
    onPointerCancel={stopPreviewingOpacity}
    onPointerLeave={stopPreviewingOpacity}
    className="w-full h-1.5 rounded-full appearance-none bg-bg-input accent-accent-primary cursor-pointer"
    style={{ WebkitAppearance: 'none' } as React.CSSProperties}
/>
```

**Testing:**
- [ ] Drag slider, release, reopen settings — position matches
- [ ] Change opacity via other means (e.g., preset), slider updates

**Acceptance Criteria:**
- [ ] Slider thumb position always matches `overlayOpacity` state
- [ ] No visual glitch on drag end

---

### Task 0.5: Add Rollback to Settings Toggles

**Priority:** P0 | **Effort:** 🟡 | **Owner:** Frontend Engineer

**Problem:** Fire-and-forget IPC on toggles, no rollback on failure.

**Files to Change:**
- `src/components/SettingsOverlay.tsx`

**Implementation:**

```typescript
// Line 1315-1318: Wrap undetectable toggle with error handling
onClick={async () => {
    const newState = !isUndetectable;
    setIsUndetectable(newState); // Optimistic update
    
    try {
        const result = await window.electronAPI?.setUndetectable(newState);
        if (!result?.success) {
            throw new Error(result?.error || 'Failed to update');
        }
    } catch (e: any) {
        // Rollback on failure
        setIsUndetectable(!newState);
        setErrorMessage(`Failed to update stealth mode: ${e.message}`);
        setTimeout(() => setErrorMessage(null), 5000);
    }
}}

// Line 1345-1348: Same pattern for open-at-login
onClick={async () => {
    const newState = !openOnLogin;
    setOpenOnLogin(newState);
    
    try {
        const result = await window.electronAPI?.setOpenAtLogin(newState);
        if (!result?.success) {
            throw new Error(result?.error || 'Failed to update');
        }
    } catch (e: any) {
        setOpenOnLogin(!newState);
        setErrorMessage(`Failed to update login setting: ${e.message}`);
        setTimeout(() => setErrorMessage(null), 5000);
    }
}}
```

**Testing:**
- [ ] Simulate IPC failure, verify UI rolls back
- [ ] Error toast appears with clear message
- [ ] Retry mechanism works

**Acceptance Criteria:**
- [ ] All toggles await IPC response
- [ ] Rollback on failure
- [ ] User-visible error message

---

### Task 0.6: Enable TypeScript Strict Mode for Electron

**Priority:** P0 | **Effort:** 🟡 | **Owner:** Backend Engineer

**Problem:** Missing strict mode allows type-unsafe code.

**Files to Change:**
- `electron/tsconfig.json`

**Implementation:**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
+   "strict": true,
+   "strictNullChecks": true,
+   "noImplicitAny": true,
+   "noImplicitReturns": true,
+   "noUnusedLocals": true,
+   "noUnusedParameters": true,
    "outDir": "./dist-electron",
    ...
  }
}
```

**Then fix all compilation errors:**
```bash
npx tsc -p electron/tsconfig.json --noEmit
```

**Testing:**
- [ ] Full build passes with strict mode
- [ ] No `any` types in critical paths

**Acceptance Criteria:**
- [ ] Strict mode enabled
- [ ] Zero compilation errors
- [ ] CI enforces strict mode

---

## Phase 1: High-Priority Stability (Week 2-3)

**Goal:** Address race conditions, error handling gaps, and user-facing bugs.

---

### Task 1.1: Fix STT Test Stale Closure

**Priority:** P1 | **Effort:** 🟢 | **Owner:** Frontend Engineer

**Files:** `src/components/SettingsOverlay.tsx:909-943`

**Implementation:**
```typescript
// Use ref to capture current provider at test time
const sttProviderRef = useRef(sttProvider);
useEffect(() => { sttProviderRef.current = sttProvider; }, [sttProvider]);

const handleTestSttConnection = async () => {
    const provider = sttProviderRef.current; // Use ref, not closure
    // ... rest of test logic
    try {
        const result = await window.electronAPI?.testSttConnection?.(
            provider, // Use captured ref value
            keyToTest.trim(),
            ...
        );
        // Check if provider changed during test
        if (sttProviderRef.current !== provider) {
            console.log('[Settings] Provider changed during test, ignoring result');
            return;
        }
        // ... handle result
    }
};
```

---

### Task 1.2: Add Request Dedup to STT Key Save

**Priority:** P1 | **Effort:** 🟢 | **Owner:** Frontend Engineer

**Files:** `src/components/SettingsOverlay.tsx:778-843`

**Implementation:**
```typescript
const sttTestAbortRef = useRef<AbortController | null>(null);

const handleSttKeySubmit = async (provider, key) => {
    // Cancel any in-flight test
    if (sttTestAbortRef.current) {
        sttTestAbortRef.current.abort();
    }
    
    const abortController = new AbortController();
    sttTestAbortRef.current = abortController;
    
    try {
        const testResult = await window.electronAPI?.testSttConnection?.(
            provider,
            keyToTest.trim(),
            { signal: abortController.signal }
        );
        // ... rest of logic
    } finally {
        if (sttTestAbortRef.current === abortController) {
            sttTestAbortRef.current = null;
        }
    }
};
```

---

### Task 1.3: Fix `startMeeting` setTimeout Race

**Priority:** P1 | **Effort:** 🟡 | **Owner:** Backend Engineer

**Files:** `electron/main.ts:1029-1061`

**Implementation:**
```typescript
// Line 144: Add state enum
private meetingState: 'idle' | 'starting' | 'active' | 'stopping' = 'idle';

// Line 1011-1062: Replace setTimeout with state machine
public async startMeeting(metadata?: any): Promise<{ success: boolean; error?: string }> {
    // Guard against re-entrant calls
    if (this.meetingState !== 'idle') {
        console.warn(`[Main] startMeeting called while ${this.meetingState}`);
        return { success: false, error: 'Meeting already starting or active' };
    }
    
    this.meetingState = 'starting';
    this.isMeetingActive = true;
    
    try {
        // Inline audio setup, no setTimeout
        this.setupSystemAudioPipeline();
        await this.systemAudioCapture?.start();
        await this.googleSTT?.start();
        // ... rest of setup
        
        this.meetingState = 'active';
        return { success: true };
    } catch (e) {
        this.meetingState = 'idle';
        this.isMeetingActive = false;
        throw e;
    }
}
```

---

### Task 1.4: Track Untracked Timers in setUndetectable

**Priority:** P1 | **Effort:** 🟢 | **Owner:** Backend Engineer

**Files:** `electron/main.ts:1699-1707`

**Implementation:**
```typescript
// Line 1698-1707: Add timers to tracking array
if (targetFocusWindow && (targetFocusWindow === settingsWindow)) {
    const timer = setTimeout(() => {
        this.settingsWindowHelper.setIgnoreBlur(false);
    }, 500);
    this._disguiseTimers.push(timer); // NEW: track for cleanup
}
if (isModelSelectorVisible) {
    const timer = setTimeout(() => {
        this.modelSelectorWindowHelper.setIgnoreBlur(false);
    }, 500);
    this._disguiseTimers.push(timer); // NEW: track for cleanup
}
```

---

### Task 1.5: Clear STT Test Error on Provider Switch

**Priority:** P1 | **Effort:** 🟢 | **Owner:** Frontend Engineer

**Files:** `src/components/SettingsOverlay.tsx:765-777`

**Implementation:**
```typescript
const handleSttProviderChange = async (provider) => {
    setSttProvider(provider);
    setSttTestStatus('idle');
    setSttTestError(null); // NEW: clear stale error
    setSttSaved(false);
    // ... rest of logic
};
```

---

### Task 1.6: Wrap ElevenLabs Error Emission

**Priority:** P1 | **Effort:** 🟢 | **Owner:** Backend Engineer

**Files:** `electron/audio/ElevenLabsStreamingSTT.ts:279, 291`

**Implementation:**
```typescript
// Line 279: Wrap in Error instance
this.emit('error', new Error(msg?.message || msg?.error || 'Unknown ElevenLabs error'));

// Line 291: Same pattern
this.emit('error', new Error(msg?.error?.message || 'Unknown server error'));

// Also set isActive = false on auth_error
if (msg.type === 'error' && msg.error?.type === 'auth_error') {
    this.isActive = false; // NEW: prevent buffering into dead session
    this.shouldReconnect = false;
    this.emit('error', new Error(msg.error?.message || 'Authentication failed'));
    // ... close socket
}
```

---

## Phase 2: Security Hardening (Week 4-5)

**Goal:** Close security gaps in IPC, OAuth, and credential handling.

---

### Task 2.1: Add IPC Input Validation with Zod

**Priority:** P1 | **Effort:** 🔴 | **Owner:** Backend Engineer

**Files:** `electron/ipcHandlers.ts`, new `electron/validators.ts`

**Implementation:**

```typescript
// New file: electron/validators.ts
import { z } from 'zod';

export const IpcSchemas = {
    setSttProvider: z.object({
        provider: z.enum(['google', 'groq', 'openai', 'deepgram', 'elevenlabs', 'azure', 'ibmwatson', 'soniox'])
    }),
    
    setDeepgramApiKey: z.object({
        apiKey: z.string().min(1).regex(/^[a-zA-Z0-9_-]+$/, 'Invalid API key format')
    }),
    
    testSttConnection: z.object({
        provider: z.enum(['groq', 'openai', 'deepgram', 'elevenlabs', 'azure', 'ibmwatson', 'soniox']),
        apiKey: z.string().min(1),
        region: z.string().optional()
    }),
    
    // ... add schemas for all 100+ IPC channels
};

// Update electron/ipcHandlers.ts
import { IpcSchemas } from './validators';

safeHandle("set-stt-provider", async (_, provider: any) => {
    const result = IpcSchemas.setSttProvider.safeParse({ provider });
    if (!result.success) {
        console.warn('[IPC] Invalid set-stt-provider input:', result.error);
        return { success: false, error: result.error.message };
    }
    
    // ... existing handler logic
});
```

**Testing:**
- [ ] Send malformed IPC from renderer, verify rejection
- [ ] All schemas cover edge cases (empty strings, invalid enums)

---

### Task 2.2: Add OAuth State Parameter for Calendar

**Priority:** P1 | **Effort:** 🟡 | **Owner:** Backend Engineer

**Files:** `electron/services/CalendarManager.ts`

**Implementation:**
```typescript
// Line 11-13: Add state generation
import { randomBytes } from 'crypto';

private oauthState: string | null = null;

// Line 64: Generate state before redirect
public getAuthorizationUrl(): string {
    this.oauthState = randomBytes(32).toString('hex');
    
    const params = new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        response_type: 'code',
        scope: SCOPES.join(' '),
        access_type: 'offline',
        prompt: 'consent',
        state: this.oauthState // NEW: CSRF protection
    });
    
    return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

// Line 100-120: Validate state on callback
public async handleCallback(code: string, state: string): Promise<void> {
    if (state !== this.oauthState) {
        throw new Error('OAuth state mismatch. CSRF attack suspected');
    }
    this.oauthState = null; // Clear after use
    // ... rest of token exchange
}
```

---

### Task 2.3: Enable Hardened Runtime for macOS

**Priority:** P1 | **Effort:** 🟢 | **Owner:** DevOps Engineer

**Files:** `package.json`, `entitlements.mac.plist`

**Implementation:**

```json
// package.json electron-builder config
"build": {
    "mac": {
+     "hardenedRuntime": true,
+     "gatekeeperAssess": false,
      "entitlements": "assets/entitlements.mac.plist",
      "entitlementsInherit": "assets/entitlements.mac.plist",
      "notarize": {
        "teamId": "YOUR_TEAM_ID"
      }
    }
}
```

```xml
<!-- entitlements.mac.plist: Remove dangerous entitlements -->
<key>com.apple.security.cs.allow-unsigned-executable-memory</key>
-<true/>
+<false/>

<key>com.apple.security.cs.disable-library-validation</key>
-<true/>
+<false/>
```

---

### Task 2.4: Add globalShortcut.unregisterAll on Quit

**Priority:** P1 | **Effort:** 🟢 | **Owner:** Backend Engineer

**Files:** `electron/main.ts`

**Implementation:**
```typescript
// Line 2030-2043: Add to before-quit handler
app.on("before-quit", async () => {
    // ... existing cleanup ...
    
    // NEW: Unregister all global shortcuts
    globalShortcut.unregisterAll();
    console.log('[Main] Global shortcuts unregistered');
    
    // ... rest of cleanup ...
});
```

---

## Phase 3: Infrastructure & Testing (Week 6-8)

**Goal:** Build test coverage and CI/CD safeguards.

---

### Task 3.1: Add Integration Tests for STT Lifecycle

**Priority:** P1 | **Effort:** 🔴 | **Owner:** QA Engineer

**Files:** New `tests/stt-lifecycle.test.ts`

**Implementation:**
```typescript
import { test, expect } from '@playwright/test';

test.describe('STT Provider Lifecycle', () => {
    test('should handle rapid provider switches', async ({ page }) => {
        // Open settings
        await page.click('[data-testid="settings-button"]');
        
        // Rapidly switch providers 10x
        for (let i = 0; i < 10; i++) {
            await page.selectOption('[data-testid="stt-provider"]', 'deepgram');
            await page.selectOption('[data-testid="stt-provider"]', 'groq');
        }
        
        // Verify no crash, transcript still works
        await expect(page.locator('[data-testid="transcript"]')).toBeVisible();
    });
    
    test('should handle meeting start/end race', async ({ page }) => {
        // Rapid start/end/start
        await page.click('[data-testid="start-meeting"]');
        await page.click('[data-testid="end-meeting"]');
        await page.click('[data-testid="start-meeting"]');
        
        // Verify single active meeting
        const activeMeetings = await page.$$('[data-testid="active-meeting"]');
        expect(activeMeetings.length).toBe(1);
    });
});
```

---

### Task 3.2: Add Unit Tests for Audio Components

**Priority:** P1 | **Effort:** 🔴 | **Owner:** Backend Engineer

**Files:** New `tests/unit/audio.test.ts`

**Implementation:**
```typescript
import { DeepgramStreamingSTT } from '../../electron/audio/DeepgramStreamingSTT';

describe('DeepgramStreamingSTT', () => {
    test('should handle stop+start without nulling new WebSocket', async () => {
        const stt = new DeepgramStreamingSTT('fake-key');
        
        stt.start();
        await waitFor(() => stt.isActive);
        
        stt.stop();
        stt.start(); // Should not be nulled by old close handler
        
        await waitFor(() => stt.isActive);
        expect(stt.isActive).toBe(true);
    });
    
    test('should resample audio correctly', async () => {
        const stt = new DeepgramStreamingSTT('fake-key');
        stt.setSampleRate(48000);
        stt.setAudioChannelCount(2);
        
        const mockChunk = Buffer.alloc(1024);
        stt.write(mockChunk);
        
        // Verify resampling happened without error
        // (Would need to spy on WebSocket send)
    });
});
```

---

### Task 3.3: Add CI Security Scanning

**Priority:** P1 | **Effort:** 🟡 | **Owner:** DevOps Engineer

**Files:** `.github/workflows/ci.yml`

**Implementation:**
```yaml
name: CI

on: [push, pull_request]

jobs:
  build:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Install dependencies
        run: npm ci
      
      - name: TypeScript strict check
        run: npx tsc -p electron/tsconfig.json --noEmit
      
      - name: Security audit
        run: npm audit --audit-level=moderate
      
      - name: Check for hardcoded secrets
        run: |
          ! grep -r "sk-[a-zA-Z0-9]{32}" --include="*.ts" --include="*.tsx" .
          ! grep -r "ghp_[a-zA-Z0-9]{36}" --include="*.ts" --include="*.tsx" .
      
      - name: Build
        run: npm run build
      
      - name: Run tests
        run: npm test
```

---

## Phase 4: RAG & Native Module Audit (Week 9-12)

**Goal:** Audit and fix high-risk unreviewed areas.

---

### Task 4.1: Audit RAG Embedding Queue Atomicity

**Priority:** P1 | **Effort:** 🔴 | **Owner:** Backend Engineer

**Files:** `electron/rag/LiveRAGIndexer.ts`, `electron/rag/VectorStore.ts`

**Checklist:**
- [ ] Verify embedding queue transactions are atomic
- [ ] Check for race conditions in `feedSegments()` + `flush()`
- [ ] Add retry logic for failed embeddings
- [ ] Implement rate limiting (token bucket)
- [ ] Add queue size bounds

---

### Task 4.2: Audit Native Rust Module

**Priority:** P0 | **Effort:** 🔴 | **Owner:** Rust Engineer

**Files:** `native-module/src/resampler.rs`, `native-module/src/silence_suppression.rs`

**Checklist:**
- [ ] Fix resampler buffer bounds (add `MAX_BUFFER_SIZE`)
- [ ] Fix VAD decimation array index bug (`pos.round() as usize`)
- [ ] Add panic handling in NAPI bindings
- [ ] Pre-allocate audio buffers (arena allocation)
- [ ] Add memory pressure monitoring

---

### Task 4.3: Replace Fake LicenseManager

**Priority:** P2 | **Effort:** 🟡 | **Owner:** Backend Engineer

**Files:** `premium/electron/services/LicenseManager.ts`

**Implementation:**
```typescript
// Option 1: Implement actual license verification
public async activateLicense(key: string): Promise<{ success: boolean; error?: string }> {
    try {
        const response = await fetch('https://api.natively.ai/validate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key, machineId: machineIdSync() })
        });
        
        if (!response.ok) {
            return { success: false, error: 'Invalid license key' };
        }
        
        this.premiumEnabled = true;
        this.licenseKey = key;
        return { success: true };
    } catch (e) {
        return { success: false, error: 'License server unreachable' };
    }
}

// Option 2: Remove premium gating entirely
// Delete premium/ directory, remove all license checks
```

---

## Phase 5: UX Polish (Week 13+)

**Goal:** Improve user experience and discoverability.

---

### Task 5.1: Add Overlay Position Persistence

**Priority:** P2 | **Effort:** 🟢 | **Owner:** Frontend Engineer

**Files:** `src/components/NativelyInterface.tsx`

**Implementation:**
```typescript
// Save position on every move
useEffect(() => {
    const handleMove = () => {
        localStorage.setItem('natively_overlay_x', String(window.screenX));
        localStorage.setItem('natively_overlay_y', String(window.screenY));
    };
    
    window.addEventListener('move', handleMove);
    return () => window.removeEventListener('move', handleMove);
}, []);

// Restore on mount
useEffect(() => {
    const x = localStorage.getItem('natively_overlay_x');
    const y = localStorage.getItem('natively_overlay_y');
    
    if (x && y) {
        window.electronAPI?.setOverlayBounds({
            width: panelWidth,
            height: chatViewportHeight,
            x: Number(x),
            y: Number(y)
        });
    }
}, []);
```

---

### Task 5.2: Add Double-Click Reset for Overlay

**Priority:** P3 | **Effort:** 🟢 | **Owner:** Frontend Engineer

**Files:** `src/components/NativelyInterface.tsx`

**Implementation:**
```typescript
const handleResizeDoubleClick = () => {
    setPanelWidth(600);
    setChatViewportHeight(450);
    window.electronAPI?.setOverlayBounds({
        width: 600,
        height: 450,
        x: undefined,
        y: undefined
    });
};

// Add to resize handle buttons
<button
    onDoubleClick={handleResizeDoubleClick}
    // ... existing props
>
```

---

## Appendix: Issue Tracking Matrix

| ID | Issue | Phase | Status | Owner |
|----|-------|-------|--------|-------|
| 0.1 | ElevenLabs WebSocket race | Phase 0 | ⏳ Pending | Backend |
| 0.2 | OpenAI double-failure count | Phase 0 | ⏳ Pending | Backend |
| 0.3 | Audio teardown on quit | Phase 0 | ⏳ Pending | Backend |
| 0.4 | Uncontrolled opacity slider | Phase 0 | ⏳ Pending | Frontend |
| 0.5 | Settings toggle rollback | Phase 0 | ⏳ Pending | Frontend |
| 0.6 | TypeScript strict mode | Phase 0 | ⏳ Pending | Backend |
| 1.1 | STT test stale closure | Phase 1 | ⏳ Pending | Frontend |
| 1.2 | STT key save dedup | Phase 1 | ⏳ Pending | Frontend |
| 1.3 | startMeeting race | Phase 1 | ⏳ Pending | Backend |
| 1.4 | Untracked timers | Phase 1 | ⏳ Pending | Backend |
| 1.5 | Clear STT error on switch | Phase 1 | ⏳ Pending | Frontend |
| 1.6 | ElevenLabs error wrapping | Phase 1 | ⏳ Pending | Backend |
| 2.1 | IPC input validation | Phase 2 | ⏳ Pending | Backend |
| 2.2 | OAuth CSRF protection | Phase 2 | ⏳ Pending | Backend |
| 2.3 | Hardened runtime | Phase 2 | ⏳ Pending | DevOps |
| 2.4 | globalShortcut cleanup | Phase 2 | ⏳ Pending | Backend |
| 3.1 | STT integration tests | Phase 3 | ⏳ Pending | QA |
| 3.2 | Audio unit tests | Phase 3 | ⏳ Pending | Backend |
| 3.3 | CI security scanning | Phase 3 | ⏳ Pending | DevOps |
| 4.1 | RAG audit | Phase 4 | ⏳ Pending | Backend |
| 4.2 | Native module audit | Phase 4 | ⏳ Pending | Rust |
| 4.3 | LicenseManager fix | Phase 4 | ⏳ Pending | Backend |
| 5.1 | Overlay position persist | Phase 5 | ⏳ Pending | Frontend |
| 5.2 | Double-click reset | Phase 5 | ⏳ Pending | Frontend |

---

## Success Metrics

| Metric | Baseline | Target | Timeline |
|--------|----------|--------|----------|
| Test coverage | 0% | 60% | 3 months |
| Critical bugs | 12 | 0 | 2 weeks |
| High bugs | 17 | 0 | 6 weeks |
| TypeScript strictness | Partial | 100% | 2 weeks |
| CI security checks | 0 | 4 | 6 weeks |
| User-facing crashes | Unknown | 0 | Ongoing |

---

*This document is living. Update after each sprint.*
