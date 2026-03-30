# Natively Verified TODO

Single source of truth for remaining remediation work and implementation planning.

**Updated:** March 2026 (completed P0/P1 source re-check, STT lifecycle fixes, settings async guards, disguise timer hardening, calendar OAuth state/PKCE hardening, and premium gate investigation)  
**Basis:** Re-analyzed directly from source and updated after implementation/build verification  
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
- [x] Fixed ElevenLabs stale-close WebSocket race and auth failure normalization in `electron/audio/ElevenLabsStreamingSTT.ts`
- [x] Fixed OpenAI STT duplicate close/failure accounting in `electron/audio/OpenAIStreamingSTT.ts`
- [x] Added quit-path meeting/audio teardown hardening in `electron/main.ts`
- [x] Converted overlay opacity slider to a controlled input in `src/components/SettingsOverlay.tsx`
- [x] Added `startMeeting()` lifecycle guard against re-entrant async initialization in `electron/main.ts`
- [x] Added global shortcut cleanup during quit in `electron/main.ts`
- [x] Added validated rollback/error contracts for undetectable and open-at-login toggles in `electron/ipc/registerSettingsHandlers.ts` and `src/components/SettingsOverlay.tsx`
- [x] Isolated STT settings async results by request/provider and deduplicated concurrent save/test flows in `src/components/SettingsOverlay.tsx`
- [x] Hardened disguise timer tracking/cleanup across rapid stealth toggles in `electron/main.ts`
- [x] Re-verified Deepgram user-facing code paths already reference Nova-3 in `electron/audio/DeepgramStreamingSTT.ts` and `src/config/stt.constants.ts`
- [x] Hardened Google Calendar OAuth callback flow with PKCE, loopback-only callback checks, and auth timeout handling in `electron/services/CalendarManager.ts`
- [x] Re-verified `premium/electron/services/LicenseManager.ts` is an intentional always-unlocked variant in this repo, not an accidental fallback path
- [x] Verified current build health:
  - `npm run build`
  - `npx tsc -p electron/tsconfig.json`

---

## P0 - Verified Next Fixes

### 1. Fix ElevenLabs stale-close WebSocket race

- [x] File: `electron/audio/ElevenLabsStreamingSTT.ts:88`
- [x] File: `electron/audio/ElevenLabsStreamingSTT.ts:306`
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

- [x] File: `electron/audio/ElevenLabsStreamingSTT.ts:282`
- [x] File: `electron/audio/ElevenLabsStreamingSTT.ts:294`
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

- [x] File: `electron/audio/OpenAIStreamingSTT.ts:261`
- [x] File: `electron/audio/OpenAIStreamingSTT.ts:282`
- [x] File: `electron/audio/OpenAIStreamingSTT.ts:341`
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

- [x] File: `electron/main.ts:1014`
- [x] File: `electron/main.ts:1067`
- [x] File: `electron/main.ts:2030`
- Verified issue:
  - `before-quit` only stops Ollama and scrubs credentials
  - active meeting resources are stopped in `endMeeting()` but not on app quit
- Required implementation:
  - if a meeting is active, invoke the same shutdown path before quit completes
  - explicitly stop any remaining system/mic/test capture handles if needed
- Acceptance:
  - no live meeting/STT/audio resources survive app shutdown path

### 5. Fix uncontrolled opacity slider

- [x] File: `src/components/SettingsOverlay.tsx:1559`
- Verified issue:
  - slider uses `defaultValue={overlayOpacity}` instead of `value={overlayOpacity}`
- Required implementation:
  - convert to controlled input
- Acceptance:
  - slider thumb always matches current persisted opacity state

---

## P1 - Verified Stability Fixes

### 6. Add rollback/error handling for undetectable and open-at-login toggles

- [x] File: `src/components/SettingsOverlay.tsx:1315`
- [x] File: `src/components/SettingsOverlay.tsx:1345`
- [x] File: `electron/ipc/registerSettingsHandlers.ts:42`
- [x] File: `electron/ipc/registerSettingsHandlers.ts:55`
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

- [x] File: `electron/main.ts:1014`
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

- [x] File: `src/components/SettingsOverlay.tsx:909`
- Verified issue:
  - `handleTestSttConnection()` reads `sttProvider` and current key from closure
  - provider can change while async request is in flight
- Required implementation:
  - capture a request-scoped provider token
  - ignore stale responses when provider changed
- Acceptance:
  - test result always appears under the provider that initiated it

### 9. Deduplicate concurrent STT key validation/save flows

- [x] File: `src/components/SettingsOverlay.tsx:778`
- Verified issue:
  - `handleSttKeySubmit()` can be re-entered while async test/save work is running
  - state is global (`sttSaving`, `sttTestStatus`) rather than request-scoped
- Required implementation:
  - add request IDs or in-flight guard
  - prevent concurrent save/test overlap per provider
- Acceptance:
  - repeated clicks cannot interleave conflicting save results

### 10. Track and clear delayed disguise-related timers

- [x] File: `electron/main.ts` around `setUndetectable(...)`
- Verified issue:
  - blur-reset timers and disguise force-update timers shared the same tracking array, but not every tracked timer removed itself after firing
  - rapid stealth toggles could leave stale transition callbacks pending until the next cleanup pass
- Implemented:
  - centralized tracked disguise timer scheduling
  - clear pending disguise timers before every stealth transition
  - remove fired timers from the tracking array consistently

---

## P2 - Verified Cleanup / Consistency

### 11. Align Deepgram UI labels with actual implementation

- [x] File: `electron/audio/DeepgramStreamingSTT.ts:2`
- [x] File: `src/config/stt.constants.ts:68`
- [x] File: `src/components/SettingsOverlay.tsx:2290`
- Re-verified status:
  - source paths now reference Nova-3 already
  - no remaining Nova-2 mentions were found in active TS/TSX source during the latest pass

### 12. Add global shortcut cleanup during quit

- [x] File: `electron/main.ts:2030`
- Verified status:
  - useful cleanup improvement
  - not yet re-verified as a live bug, but still a low-cost shutdown hardening step
- Required implementation:
  - call `globalShortcut.unregisterAll()` in quit path

---

## Investigate Separately Before Editing

- [x] `electron/main.ts` disguise timer cleanup path near `setUndetectable(...)`
- [x] `electron/rag/LiveRAGIndexer.ts` queue growth/rate limiting
- [x] `native-module/src/resampler.rs` buffer bounds
- [x] `native-module/src/silence_suppression.rs` VAD decimation correctness
- [x] `premium/electron/services/LicenseManager.ts` fake premium enablement path
- [x] `electron/services/CalendarManager.ts` OAuth CSRF/state flow

---

## Carry Forward - Codebase Review Remaining

### Highest Priority Remaining

### 13. Build `Conscious Mode` as a first-class interview toggle

- [x] Product requirement:
  - add a new toggle named `Conscious Mode`
  - place it in the in-session menu dropdown under the model selector area
  - exact placement: just below the existing `Fast Mode` toggle and the transcript-related toggle(s)
  - goal: make reasoning-first interview coaching a live, conscious behavior toggle rather than a hidden prompt tweak
- [x] Primary outcome:
  - when `Conscious Mode` is enabled, technical interview assistance must **start with spoken reasoning** before implementation
  - the tool should train the user to explain approach, tradeoffs, scale implications, and failure cases before code

### 14. Add reasoning-first interview response architecture

- [x] Files:
  - `electron/IntelligenceManager.ts`
  - `electron/IntelligenceEngine.ts`
  - optional shared type file if useful
- [x] Required implementation:
  - introduce a structured interview coaching response shape instead of a single answer blob
  - suggested fields:
    - `openingReasoning`
    - `implementationPlan`
    - `tradeoffs`
    - `edgeCases`
    - `scaleConsiderations`
    - `pushbackResponses`
    - `likelyFollowUps`
    - `codeTransition`
  - support a dedicated mode marker like `reasoning_first`
- [x] Acceptance:
  - intelligence pipeline can produce structured reasoning-first output for technical questions without breaking existing assist flow

### 15. Add `Conscious Mode` state, persistence, and IPC plumbing

- [x] Files:
  - `electron/ipcHandlers.ts`
  - `electron/preload.ts`
  - `src/types/electron.d.ts`
  - settings persistence path used by the app (`SettingsManager` / local settings state)
  - `src/components/NativelyInterface.tsx`
- [x] Required implementation:
  - add getter/setter IPC for `Conscious Mode`
  - persist the toggle state across sessions
  - load the state on app/session startup
  - make renderer state authoritative and synchronized with backend truth
- [x] Acceptance:
  - toggle state survives restart
  - renderer and backend do not drift

### 16. Implement dropdown UI toggle placement exactly

- [x] Files:
  - `src/components/NativelyInterface.tsx`
  - any dropdown/menu subcomponent used by the in-session control surface
- [x] Required implementation:
  - add `Conscious Mode` into the existing session menu/dropdown
  - keep it visually grouped with other live interview behavior toggles
  - exact ordering target:
    - model selector
    - `Fast Mode`
    - transcript toggle(s)
    - `Conscious Mode`
  - match existing toggle interaction, styling, animation, and persistence behavior
- [x] Acceptance:
  - the toggle is easy to discover during a live interview
  - it behaves exactly like other session toggles

### 17. Update technical interview prompting to prioritize spoken reasoning first

- [x] Files:
  - `electron/llm/prompts.ts`
  - `electron/IntelligenceEngine.ts`
- [x] Required implementation:
  - add dedicated prompts for reasoning-first interview coaching
  - explicitly instruct the model to:
    - not jump straight to code
    - first help the user verbalize the approach aloud
    - mention assumptions
    - mention tradeoffs
    - mention edge cases and scale/failure considerations
    - keep language natural enough to say in an interview
  - add separate prompt behavior for:
    - opening reasoning
    - implementation path
    - pushback handling
    - follow-up extension from prior reasoning
- [x] Acceptance:
  - technical responses open with a concise spoken explanation, not implementation details

### 18. Route qualifying interviewer questions into `Conscious Mode`

- [x] Files:
  - `electron/main.ts`
  - `electron/IntelligenceManager.ts`
  - existing transcript-trigger path(s)
- [x] Required implementation:
  - when `Conscious Mode` is enabled and a final interviewer technical question is detected, use the reasoning-first generation path
  - keep existing non-conscious behavior intact when the toggle is off
  - detect technical/pushback triggers such as:
    - “how would you..."
    - “walk me through..."
    - “why this approach?”
    - “what if this scales?”
    - “what are the tradeoffs?”
    - “what if the input is 10x larger?”
- [x] Acceptance:
  - enabling the toggle measurably changes interview-assist behavior only for the intended question classes

### 19. Preserve a rolling reasoning thread across follow-ups

- [x] Files:
  - `electron/IntelligenceManager.ts`
  - `electron/SessionTracker.ts`
  - any transcript/session context holder
- [x] Required implementation:
  - store the active reasoning thread for the current technical question
  - extend existing reasoning when the interviewer asks follow-ups instead of restarting from scratch
  - reset only when topic/question clearly changes
  - preserve:
    - chosen approach
    - tradeoffs already surfaced
    - edge cases already discussed
    - likely next pushback points
- [x] Acceptance:
  - “why this?”, “what if scale changes?”, and “walk through your thinking” all continue the same thread coherently

### 20. Add pushback-aware coaching as a first-class output block

- [x] Files:
  - `electron/IntelligenceEngine.ts`
  - renderer surfaces that display interview assist
- [x] Required implementation:
  - generate short interviewer-ready responses for common pushback
  - required pushback categories:
    - why this approach
    - larger input / higher scale
    - memory constraints
    - failure cases
    - complexity and tradeoffs
    - production-readiness / robustness
- [x] Acceptance:
  - the user can answer likely interviewer pushback without re-solving the problem from scratch

### 21. Render reasoning-first output as explicit speaking blocks

- [x] Files:
  - `src/components/NativelyInterface.tsx`
  - `src/components/SuggestionOverlay.tsx` or equivalent assist surfaces
- [x] Required implementation:
  - stop rendering the technical answer as one generic blob when `Conscious Mode` is on
  - add distinct sections such as:
    - `Say This First`
    - `Then Build It`
    - `Tradeoffs`
    - `If They Push Back`
    - `If They Ask For Code`
  - ensure the first visible section is concise spoken reasoning
- [x] Acceptance:
  - users can glance and immediately say the reasoning out loud without mentally rewriting the AI output

### 22. Add safeguards so `Conscious Mode` sounds natural under pressure

- [x] Files:
  - prompt layer
  - renderer formatting layer
- [x] Required implementation:
  - keep `openingReasoning` to natural spoken length
  - avoid robotic, essay-style, or over-verbose output
  - prefer one primary approach and one backup tradeoff over many alternatives
  - avoid code unless the interviewer is clearly asking for implementation after reasoning
- [x] Acceptance:
  - output reads like something a candidate can actually say in a live interview

### 23. Add measurement and verification for the feature

- [x] Files:
  - analytics integration points
  - relevant tests for renderer/intelligence flow
- [x] Required implementation:
  - track `Conscious Mode` enabled/disabled usage
  - track whether reasoning-first suggestions are shown and updated after follow-ups
  - add tests for:
    - toggle persistence
    - reasoning-first routing
    - structured response rendering
    - follow-up thread extension
- [x] Acceptance:
  - feature can be verified both functionally and behaviorally

- [x] Finish IPC validation coverage for the remaining raw handlers in:
  - `electron/ipcHandlers.ts`
  - `electron/ipc/registerProfileHandlers.ts`
  - `electron/ipc/registerRagHandlers.ts`
  - `electron/ipc/registerSettingsHandlers.ts`
- [x] Replace loopback HTTP OAuth callback with a stronger production-grade redirect/callback flow in:
  - `electron/services/CalendarManager.ts`
- [x] Remove the remaining eval-based transformers loader without regressing Electron packaging/runtime in:
  - `electron/utils/transformersLoader.js`
  - `electron/llm/IntentClassifier.ts`
  - `electron/rag/providers/LocalEmbeddingProvider.ts`

### Important Remaining

- [x] Continue decomposing `src/components/SettingsOverlay.tsx` into smaller sections/components
- [x] Finish typed IPC coverage across preload/renderer surfaces:
  - `electron/preload.ts`
  - `src/types/electron.d.ts`
  - shared IPC payloads
- [x] Standardize IPC success/error response contracts across remaining handlers
- [x] Improve model-specific token/context budgeting in `electron/LLMHelper.ts`
- [x] Make retry behavior more consistent across LLM request/stream paths in `electron/LLMHelper.ts`
- [x] Replace remaining renderer boilerplate/non-app tests in `renderer/src/App.test.tsx`

### Lower Priority / Architecture

- [x] Finish shrinking `electron/ipcHandlers.ts` after current handler-module extraction
- [x] Revisit shared renderer state / QueryClient architecture in `src/App.tsx`
- [x] Evaluate heavier `postinstall` work in `package.json`
- [x] Consider stricter Electron TypeScript settings in `electron/tsconfig.json`

---

## Recommended Execution Order

- [x] 1. ElevenLabs WebSocket race
- [x] 2. OpenAI duplicate close handling
- [x] 3. `before-quit` meeting/audio teardown
- [x] 4. Controlled opacity slider
- [x] 5. Toggle rollback/error handling
- [x] 6. `startMeeting()` lifecycle guard
- [x] 7. STT settings request isolation
- [x] 8. Label/consistency cleanup

---

## Exit Criteria For This TODO

- [x] STT providers survive rapid switching and retries
- [x] Quit path leaves no active meeting/audio resources behind
- [x] Settings UI does not drift from backend truth
- [x] No stale async settings results render under the wrong provider
- [x] Build still passes after each tranche
