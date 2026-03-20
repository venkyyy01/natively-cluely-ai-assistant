# Natively Verified TODO & New Features

**Updated:** March 2026  
**Basis:** Re-analyzed directly from source in isolation  
**Scope:** Verified next steps, improvements, and security hardening

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

## P0 - Critical Priority

### 1. Security: Rotate Exposed API Keys

- [ ] File: `.env` (root directory)
- Verified issue:
  - Real API keys are committed to the repository (`GEMINI_API_KEY`, `OPENAI_API_KEY`, `DEEPGRAM_API_KEY`)
  - Anyone with repository access can use your API accounts
- Required implementation:
  - Immediately rotate all API keys via each provider's dashboard
  - Remove `.env` from repository (verify gitignore)
  - Use environment variables at runtime only or encrypted config in production
- Acceptance:
  - No API keys in source control
  - Keys loaded securely at runtime

### 2. Security: Fix Broken License Verification

- [ ] File: `premium/electron/services/LicenseManager.ts`
- Verified issue:
  - `activateLicense()` always sets `premiumEnabled = true` and returns `{ success: true }`
  - `isPremium()` always returns `true`
  - Premium features are freely available to all users
- Required implementation:
  - Implement real license validation with online/offline support
  - Add hardware-bound machine fingerprinting
  - Use `safeStorage` for encrypted license persistence
  - Add HMAC signature verification
- Acceptance:
  - License validation actually checks keys against a server
  - Offline validation works with stored encrypted license
  - License is bound to specific machine

### 3. Fix ElevenLabs stale-close WebSocket race

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

### 4. Fix ElevenLabs error contract and auth-failure behavior

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

### 5. Fix OpenAI STT duplicate close/failure accounting

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

### 6. Add meeting/audio teardown in `before-quit`

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

### 7. Fix uncontrolled opacity slider

- [ ] File: `src/components/SettingsOverlay.tsx:1559`
- Verified issue:
  - slider uses `defaultValue={overlayOpacity}` instead of `value={overlayOpacity}`
- Required implementation:
  - convert to controlled input
- Acceptance:
  - slider thumb always matches current persisted opacity state

---

## P1 - High Priority

### 8. Security: Code Obfuscation

- [ ] Files: `vite.config.ts`, `electron/main.ts`
- Verified issue:
  - TypeScript source code is easily readable in packaged app
- Required implementation:
  - Configure `vite-plugin-obfuscator` with control flow flattening, dead code injection, string array encoding
  - Enable Terser minification with console stripping
  - Add code signature verification on macOS startup
- Acceptance:
  - Packaged app code is obfuscated
  - Console logs stripped in production

### 9. Security: Memory Protection for API Keys

- [ ] File: `electron/services/SecureMemory.ts` (new)
- Verified issue:
  - API keys remain in process memory and can be dumped
- Required implementation:
  - Implement `SecureMemoryManager` with encrypted storage, periodic wiping, and emergency wipe on quit/sleep
- Acceptance:
  - API keys encrypted in memory
  - Periodic cleanup of old entries
  - Wipe on app quit and sleep

### 10. Security: Database Encryption

- [ ] File: `electron/db/DatabaseManager.ts`
- Verified issue:
  - SQLite database contains sensitive conversation data in plaintext
- Required implementation:
  - Encrypt sensitive columns (`title_encrypted`, `transcript_encrypted`, `content_encrypted`) using AES-256-GCM
  - Derive encryption key from machine-specific identifier
- Acceptance:
  - All sensitive data encrypted at rest
  - Key derivation consistent per machine

### 11. Add rollback/error handling for undetectable and open-at-login toggles

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

### 12. Guard `startMeeting()` against re-entrant async initialization

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

### 13. Prevent stale STT connection test results from updating the wrong provider UI

- [ ] File: `src/components/SettingsOverlay.tsx:909`
- Verified issue:
  - `handleTestSttConnection()` reads `sttProvider` and current key from closure
  - provider can change while async request is in flight
- Required implementation:
  - capture a request-scoped provider token
  - ignore stale responses when provider changed
- Acceptance:
  - test result always appears under the provider that initiated it

### 14. Deduplicate concurrent STT key validation/save flows

- [ ] File: `src/components/SettingsOverlay.tsx:778`
- Verified issue:
  - `handleSttKeySubmit()` can be re-entered while async test/save work is running
  - state is global (`sttSaving`, `sttTestStatus`) rather than request-scoped
- Required implementation:
  - add request IDs or in-flight guard
  - prevent concurrent save/test overlap per provider
- Acceptance:
  - repeated clicks cannot interleave conflicting save results

### 15. Security: Anti-Debugging Protection

- [ ] File: `electron/security/AntiDebug.ts` (new)
- Verified issue:
  - No protection against debugging/tampering in production builds
- Required implementation:
  - Timing attack detection
  - DevTools monitoring
  - Process status checks for debuggers (lldb, gdb)
  - Intrusion reporting
- Acceptance:
  - Debugger attachment detected and blocked
  - Sensitive data corrupted on detection

### 16. Security: Rate Limiting on API Key Validation

- [ ] File: `electron/security/RateLimiter.ts` (new)
- [ ] File: `electron/ipcHandlers.ts`
- Verified issue:
  - No rate limiting on IPC handlers for API key validation
- Required implementation:
  - Implement sliding window rate limiter (10 req/min, 5 min block)
  - Apply to `test-llm-connection` and similar handlers
- Acceptance:
  - Excessive requests blocked with retry-after header

### 17. Security: Content Security Policy

- [ ] File: `electron/main.ts`
- Verified issue:
  - No CSP configured, allowing potential XSS/injection
- Required implementation:
  - Set strict CSP headers
  - Restrict navigation to allowed domains only
  - Block popup windows to unknown domains
- Acceptance:
  - CSP prevents unauthorized script execution
  - Navigation restricted to natively.ai domains

---

## P2 - Stability & Consistency

### 18. Track and clear delayed disguise-related timers

- [ ] File: `electron/main.ts` around `setUndetectable(...)`
- Verified status:
  - previously identified as likely timer hygiene issue in disguise flow
  - needs one more direct source pass before patching
- Next step:
  - verify all `setTimeout` branches in `setUndetectable()` are tracked/cleared consistently

### 19. Align Deepgram UI labels with actual implementation

- [ ] File: `electron/audio/DeepgramStreamingSTT.ts:2`
- [ ] File: `src/config/stt.constants.ts:68`
- [ ] File: `src/components/SettingsOverlay.tsx:2290`
- Verified issue:
  - implementation uses `model=nova-3`
  - some labels/comments still say Nova-2
- Required implementation:
  - rename labels/comments to Nova-3 everywhere user-facing or developer-facing

### 20. Add global shortcut cleanup during quit

- [ ] File: `electron/main.ts:2030`
- Verified status:
  - useful cleanup improvement
  - not yet re-verified as a live bug, but still a low-cost shutdown hardening step
- Required implementation:
  - call `globalShortcut.unregisterAll()` in quit path

### 21. Security: Screen Capture Detection

- [ ] File: `electron/security/ScreenShareGuard.ts` (new)
- Verified issue:
  - Screen sharing could expose sensitive data
- Required implementation:
  - Monitor `desktopCapturer` sources
  - Apply blur/watermark when Natively windows are being captured
- Acceptance:
  - Screen capture of Natively windows detected and protected

### 22. Security: Network Security Configuration

- [ ] File: `electron/security/NetworkSecurity.ts` (new)
- Verified issue:
  - No HTTPS-only mode or certificate pinning
- Required implementation:
  - Enable HTTPS-only mode for API calls
  - Configure certificate pinning for api.natively.ai
  - Block HTTP redirects
- Acceptance:
  - All API communication over HTTPS
  - Certificate validation enforced

### 23. Security: Input Sanitization for Custom Providers

- [ ] File: `electron/services/providers/curl-validator.ts`
- Verified issue:
  - Custom cURL providers could allow injection
- Required implementation:
  - Block dangerous patterns (cookie, auth headers, output redirects)
  - Whitelist allowed headers
  - Validate `{{TEXT}}` placeholder usage
- Acceptance:
  - Malicious cURL commands rejected
  - Only safe headers allowed

---

## P3 - Conscious Mode (Reasoning-First Interview Coaching)

### 24. Build `Conscious Mode` as a first-class interview toggle

- [ ] Product requirement:
  - add a new toggle named `Conscious Mode`
  - place it in the in-session menu dropdown under the model selector area
  - exact placement: just below the existing `Fast Mode` toggle and the transcript-related toggle(s)
  - goal: make reasoning-first interview coaching a live, conscious behavior toggle rather than a hidden prompt tweak
- [ ] Primary outcome:
  - when `Conscious Mode` is enabled, technical interview assistance must **start with spoken reasoning** before implementation
  - the tool should train the user to explain approach, tradeoffs, scale implications, and failure cases before code

### 25. Add reasoning-first interview response architecture

- [ ] Files:
  - `electron/IntelligenceManager.ts`
  - `electron/IntelligenceEngine.ts`
  - optional shared type file if useful
- [ ] Required implementation:
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
- [ ] Acceptance:
  - intelligence pipeline can produce structured reasoning-first output for technical questions without breaking existing assist flow

### 26. Add `Conscious Mode` state, persistence, and IPC plumbing

- [ ] Files:
  - `electron/ipcHandlers.ts`
  - `electron/preload.ts`
  - `src/types/electron.d.ts`
  - settings persistence path used by the app (`SettingsManager` / local settings state)
  - `src/components/NativelyInterface.tsx`
- [ ] Required implementation:
  - add getter/setter IPC for `Conscious Mode`
  - persist the toggle state across sessions
  - load the state on app/session startup
  - make renderer state authoritative and synchronized with backend truth
- [ ] Acceptance:
  - toggle state survives restart
  - renderer and backend do not drift

### 27. Implement dropdown UI toggle placement exactly

- [ ] Files:
  - `src/components/NativelyInterface.tsx`
  - any dropdown/menu subcomponent used by the in-session control surface
- [ ] Required implementation:
  - add `Conscious Mode` into the existing session menu/dropdown
  - keep it visually grouped with other live interview behavior toggles
  - exact ordering target:
    - model selector
    - `Fast Mode`
    - transcript toggle(s)
    - `Conscious Mode`
  - match existing toggle interaction, styling, animation, and persistence behavior
- [ ] Acceptance:
  - the toggle is easy to discover during a live interview
  - it behaves exactly like other session toggles

### 28. Update technical interview prompting to prioritize spoken reasoning first

- [ ] Files:
  - `electron/llm/prompts.ts`
  - `electron/IntelligenceEngine.ts`
- [ ] Required implementation:
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
- [ ] Acceptance:
  - technical responses open with a concise spoken explanation, not implementation details

### 29. Route qualifying interviewer questions into `Conscious Mode`

- [ ] Files:
  - `electron/main.ts`
  - `electron/IntelligenceManager.ts`
  - existing transcript-trigger path(s)
- [ ] Required implementation:
  - when `Conscious Mode` is enabled and a final interviewer technical question is detected, use the reasoning-first generation path
  - keep existing non-conscious behavior intact when the toggle is off
  - detect technical/pushback triggers such as:
    - "how would you..."
    - "walk me through..."
    - "why this approach?"
    - "what if this scales?"
    - "what are the tradeoffs?"
    - "what if the input is 10x larger?"
- [ ] Acceptance:
  - enabling the toggle measurably changes interview-assist behavior only for the intended question classes

### 30. Preserve a rolling reasoning thread across follow-ups

- [ ] Files:
  - `electron/IntelligenceManager.ts`
  - `electron/SessionTracker.ts`
  - any transcript/session context holder
- [ ] Required implementation:
  - store the active reasoning thread for the current technical question
  - extend existing reasoning when the interviewer asks follow-ups instead of restarting from scratch
  - reset only when topic/question clearly changes
  - preserve:
    - chosen approach
    - tradeoffs already surfaced
    - edge cases already discussed
    - likely next pushback points
- [ ] Acceptance:
  - "why this?", "what if scale changes?", and "walk through your thinking" all continue the same thread coherently

### 31. Add pushback-aware coaching as a first-class output block

- [ ] Files:
  - `electron/IntelligenceEngine.ts`
  - renderer surfaces that display interview assist
- [ ] Required implementation:
  - generate short interviewer-ready responses for common pushback
  - required pushback categories:
    - why this approach
    - larger input / higher scale
    - memory constraints
    - failure cases
    - complexity and tradeoffs
    - production-readiness / robustness
- [ ] Acceptance:
  - the user can answer likely interviewer pushback without re-solving the problem from scratch

### 32. Render reasoning-first output as explicit speaking blocks

- [ ] Files:
  - `src/components/NativelyInterface.tsx`
  - `src/components/SuggestionOverlay.tsx` or equivalent assist surfaces
- [ ] Required implementation:
  - stop rendering the technical answer as one generic blob when `Conscious Mode` is on
  - add distinct sections such as:
    - `Say This First`
    - `Then Build It`
    - `Tradeoffs`
    - `If They Push Back`
    - `If They Ask For Code`
  - ensure the first visible section is concise spoken reasoning
- [ ] Acceptance:
  - users can glance and immediately say the reasoning out loud without mentally rewriting the AI output

### 33. Add safeguards so `Conscious Mode` sounds natural under pressure

- [ ] Files:
  - prompt layer
  - renderer formatting layer
- [ ] Required implementation:
  - keep `openingReasoning` to natural spoken length
  - avoid robotic, essay-style, or over-verbose output
  - prefer one primary approach and one backup tradeoff over many alternatives
  - avoid code unless the interviewer is clearly asking for implementation after reasoning
- [ ] Acceptance:
  - output reads like something a candidate can actually say in a live interview

### 34. Add measurement and verification for the feature

- [ ] Files:
  - analytics integration points
  - relevant tests for renderer/intelligence flow
- [ ] Required implementation:
  - track `Conscious Mode` enabled/disabled usage
  - track whether reasoning-first suggestions are shown and updated after follow-ups
  - add tests for:
    - toggle persistence
    - reasoning-first routing
    - structured response rendering
    - follow-up thread extension
- [ ] Acceptance:
  - feature can be verified both functionally and behaviorally

---

## P4 - Reasoning Engine (Detailed Implementation)

### 35. Create ReasoningEngine

- [ ] File: `electron/llm/ReasoningEngine.ts` (new)
- Required implementation:
  - `generateReasoning()` function that produces `ReasoningOutput` with:
    - `detectedIntent` - classified conversation intent
    - `intentExplanation` - human-readable explanation of detected intent
    - `strategy` - approach guidance tailored to intent
    - `keyPoints` - pedagogical takeaways
    - `whatToRemember` - confidence and context summary
    - `suggestedPhrases` - memorable phrase patterns
  - `generateRefinementReasoning()` for follow-up type explanations (shorten, expand, rephrase, etc.)
- Acceptance:
  - Standalone engine produces accurate reasoning without LLM overhead
  - Refinement reasoning covers all follow-up types

### 36. Integrate ReasoningEngine with IntelligenceEngine

- [ ] File: `electron/IntelligenceEngine.ts`
- Required implementation:
  - Add `reasoning_generated` event to `IntelligenceModeEvents`
  - Add `generateAnswerReasoning()` method called after `runWhatShouldISay`
  - Add refinement reasoning emission after `runFollowUp`
- Acceptance:
  - Reasoning events emitted for every suggested answer
  - Refinement reasoning emitted for every follow-up

### 37. Add Reasoning Mode Settings Toggle

- [ ] Files:
  - `src/components/SettingsPopup.tsx` - add toggle after Interviewer Transcript Toggle
  - `electron/preload.ts` - add IPC handlers for get/set reasoning mode
  - `electron/ipcHandlers.ts` - add handlers for get/set reasoning mode
  - `src/components/SuggestionOverlay.tsx` - read reasoning mode state, conditionally render panel
  - `src/types/electron.d.ts` - add type definitions for reasoning mode IPC
- Required implementation:
  - Brain icon toggle with violet color scheme when enabled
  - Persist to localStorage (`natively_reasoning_mode`)
  - Broadcast changes via IPC to all windows
  - Default enabled on first launch
- Acceptance:
  - Toggle survives app restart
  - Changes reflected immediately across all windows
  - Panel hidden when disabled

### 38. Update SuggestionOverlay UI for Reasoning Panel

- [ ] File: `src/components/SuggestionOverlay.tsx`
- Required implementation:
  - Add collapsible "Why this approach?" panel below suggested answer
  - Display: intent detection, strategy guidance, key takeaways, suggested phrases
  - Display refinement reasoning (why this refinement, pitfall to avoid)
  - Color-coded sections for quick scanning under pressure
- Acceptance:
  - Panel collapses by default, expands on click
  - Information scannable in <3 seconds during live interview

### 39. Add REASONING_NUDGE_PROMPT

- [ ] File: `electron/llm/prompts.ts`
- Required implementation:
  - New prompt for learning/reasoning mode
  - Structure: APPROACH, KEY_POINTS, PITFALLS, PHRASE
  - Focus on metacognition (thinking about thinking)
  - Keep output under 200 words
- Acceptance:
  - Prompt produces concise, actionable reasoning guidance
  - Doesn't bloat the spoken answer

### 40. Add Reasoning Type Definitions

- [ ] File: `electron/llm/types.ts` (new or append)
- Required implementation:
  - `ReasoningOutput` interface
  - `RefinementContext` interface
  - `ReasoningContext` interface
- Acceptance:
  - Types used consistently across engine, IPC, and UI

---

## P5 - Build & Distribution Hardening

### 41. macOS Code Signing & Notarization

- [ ] File: `scripts/sign-app.sh` (new)
- Required implementation:
  - Code sign with Developer ID
  - Include entitlements
  - Submit for notarization via `xcrun notarytool`
- Acceptance:
  - App passes Gatekeeper on macOS
  - No security warnings on launch

### 42. Entitlements Configuration

- [ ] File: `entitlements.plist` (new)
- Required implementation:
  - Enable hardened runtime
  - Disable JIT and unsigned executable memory
  - Enable required permissions (audio, microphone, network, calendars, contacts)
- Acceptance:
  - Minimal permissions granted
  - Hardened runtime active

### 43. Electron Builder Hardening

- [ ] File: `package.json` (electron-builder config)
- Required implementation:
  - Enable ASAR packaging
  - Configure `afterSign` for notarization
  - Set hardened runtime and gatekeeper options
- Acceptance:
  - Production builds are signed and notarized
  - ASAR prevents easy extraction

---

## P6 - Monitoring & Incident Response

### 44. Security Event Logging

- [ ] File: `electron/security/SecurityLogger.ts` (new)
- Required implementation:
  - Batched event logging to `security.log`
  - Critical event alerts to monitoring endpoint
  - Configurable severity levels
- Acceptance:
  - Security events logged with timestamps
  - Critical events trigger alerts

### 45. Telemetry Guard with Consent

- [ ] File: `electron/services/TelemetryGuard.ts` (new)
- Required implementation:
  - Opt-in telemetry with GDPR/CCPA compliance
  - Anonymize all tracked data
  - Strip PII (email, name, apiKey, ip)
- Acceptance:
  - Telemetry disabled by default in EU/GB/CA/VA
  - No PII sent to telemetry endpoint

---

## Investigate Separately Before Editing

- [ ] `electron/main.ts` disguise timer cleanup path near `setUndetectable(...)`
- [x] `electron/rag/LiveRAGIndexer.ts` queue growth/rate limiting
- [x] `native-module/src/resampler.rs` buffer bounds
- [x] `native-module/src/silence_suppression.rs` VAD decimation correctness
- [ ] `premium/electron/services/LicenseManager.ts` fake premium enablement path
- [ ] `electron/services/CalendarManager.ts` OAuth CSRF/state flow

---

## Carry Forward - Codebase Review Remaining

### Highest Priority Remaining

- [ ] Finish IPC validation coverage for the remaining raw handlers in:
  - `electron/ipcHandlers.ts`
  - `electron/ipc/registerProfileHandlers.ts`
  - `electron/ipc/registerRagHandlers.ts`
  - `electron/ipc/registerSettingsHandlers.ts`
- [ ] Replace loopback HTTP OAuth callback with a stronger production-grade redirect/callback flow in:
  - `electron/services/CalendarManager.ts`
- [ ] Remove the remaining eval-based transformers loader without regressing Electron packaging/runtime in:
  - `electron/utils/transformersLoader.js`
  - `electron/llm/IntentClassifier.ts`
  - `electron/rag/providers/LocalEmbeddingProvider.ts`

### Important Remaining

- [ ] Continue decomposing `src/components/SettingsOverlay.tsx` into smaller sections/components
- [ ] Finish typed IPC coverage across preload/renderer surfaces:
  - `electron/preload.ts`
  - `src/types/electron.d.ts`
  - shared IPC payloads
- [ ] Standardize IPC success/error response contracts across remaining handlers
- [ ] Improve model-specific token/context budgeting in `electron/LLMHelper.ts`
- [ ] Make retry behavior more consistent across LLM request/stream paths in `electron/LLMHelper.ts`
- [ ] Replace remaining renderer boilerplate/non-app tests in `renderer/src/App.test.tsx`

### Lower Priority / Architecture

- [ ] Finish shrinking `electron/ipcHandlers.ts` after current handler-module extraction
- [ ] Revisit shared renderer state / QueryClient architecture in `src/App.tsx`
- [ ] Evaluate heavier `postinstall` work in `package.json`
- [ ] Consider stricter Electron TypeScript settings in `electron/tsconfig.json`

---

## Recommended Execution Order

### Immediate (Day 1)
1. Rotate all exposed API keys
2. Fix broken license verification in `LicenseManager.ts`
3. Remove hardcoded secrets from `.env`
4. Enable `contextIsolation: true` in Electron config
5. Add rate limiting to IPC handlers

### Week 1 - Core Stability
6. ElevenLabs WebSocket race
7. OpenAI duplicate close handling
8. `before-quit` meeting/audio teardown
9. Controlled opacity slider
10. Toggle rollback/error handling
11. `startMeeting()` lifecycle guard
12. STT settings request isolation

### Week 1 - Security
13. Implement code obfuscation with vite-plugin-obfuscator
14. Add anti-debugging protection
15. Implement database encryption for sensitive columns
16. Configure Content Security Policy
17. Set up secure memory management for API keys

### Month 1 - Hardening
18. Implement proper code signing and notarization
19. Add screen capture detection
20. Set up security event logging
21. Configure network security (certificate pinning)
22. Implement telemetry guard with consent

### Month 1 - Features
23. Build Conscious Mode toggle and state management
24. Add reasoning-first interview response architecture
25. Update prompting for spoken reasoning first
26. Route qualifying questions into Conscious Mode
27. Preserve rolling reasoning thread across follow-ups
28. Render reasoning-first output as speaking blocks
29. Add measurement and verification

### Ongoing
30. Label/consistency cleanup
31. Continue SettingsOverlay decomposition
32. Regular security audits
33. Dependency vulnerability scanning
34. Penetration testing

---

## Exit Criteria

- [ ] STT providers survive rapid switching and retries
- [ ] Quit path leaves no active meeting/audio resources behind
- [ ] Settings UI does not drift from backend truth
- [ ] No stale async settings results render under the wrong provider
- [ ] Build still passes after each tranche
- [ ] No API keys in source control or bundled JavaScript
- [ ] License validation actually verifies keys
- [ ] Conscious Mode produces natural, structured reasoning-first output
- [ ] Reasoning panel is discoverable and scannable under pressure
- [ ] App passes Gatekeeper and notarization on macOS
