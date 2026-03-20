# Natively Verified TODO

**Updated:** March 2026  
**Basis:** Re-analyzed directly from source in isolation  
**Scope:** Only verified next steps and already-completed work

---

## Done Already

- [x] Wrote architecture/code review reports:
  - `CODEBASE_REVIEW_REPORT.md`
  - `IMPLEMENTATION_PLAN.md`
- [x] Fixed native module packaging verification in `build-and-install.sh`
- [x] Added aggressive fresh-clean build/package behavior in `build-and-install.sh`
- [x] Fixed meeting details stale-state rendering in:
  - `src/components/MeetingDetails.tsx`
  - `src/components/Launcher.tsx`
- [x] Improved screenshot capture robustness in `electron/ScreenshotHelper.ts`
- [x] Improved overlay stealth/window behavior in `electron/WindowHelper.ts`
- [x] Added overlay resize plumbing in:
  - `electron/ipcHandlers.ts`
  - `electron/preload.ts`
  - `src/types/electron.d.ts`
- [x] Added smooth scrolling, persisted overlay sizing, and edge/corner resize affordances in `src/components/NativelyInterface.tsx`
- [x] Verified current build health:
  - `npm run build`
  - `npx tsc -p electron/tsconfig.json`

---

## P0 - Verified Next Fixes

### 1. Fix ElevenLabs stale-close WebSocket race

- [ ] File: `electron/audio/ElevenLabsStreamingSTT.ts:88`
- [ ] File: `electron/audio/ElevenLabsStreamingSTT.ts:306`
- Verified issue:
  - `stop()` calls `removeAllListeners()`, `close()`, and nulls `this.ws`
  - `setRecognitionLanguage()` can immediately call `stop()` then `start()`
  - the old socket can still close later and `close` handler unconditionally sets `this.ws = null`
- Required implementation:
  - capture the socket instance in each handler and only mutate state if the closing socket is still the active one
  - avoid unconditionally nulling shared connection state from stale handlers
- Acceptance:
  - rapid language switching does not kill the newly opened session
  - no reconnect storm after stop/start

### 2. Fix ElevenLabs error contract and auth-failure behavior

- [ ] File: `electron/audio/ElevenLabsStreamingSTT.ts:282`
- [ ] File: `electron/audio/ElevenLabsStreamingSTT.ts:294`
- Verified issue:
  - emits raw `msg` / `msg.error` instead of `Error`
  - on `auth_error`, reconnect is disabled but active state is not fully normalized before close path
- Required implementation:
  - always emit `Error` instances
  - make auth failures transition cleanly into a non-active state
- Acceptance:
  - downstream consumers always receive `.message`
  - auth failures surface clearly and do not leave dead buffered sessions

### 3. Fix OpenAI STT duplicate close/failure accounting

- [ ] File: `electron/audio/OpenAIStreamingSTT.ts:261`
- [ ] File: `electron/audio/OpenAIStreamingSTT.ts:282`
- [ ] File: `electron/audio/OpenAIStreamingSTT.ts:341`
- Verified issue:
  - timeout handlers call `_handleWsClose(...)` manually
  - `close` event also calls `_handleWsClose(...)`
  - same failure can be counted twice via `wsFailures++`
- Required implementation:
  - make close handling single-owner
  - either let the `close` event own it, or add a guard to prevent duplicate handling
- Acceptance:
  - one timeout increments failure count once
  - fallback model switching happens only after real repeated failures

### 4. Add meeting/audio teardown in `before-quit`

- [ ] File: `electron/main.ts:1014`
- [ ] File: `electron/main.ts:1067`
- [ ] File: `electron/main.ts:2030`
- Verified issue:
  - `before-quit` only stops Ollama and scrubs credentials
  - active meeting resources are stopped in `endMeeting()` but not on app quit
- Required implementation:
  - if a meeting is active, invoke the same shutdown path before quit completes
  - explicitly stop any remaining system/mic/test capture handles if needed
- Acceptance:
  - no live meeting/STT/audio resources survive app shutdown path

### 5. Fix uncontrolled opacity slider

- [ ] File: `src/components/SettingsOverlay.tsx:1559`
- Verified issue:
  - slider uses `defaultValue={overlayOpacity}` instead of `value={overlayOpacity}`
- Required implementation:
  - convert to controlled input
- Acceptance:
  - slider thumb always matches current persisted opacity state

---

## P1 - Verified Stability Fixes

### 6. Add rollback/error handling for undetectable and open-at-login toggles

- [ ] File: `src/components/SettingsOverlay.tsx:1315`
- [ ] File: `src/components/SettingsOverlay.tsx:1345`
- [ ] File: `electron/ipcHandlers.ts:431`
- [ ] File: `electron/ipcHandlers.ts:449`
- Verified issue:
  - UI flips state immediately and does not await/catch failures from IPC
  - backend currently returns `{ success: true }`, so frontend should still normalize around an explicit result contract
- Required implementation:
  - await IPC call
  - rollback UI on failure
  - show visible error feedback
- Acceptance:
  - UI state reflects backend truth after failures

### 7. Guard `startMeeting()` against re-entrant async initialization

- [ ] File: `electron/main.ts:1014`
- Verified issue:
  - `isMeetingActive = true` is set immediately
  - actual audio init is deferred via `setTimeout(..., 0)`
  - repeated calls can overlap with partially initialized state
- Required implementation:
  - introduce explicit meeting lifecycle state (`idle`, `starting`, `active`, `stopping`)
  - block or collapse duplicate starts
- Acceptance:
  - rapid start/end/start cannot double-start audio/STT resources

### 8. Prevent stale STT connection test results from updating the wrong provider UI

- [ ] File: `src/components/SettingsOverlay.tsx:909`
- Verified issue:
  - `handleTestSttConnection()` reads `sttProvider` and current key from closure
  - provider can change while async request is in flight
- Required implementation:
  - capture a request-scoped provider token
  - ignore stale responses when provider changed
- Acceptance:
  - test result always appears under the provider that initiated it

### 9. Deduplicate concurrent STT key validation/save flows

- [ ] File: `src/components/SettingsOverlay.tsx:778`
- Verified issue:
  - `handleSttKeySubmit()` can be re-entered while async test/save work is running
  - state is global (`sttSaving`, `sttTestStatus`) rather than request-scoped
- Required implementation:
  - add request IDs or in-flight guard
  - prevent concurrent save/test overlap per provider
- Acceptance:
  - repeated clicks cannot interleave conflicting save results

### 10. Track and clear delayed disguise-related timers

- [ ] File: `electron/main.ts` around `setUndetectable(...)`
- Verified status:
  - previously identified as likely timer hygiene issue in disguise flow
  - needs one more direct source pass before patching
- Next step:
  - verify all `setTimeout` branches in `setUndetectable()` are tracked/cleared consistently

---

## P2 - Verified Cleanup / Consistency

### 11. Align Deepgram UI labels with actual implementation

- [ ] File: `electron/audio/DeepgramStreamingSTT.ts:2`
- [ ] File: `src/config/stt.constants.ts:68`
- [ ] File: `src/components/SettingsOverlay.tsx:2290`
- Verified issue:
  - implementation uses `model=nova-3`
  - some labels/comments still say Nova-2
- Required implementation:
  - rename labels/comments to Nova-3 everywhere user-facing or developer-facing

### 12. Add global shortcut cleanup during quit

- [ ] File: `electron/main.ts:2030`
- Verified status:
  - useful cleanup improvement
  - not yet re-verified as a live bug, but still a low-cost shutdown hardening step
- Required implementation:
  - call `globalShortcut.unregisterAll()` in quit path

---

## Investigate Separately Before Editing

- [ ] `electron/main.ts` disguise timer cleanup path near `setUndetectable(...)`
- [ ] `electron/rag/LiveRAGIndexer.ts` queue growth/rate limiting
- [ ] `native-module/src/resampler.rs` buffer bounds
- [ ] `native-module/src/silence_suppression.rs` VAD decimation correctness
- [ ] `premium/electron/services/LicenseManager.ts` fake premium enablement path
- [ ] `electron/services/CalendarManager.ts` OAuth CSRF/state flow

---

## Recommended Execution Order

- [ ] 1. ElevenLabs WebSocket race
- [ ] 2. OpenAI duplicate close handling
- [ ] 3. `before-quit` meeting/audio teardown
- [ ] 4. Controlled opacity slider
- [ ] 5. Toggle rollback/error handling
- [ ] 6. `startMeeting()` lifecycle guard
- [ ] 7. STT settings request isolation
- [ ] 8. Label/consistency cleanup

---

## Exit Criteria For This TODO

- [ ] STT providers survive rapid switching and retries
- [ ] Quit path leaves no active meeting/audio resources behind
- [ ] Settings UI does not drift from backend truth
- [ ] No stale async settings results render under the wrong provider
- [ ] Build still passes after each tranche
