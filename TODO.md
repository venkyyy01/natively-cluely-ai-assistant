# Natively Codebase TODO

**Generated:** March 2026  
**Total Issues:** 40+  
**Priority Legend:** P0 = Critical, P1 = High, P2 = Medium, P3 = Low

---

## Phase 0: Critical Production Fixes (Week 1)

### P0 - Must Fix Immediately

- [ ] **0.1** Fix ElevenLabs WebSocket race condition (`electron/audio/ElevenLabsStreamingSTT.ts:88-110, 301-313`)
  - Add instance ID tracking to prevent stale close handler from nulling new WebSocket
  - Effort: 🟡 (2-8 hours)
  - Owner: Backend Engineer

- [ ] **0.2** Fix OpenAI STT double-failure counting (`electron/audio/OpenAIStreamingSTT.ts:256-263, 277-284, 336-373`)
  - Add re-entrancy guard to `_handleWsClose()`
  - Remove manual calls, let close event fire naturally
  - Effort: 🟢 (< 2 hours)
  - Owner: Backend Engineer

- [ ] **0.3** Add audio resource teardown on quit (`electron/main.ts:2030-2043`)
  - Call `endMeeting()` in `before-quit` handler
  - Stop all audio captures (system, mic, test)
  - Effort: 🟢 (< 2 hours)
  - Owner: Backend Engineer

- [ ] **0.4** Fix uncontrolled opacity slider (`src/components/SettingsOverlay.tsx:1564`)
  - Change `defaultValue` to `value={overlayOpacity}`
  - Effort: 🟢 (< 2 hours)
  - Owner: Frontend Engineer

- [ ] **0.5** Add rollback to settings toggles (`src/components/SettingsOverlay.tsx:1315-1318, 1345-1348`)
  - Wrap toggles with `await` + try/catch
  - Rollback UI state on IPC failure
  - Show error toast to user
  - Effort: 🟡 (2-8 hours)
  - Owner: Frontend Engineer

- [ ] **0.6** Enable TypeScript strict mode (`electron/tsconfig.json`)
  - Add `strict: true`, `strictNullChecks`, `noImplicitAny`
  - Fix all compilation errors
  - Effort: 🟡 (2-8 hours)
  - Owner: Backend Engineer

---

## Phase 1: High-Priority Stability (Week 2-3)

### P1 - Fix This Sprint

- [ ] **1.1** Fix STT test stale closure (`src/components/SettingsOverlay.tsx:909-943`)
  - Use ref to capture current provider at test time
  - Ignore test results if provider changed during async call
  - Effort: 🟢 (< 2 hours)
  - Owner: Frontend Engineer

- [ ] **1.2** Add request dedup to STT key save (`src/components/SettingsOverlay.tsx:778-843`)
  - Use AbortController to cancel in-flight tests
  - Prevent double-click race conditions
  - Effort: 🟢 (< 2 hours)
  - Owner: Frontend Engineer

- [ ] **1.3** Fix `startMeeting` setTimeout race (`electron/main.ts:1029-1061`)
  - Add state machine: `idle | starting | active | stopping`
  - Remove `setTimeout(0)`, inline audio setup
  - Guard against re-entrant calls
  - Effort: 🟡 (2-8 hours)
  - Owner: Backend Engineer

- [ ] **1.4** Track untracked timers in `setUndetectable` (`electron/main.ts:1699-1707`)
  - Add 500ms timers to `_disguiseTimers` array
  - Clear on rapid toggle
  - Effort: 🟢 (< 2 hours)
  - Owner: Backend Engineer

- [ ] **1.5** Clear STT test error on provider switch (`src/components/SettingsOverlay.tsx:765-777`)
  - Reset both `sttTestStatus` AND `sttTestError`
  - Effort: 🟢 (< 2 hours)
  - Owner: Frontend Engineer

- [ ] **1.6** Wrap ElevenLabs error emission (`electron/audio/ElevenLabsStreamingSTT.ts:279, 291`)
  - Emit `Error` instances, not raw JSON
  - Set `isActive = false` on auth_error
  - Effort: 🟢 (< 2 hours)
  - Owner: Backend Engineer

---

## Phase 2: Security Hardening (Week 4-5)

### P1 - Security Critical

- [ ] **2.1** Add IPC input validation with Zod (`electron/ipcHandlers.ts`, new `electron/validators.ts`)
  - Create schemas for all 100+ IPC channels
  - Validate all inputs before processing
  - Effort: 🔴 (1-3 days)
  - Owner: Backend Engineer

- [ ] **2.2** Add OAuth state parameter for Calendar (`electron/services/CalendarManager.ts`)
  - Generate CSRF protection state token
  - Validate on callback
  - Effort: 🟡 (2-8 hours)
  - Owner: Backend Engineer

- [ ] **2.3** Enable hardened runtime for macOS (`package.json`, `entitlements.mac.plist`)
  - Set `hardenedRuntime: true`
  - Remove dangerous entitlements
  - Add notarization
  - Effort: 🟡 (2-8 hours)
  - Owner: DevOps Engineer

- [ ] **2.4** Add `globalShortcut.unregisterAll()` on quit (`electron/main.ts:2030`)
  - Prevent race with `autoUpdater.quitAndInstall()`
  - Effort: 🟢 (< 2 hours)
  - Owner: Backend Engineer

---

## Phase 3: Infrastructure & Testing (Week 6-8)

### P1 - Test Coverage

- [ ] **3.1** Add integration tests for STT lifecycle (`tests/stt-lifecycle.test.ts`)
  - Test rapid provider switches
  - Test meeting start/end race
  - Use Playwright or similar
  - Effort: 🔴 (1-3 days)
  - Owner: QA Engineer

- [ ] **3.2** Add unit tests for audio components (`tests/unit/audio.test.ts`)
  - Test WebSocket lifecycle
  - Test resampling
  - Test error handling
  - Effort: 🔴 (1-3 days)
  - Owner: Backend Engineer

- [ ] **3.3** Add CI security scanning (`.github/workflows/ci.yml`)
  - TypeScript strict check
  - `npm audit`
  - Secret scanning
  - Build verification
  - Effort: 🟡 (2-8 hours)
  - Owner: DevOps Engineer

---

## Phase 4: RAG & Native Module Audit (Week 9-12)

### P0/P1 - Unknown Risk

- [ ] **4.1** Audit RAG embedding queue atomicity (`electron/rag/LiveRAGIndexer.ts`, `electron/rag/VectorStore.ts`)
  - Verify transactions are atomic
  - Check for race conditions
  - Add retry logic
  - Implement rate limiting
  - Add queue size bounds
  - Effort: 🔴 (1-3 days)
  - Owner: Backend Engineer

- [ ] **4.2** Audit native Rust module (`native-module/src/resampler.rs`, `native-module/src/silence_suppression.rs`)
  - Fix resampler buffer bounds (add `MAX_BUFFER_SIZE`)
  - Fix VAD decimation array index bug (`pos.round() as usize`)
  - Add panic handling in NAPI bindings
  - Pre-allocate audio buffers
  - Add memory pressure monitoring
  - Effort: 🔴 (1-3 days)
  - Owner: Rust Engineer

- [ ] **4.3** Replace fake LicenseManager (`premium/electron/services/LicenseManager.ts`)
  - Implement actual license verification OR
  - Remove premium gating entirely
  - Effort: 🟡 (2-8 hours)
  - Owner: Backend Engineer

---

## Phase 5: UX Polish (Week 13+)

### P2/P3 - Nice to Have

- [ ] **5.1** Add overlay position persistence (`src/components/NativelyInterface.tsx`)
  - Save position on every move
  - Restore on mount
  - Effort: 🟢 (< 2 hours)
  - Owner: Frontend Engineer

- [ ] **5.2** Add double-click reset for overlay (`src/components/NativelyInterface.tsx`)
  - Reset to default size on double-click
  - Effort: 🟢 (< 2 hours)
  - Owner: Frontend Engineer

- [ ] **5.3** Add snap zones for overlay presets
  - Common sizes (small, medium, large)
  - Magnetic snapping
  - Effort: 🟡 (2-8 hours)
  - Owner: Frontend Engineer

- [ ] **5.4** Improve resize handle discoverability
  - Hover animations
  - Tooltip hints on first open
  - Effort: 🟢 (< 2 hours)
  - Owner: Frontend Engineer

---

## Backlog - Unreviewed Areas

### Unknown Risk - Need Investigation

- [ ] **?** IntelligenceEngine screen capture OCR (`electron/IntelligenceEngine.ts`)
- [ ] **?** Profile engine resume parsing (`electron/services/ProfileEngine.ts`)
- [ ] **?** Auto-updater signature verification (`electron/main.ts`)
- [ ] **?** Database migration atomicity (`electron/db/DatabaseManager.ts`)
- [ ] **?** Screenshot queue thread safety (`electron/ScreenshotHelper.ts`)

---

## Quick Wins (< 30 minutes each)

- [ ] Fix opacity slider `defaultValue` → `value` (0.4)
- [ ] Clear STT error on provider switch (1.5)
- [ ] Add `globalShortcut.unregisterAll()` on quit (2.4)
- [ ] Track untracked timers in `setUndetectable` (1.4)
- [ ] Wrap ElevenLabs errors in `Error` instances (1.6)
- [ ] Add overlay double-click reset (5.2)

---

## Progress Tracking

### Sprint 1 (Week 1) - Phase 0
- [ ] 0.1 ElevenLabs WebSocket race
- [ ] 0.2 OpenAI double-failure count
- [ ] 0.3 Audio teardown on quit
- [ ] 0.4 Opacity slider
- [ ] 0.5 Settings toggle rollback
- [ ] 0.6 TypeScript strict mode

### Sprint 2 (Week 2-3) - Phase 1
- [ ] 1.1 STT test stale closure
- [ ] 1.2 STT key save dedup
- [ ] 1.3 startMeeting race
- [ ] 1.4 Untracked timers
- [ ] 1.5 Clear STT error
- [ ] 1.6 ElevenLabs error wrapping

### Sprint 3 (Week 4-5) - Phase 2
- [ ] 2.1 IPC validation
- [ ] 2.2 OAuth CSRF
- [ ] 2.3 Hardened runtime
- [ ] 2.4 globalShortcut cleanup

### Sprint 4-6 (Week 6-12) - Phase 3-4
- [ ] 3.1 STT integration tests
- [ ] 3.2 Audio unit tests
- [ ] 3.3 CI security scanning
- [ ] 4.1 RAG audit
- [ ] 4.2 Native module audit
- [ ] 4.3 LicenseManager fix

---

## Success Metrics

| Metric | Baseline | Target | Current |
|--------|----------|--------|---------|
| Test coverage | 0% | 60% | 0% |
| Critical bugs | 12 | 0 | 12 |
| High bugs | 17 | 0 | 17 |
| TypeScript strictness | Partial | 100% | Partial |
| CI security checks | 0 | 4 | 0 |

---

*Last updated: March 2026*  
*Next review: End of Sprint 1*
