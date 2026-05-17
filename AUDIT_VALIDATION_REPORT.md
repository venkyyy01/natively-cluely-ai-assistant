# VALIDATION REPORT

Primary runtime map verified from code: renderer entry `src/main.tsx`, main-process entry `electron/main.ts`, meeting/audio IPC in `electron/ipc/registerMeetingHandlers.ts`, chat IPC in `electron/ipcHandlers.ts`, STT providers in `electron/audio/*`, model routing in `electron/LLMHelper.ts`, and overlay/window control in `electron/WindowHelper.ts` plus `electron/stealth/StealthManager.ts`.

## Dual-channel STT (system + mic sessions)
Status: DONE

Evidence:
- file: `electron/main.ts`
- functions: `AppState.startMeeting()`, `reconfigureAudio()`, `setupSystemAudioPipeline()`, `createSTTProvider()`, `attachSystemAudioCaptureListeners()`, `attachMicrophoneCaptureListeners()`
- file: `electron/audio/SystemAudioCapture.ts`
- functions: `SystemAudioCapture.start()`
- file: `electron/audio/MicrophoneCapture.ts`
- functions: `MicrophoneCapture.start()`
- flow: renderer `startMeeting()` -> IPC `start-meeting` -> `AppState.startMeeting()` -> `reconfigureAudio()`/`setupSystemAudioPipeline()` -> `SystemAudioCapture` feeds interviewer STT instance and `MicrophoneCapture` feeds user STT instance

Issues (if any):
- None in the traced runtime path.

Risk Level:
- LOW

## Screen recording permission flow (TCC / desktopCapturer)
Status: TO_BE_DONE

Evidence:
- file: `electron/main.ts`
- functions: `ensureMeetingAudioAccess()`, `validateMeetingAudioSetup()`, `takeScreenshot()`, `takeSelectiveScreenshot()`
- file: `electron/ScreenshotHelper.ts`
- functions: `takeScreenshot()`, `takeSelectiveScreenshot()`, `getScreenshotCommand()`
- file: `electron/stealth/TCCMonitor.ts`
- functions: `start()`, `checkTCCDatabase()`
- file: `electron/ipcHandlers.ts`
- functions: `initializeIpcHandlers()`
- flow: renderer screenshot/start-meeting actions -> IPC -> meeting start checks `systemPreferences.getMediaAccessStatus('screen')`; screenshot flow skips preflight and directly shells out to `screencapture`/platform command; TCC monitor only emits stealth warnings

Issues (if any):
- `desktopCapturer` is imported in `electron/ipcHandlers.ts` but never used in any reachable flow.
- There is no shared screen-capture permission service for screenshots and meeting audio.
- Screenshot capture fails late at shell execution time instead of preflighting permission state.
- TCC monitoring is isolated inside stealth code and not wired into user-facing permission handling.

Risk Level:
- MEDIUM

## LLM resilience (OpenAI / Claude / Gemini / Natively fallback chain)
Status: TO_BE_DONE

Evidence:
- file: `src/components/NativelyInterface.tsx`
- functions: renderer `streamGeminiChat()` call sites
- file: `electron/preload.ts`
- functions: `streamGeminiChat()`
- file: `electron/ipcHandlers.ts`
- functions: IPC handlers `gemini-chat`, `gemini-chat-stream`
- file: `electron/LLMHelper.ts`
- functions: `streamChat()`, `streamChatWithGemini()`, `chatWithGemini()`, `streamWithOpenai()`, `streamWithClaude()`, `streamWithGroq()`, `generateWithOpenai()`, `generateWithClaude()`, `generateWithGroq()`
- flow: renderer `streamGeminiChat()` -> IPC `gemini-chat-stream` -> `LLMHelper.streamChat()`; non-streaming `gemini-chat` -> `LLMHelper.chatWithGemini()`

Issues (if any):
- The main streaming path uses `streamChat()`, not the broader fallback executor `streamChatWithGemini()`.
- `streamChat()` hard-routes selected OpenAI/Claude/Groq models directly and does not fall back across providers on failure.
- The Gemini branch in `streamChat()` only does Gemini routing/racing, not OpenAI/Claude/Groq fallback.
- `chatWithGemini()` also bypasses cross-provider fallback when the selected model is OpenAI/Claude/Groq.
- The richer fallback logic exists, but the primary renderer IPC path does not invoke it.

Risk Level:
- HIGH

## Google STT restart logic (4m30 pre-reset)
Status: TO_BE_DONE

Evidence:
- file: `electron/main.ts`
- functions: `createSTTProvider()`
- file: `electron/audio/GoogleSTT.ts`
- functions: `start()`, `startStream()`, `write()`, `stop()`
- flow: `AppState.createSTTProvider()` -> `GoogleSTT.start()` -> `startStream()` -> server-side `end`/`close` clears state -> next `write()` lazily reconnects

Issues (if any):
- No 4m30 pre-reset or rolling stream handoff exists.
- Recovery happens only after Google closes the active stream.
- Long uninterrupted meetings can hit the vendor streaming limit and lose audio around the forced reset.
- The class comment claims periodic restart handling, but the implementation has no such timer.

Risk Level:
- HIGH

## REST STT upload size optimization (16kHz mono)
Status: DONE

Evidence:
- file: `electron/audio/RestSTT.ts`
- functions: `write()`, `flushAndUpload()`, `addWavHeader()`
- file: `electron/audio/OpenAIStreamingSTT.ts`
- functions: `_restFlushAndUpload()`, `_resamplePcm16()`, `_addWavHeader()`
- file: `electron/audio/pcm.ts`
- functions: `resampleToMonoPcm16()`
- flow: REST-capable STT provider receives raw PCM -> resamples/downmixes to mono PCM16 at 16kHz -> uploads WAV payload

Issues (if any):
- None in the traced runtime path.

Risk Level:
- LOW

## Deepgram reconnect cap
Status: TO_BE_DONE

Evidence:
- file: `electron/main.ts`
- functions: `createSTTProvider()`, `reconnectSpeakerStt()`
- file: `electron/audio/DeepgramStreamingSTT.ts`
- functions: `start()`, `connect()`, `scheduleReconnect()`, `stop()`
- flow: `AppState.createSTTProvider()` -> `DeepgramStreamingSTT.start()` -> unexpected WebSocket `close` -> `scheduleReconnect()` -> `connect()` loop

Issues (if any):
- Reconnect backoff is capped by delay only; attempt count is unbounded.
- The provider never emits a terminal exhausted state.
- A persistent close-only failure can keep the internal loop running forever.

Risk Level:
- HIGH

## Windows overlay z-order handling
Status: DONE

Evidence:
- file: `src/App.tsx`
- functions: `handleStartMeeting()`
- file: `electron/ipc/registerWindowHandlers.ts`
- functions: `set-window-mode`
- file: `electron/WindowHelper.ts`
- functions: `switchToOverlay()`, `switchToLauncher()`, `setWindowMode()`
- file: `electron/stealth/StealthManager.ts`
- functions: `applyToWindow()`, `reapplyAfterShow()`, `attachLifecycleListeners()`
- flow: renderer `setWindowMode('overlay')` -> IPC `set-window-mode` -> `WindowHelper.switchToOverlay()` -> opacity shield/show/focus/always-on-top -> `StealthManager.reapplyAfterShow()` on show/move/restore events

Issues (if any):
- None in the traced runtime path.

Risk Level:
- LOW

## macOS compositor delay
Status: TO_BE_DONE

Evidence:
- file: `electron/main.ts`
- functions: `takeScreenshot()`, `takeSelectiveScreenshot()`
- file: `electron/ScreenshotHelper.ts`
- functions: `waitForWindowHide()`, `takeScreenshot()`, `takeSelectiveScreenshot()`
- flow: screenshot request -> `hideMainWindow()` -> `waitForWindowHide()` -> fixed `setTimeout(180ms)` on macOS -> shell `screencapture`

Issues (if any):
- The delay is a blind fixed sleep with no compositor/visibility acknowledgment.
- On slower systems or external displays, the app can still be captured before it is fully off-frame.

Risk Level:
- LOW

## STT key persistence across providers
Status: TO_BE_DONE

Evidence:
- file: `src/components/SettingsOverlay.tsx`
- functions: `handleSttKeySubmit()`, `handleRemoveSttKey()`
- file: `electron/preload.ts`
- functions: `setGroqSttApiKey()`, `setOpenAiSttApiKey()`, `setDeepgramApiKey()`, `setElevenLabsApiKey()`, `setAzureApiKey()`, `setIbmWatsonApiKey()`, `setSonioxApiKey()`, `getStoredCredentials()`
- file: `electron/ipcHandlers.ts`
- functions: STT key save handlers for Groq/OpenAI/Deepgram/ElevenLabs/Azure/IBM Watson/Soniox
- file: `electron/services/CredentialsManager.ts`
- functions: STT setters, `saveCredentials()`, `loadCredentials()`
- flow: settings save/remove -> preload IPC -> `CredentialsManager` setter -> `saveCredentials()` -> later `getStoredCredentials()`/`createSTTProvider()`

Issues (if any):
- `saveCredentials()` catches and logs persistence/encryption failures instead of propagating them.
- IPC save handlers still return success when disk persistence failed.
- That creates a silent failure: the key works in-memory now, but disappears after restart without the UI knowing save failed.

Risk Level:
- MEDIUM

## Custom provider timeout handling
Status: TO_BE_DONE

Evidence:
- file: `src/components/NativelyInterface.tsx`
- functions: renderer `streamGeminiChat()` call sites
- file: `electron/ipcHandlers.ts`
- functions: `gemini-chat`, `gemini-chat-stream`, `switch-to-custom-provider`
- file: `electron/preload.ts`
- functions: `saveCustomProvider()`, `getCustomProviders()`, `deleteCustomProvider()`
- file: `electron/LLMHelper.ts`
- functions: `chatWithCurl()`, `executeCustomProvider()`, `streamChat()`, `switchToCustom()`
- flow: renderer `streamGeminiChat()` -> IPC `gemini-chat-stream` -> `LLMHelper.streamChat()` -> active custom/cURL branch -> `executeCustomProvider()`; non-streaming `gemini-chat` -> `chatWithCurl()`

Issues (if any):
- The live streaming path uses bare `fetch()` in `executeCustomProvider()` with no timeout or abort handling.
- The non-streaming `chatWithCurl()` path has a timeout, but converts failures into `"Error: ..."` assistant text instead of propagating an error.
- `switch-to-custom-provider`/`switchToCustom()` is implemented in main process but not exposed through preload/renderer, leaving a dead second execution path.

Risk Level:
- HIGH

## Model Rotation Engine (multi-provider fallback reliability)
Status: TO_BE_DONE

Evidence:
- file: `electron/ProcessingHelper.ts`
- functions: `loadStoredCredentials()`, `initModelVersionManager()`
- file: `electron/services/ModelVersionManager.ts`
- functions: `initialize()`, `runDiscoveryAndUpgrade()`, `getAllVisionTiers()`, `getTextTieredModels()`, `getAllTextTiers()`
- file: `electron/LLMHelper.ts`
- functions: `generateWithVisionFallback()`, `chatWithGemini()`, `streamChatWithGemini()`, `streamChat()`
- flow: startup -> `ProcessingHelper.loadStoredCredentials()` -> `ModelVersionManager.initialize()`; vision requests use `getAllVisionTiers()`; main text/chat paths read only `getTextTieredModels(...).tier1`

Issues (if any):
- Vision fallback is tiered, but the main text/chat paths never use text tier2/tier3.
- `getAllTextTiers()` exists but is not wired into the primary chat execution paths.
- The engine is partially implemented, not end-to-end reliable for main text fallback.

Risk Level:
- HIGH

# FIX SPEC

## Screen recording permission flow (TCC / desktopCapturer)

### Problem
- Meeting audio checks screen permission, but screenshot capture does not.
- No shared permission service exists.
- `desktopCapturer`/display-media flow is not wired into runtime behavior.

### Target Behavior
- One main-process permission path should determine whether screen capture is ready for both meeting audio and screenshots.
- The renderer should get structured status codes for granted, denied, unavailable, and canceled.
- Screenshot capture should not start until permission readiness is known.

### Implementation Plan
- Files to modify: `electron/main.ts`, `electron/ScreenshotHelper.ts`, `electron/ipcHandlers.ts`, renderer surface that displays permission errors.
- Functions to change: extract a shared screen-capture permission helper from `ensureMeetingAudioAccess()`, call it from screenshot paths, and return structured IPC errors instead of generic shell failures.
- Control flow corrections: preflight permission before shell capture; wire TCC state into user-facing IPC instead of keeping it only in stealth monitoring.

### Edge Cases
- First-run deny on macOS
- Permission revoked while app is open
- TCC DB inaccessible due to SIP
- Windows/Linux paths with no TCC concept

### Reliability Requirements
- No screenshot shell command before permission preflight
- No silent downgrade from denied to generic failure
- Guaranteed window restore even on permission failure

### Validation Plan
- Unit tests for permission-status mapping and IPC responses
- Integration test for screenshot denied/granted and meeting start denied/granted
- Stress test with permission revoked mid-session

## LLM resilience (OpenAI / Claude / Gemini / Natively fallback chain)

### Problem
- The primary streaming path does not use the richer multi-provider fallback executor.
- Selected OpenAI/Claude/Groq models fail terminally instead of falling back.
- The Gemini path only races Gemini models, not the full provider chain.

### Target Behavior
- All live chat entrypoints should share one provider-agnostic fallback orchestration path.
- Selected provider/model should be the preferred first attempt, not the only attempt.
- Timeouts, 404s, 429s, and stream failures should rotate through a bounded fallback chain consistently.

### Implementation Plan
- Files to modify: `electron/LLMHelper.ts`, `electron/ipcHandlers.ts`, possibly mode-specific LLM wrappers that call `streamChat()`.
- Functions to change: unify `streamChat()`, `streamChatWithGemini()`, and `chatWithGemini()` behind one canonical fallback executor.
- Control flow corrections: selected provider first, then modality-aware fallback chain across OpenAI/Claude/Gemini/Groq/custom/Ollama with bounded rotations and structured fallback events.

### Edge Cases
- OpenAI 404 model-not-found
- Claude/Gemini timeout
- Partial stream then provider disconnect
- Multimodal request where some providers lack vision support

### Reliability Requirements
- No infinite provider rotations
- Proper backoff between retries/rotations
- Consistent error classification and renderer events

### Validation Plan
- Unit tests for provider ordering and retry classification
- Integration tests for `gemini-chat-stream` and `gemini-chat` with forced provider failures
- Stress tests for concurrent chats during provider outage

## Google STT restart logic (4m30 pre-reset)

### Problem
- Google streaming STT has no pre-reset timer and only reconnects after server termination.

### Target Behavior
- Long-running Google STT sessions should roll over proactively before vendor stream expiry.
- Audio should continue across rollover without transcript gaps.

### Implementation Plan
- Files to modify: `electron/audio/GoogleSTT.ts`
- Functions to change: `start()`, `startStream()`, `stop()`, internal buffer/stream swap logic
- Control flow corrections: schedule a pre-reset around 4m30, start replacement stream before old stream expiry, move buffered audio safely, clear timers on stop/destroy

### Edge Cases
- 1–2 hour continuous meeting
- Language/sample-rate change during active session
- Network drop during rollover
- Meeting ends while rollover is in progress

### Reliability Requirements
- No infinite restart loop
- Guaranteed timer cleanup
- No duplicate or dropped transcript segments during handoff

### Validation Plan
- Unit tests for timer lifecycle and rollover state transitions
- Integration test simulating >5 minute Google session
- Stress test across repeated long-session rollovers

## Deepgram reconnect cap

### Problem
- Deepgram reconnects forever on persistent failures and never reaches a terminal exhausted state.

### Target Behavior
- Deepgram retries should stop after a bounded budget and surface a final failure to the app.

### Implementation Plan
- Files to modify: `electron/audio/DeepgramStreamingSTT.ts`, optionally `electron/main.ts`
- Functions to change: `scheduleReconnect()`, `start()`, `stop()`
- Control flow corrections: add max reconnect attempts, reset on healthy open, emit exhausted event, stop reconnecting when the cap is hit

### Edge Cases
- Persistent offline network
- Close-only failure without explicit error event
- Clean stop during pending reconnect timer
- Stale close from superseded socket

### Reliability Requirements
- No infinite reconnect loop
- All timers cleared on stop/destroy
- One terminal exhausted notification per outage

### Validation Plan
- Unit tests for capped retries and reset-after-open
- Integration test with repeated unexpected closes
- Stress test for prolonged outage during active meeting

## macOS compositor delay

### Problem
- Screenshot capture depends on a hard-coded 180ms delay instead of confirmed visual removal from the compositor.

### Target Behavior
- The app should only capture after its window is actually hidden/off-frame, or fail predictably after a bounded wait.

### Implementation Plan
- Files to modify: `electron/ScreenshotHelper.ts`, optionally `electron/main.ts` and `electron/WindowHelper.ts`
- Functions to change: `waitForWindowHide()`, screenshot entrypoints
- Control flow corrections: replace blind sleep with hide confirmation plus a bounded settle phase before invoking `screencapture`

### Edge Cases
- External monitors
- Heavy GPU/compositor load
- Overlay mode vs launcher mode
- Selective screenshot cancel

### Reliability Requirements
- No stuck hidden window
- No unbounded wait
- Guaranteed window restore on every exit path

### Validation Plan
- Unit tests for hide/restore sequencing
- Integration tests for launcher and overlay screenshot capture on macOS
- Stress tests with repeated screenshots under load

## STT key persistence across providers

### Problem
- Credential persistence errors are swallowed, so the UI can report success when the encrypted save actually failed.

### Target Behavior
- Save success should mean encrypted on-disk persistence succeeded.
- Save failure should be surfaced to the renderer immediately.

### Implementation Plan
- Files to modify: `electron/services/CredentialsManager.ts`, `electron/ipcHandlers.ts`, `src/components/SettingsOverlay.tsx`
- Functions to change: `saveCredentials()` and all STT credential setters/IPC handlers
- Control flow corrections: propagate persistence errors out of `CredentialsManager`, return failure from IPC, and only mark keys as saved in the renderer after persistence succeeds

### Edge Cases
- `safeStorage` unavailable
- Disk write/rename failure
- Corrupted credential file on load
- Rapid save/remove/provider-switch sequence

### Reliability Requirements
- No silent persistence failure
- In-memory and persisted state must not diverge silently
- Failed save must never mark a provider key as stored

### Validation Plan
- Unit tests with forced encryption/fs failures
- Integration test saving keys, restarting, and reloading stored credentials
- Stress test across repeated save/remove cycles for multiple providers

## Custom provider timeout handling

### Problem
- The live streaming custom-provider path has no timeout or abort.
- The non-streaming path turns failures into assistant text.
- A second custom-provider execution path exists but is dead from the renderer.

### Target Behavior
- All custom-provider execution should go through one canonical executor with timeout, abort, and consistent error propagation.

### Implementation Plan
- Files to modify: `electron/LLMHelper.ts`, `electron/ipcHandlers.ts`, `electron/preload.ts`
- Functions to change: `chatWithCurl()`, `executeCustomProvider()`, custom-provider branch in `streamChat()`
- Control flow corrections: unify custom/cURL execution, add `AbortController` and bounded timeout to fetch-based calls, throw structured errors instead of returning `"Error: ..."` text, remove or expose the dead switch path intentionally

### Edge Cases
- SSE stream stalls after partial output
- Non-JSON or malformed JSON provider response
- HTTP 200 with unusable payload
- User abort during long-running request

### Reliability Requirements
- No unbounded network wait
- No transport error rendered as assistant content
- Guaranteed cleanup of controllers/readers on abort

### Validation Plan
- Unit tests for timeout, abort, and response extraction
- Integration test for `streamGeminiChat()` against a stalled custom endpoint
- Stress test for concurrent custom-provider requests

## Model Rotation Engine (multi-provider fallback reliability)

### Problem
- Text/chat execution only uses tier1 models, leaving tier2/tier3 unused in the primary runtime path.

### Target Behavior
- Text chat should consume the same tiered model rotation strategy already used by vision fallback: stable -> latest -> retry tier.

### Implementation Plan
- Files to modify: `electron/LLMHelper.ts`, `electron/services/ModelVersionManager.ts`
- Functions to change: `chatWithGemini()`, `streamChatWithGemini()`, `streamChat()`
- Control flow corrections: build text provider attempts from `getAllTextTiers()` instead of individual tier1 reads, preserve selected model as first attempt, then tier-escalate with bounded backoff

### Edge Cases
- Discovery not finished yet
- Provider model deprecated mid-session
- Selected model is custom/Ollama
- Concurrent discovery and active request

### Reliability Requirements
- No infinite tier cycling
- Deterministic fallback order per modality
- No duplicate provider execution within the same tier pass

### Validation Plan
- Unit tests for text-tier construction and escalation
- Integration tests forcing tier1 text failure and verifying tier2/tier3 usage
- Stress tests during repeated discovery failures and concurrent chat traffic
