# Windows 11 Reliability Audit

Date: 2026-04-02
Repository: `natively-cluely-ai-assistant`
Scope: Electron main process, renderer, TypeScript services, Rust native module
Platform assumption: Windows 11 only

## Verdict

This branch is not production-grade on Windows 11 for sustained heavy use.

From code alone, the app looks likely usable for short, single-display sessions under light load. It is likely to degrade or fail during long meetings, sleep/resume cycles, audio device churn, multi-monitor use, or high-frequency UI streaming.

Current reliability estimate:

- Likely stable: short sessions, no device changes, no sleep/resume, limited streaming activity.
- Likely to degrade: multi-hour sessions with live transcripts, long streamed answers, or large meeting checkpoints.
- Likely to fail: Windows audio engine stalls, monitor topology changes, watchdog-enabled browser usage, or shutdown during pending persistence work.

## Findings

### 1. Critical - Windows always uses the offscreen PNG shell path, even in standard mode

**Files:** `electron/WindowHelper.ts:54-56`, `electron/WindowHelper.ts:279-287`, `electron/WindowHelper.ts:349-357`, `electron/stealth/StealthRuntime.ts:115-139`, `electron/stealth/frameBridge.ts:37-46`, `electron/renderer/shell.ts:30-39`

**Root cause:** `WindowHelper.shouldUseStealthRuntime()` returns `true` for every non-macOS platform, so Windows never uses a direct `BrowserWindow`. The visible shell window receives full rendered frames as PNG data URLs over IPC and redraws them onto a canvas.

**Reproduction:**
1. Run the app on Windows 11 with default settings.
2. Open the launcher or overlay.
3. Stream transcripts or long answers.
4. Every paint must go through offscreen render -> `toPNG()` -> base64 -> IPC -> browser image decode -> canvas draw.

**Why this fails specifically on Windows:** The code path is unconditional on Windows because `process.platform !== 'darwin'` forces `StealthRuntime`, even when undetectable mode is off.

**Impact under heavy usage:** Higher CPU and memory churn, IPC pressure, decode overhead, input lag, resize jitter, and worse responsiveness on high-DPI or laptop hardware. This directly conflicts with the audit definition of stealth as minimal and predictable resource usage.

**Concrete fix:** Use a direct `BrowserWindow` path on Windows standard mode. Only enable the offscreen shell when a Windows-specific stealth requirement truly needs it. If the shell path must exist, replace PNG/data-URL transport with a dirty-rect or shared-texture approach and make it adaptive instead of always-on.

### 2. Critical - Windows system-audio capture can fail silently while the app thinks capture is healthy

**Files:** `native-module/src/speaker/windows.rs:112-122`, `native-module/src/speaker/windows.rs:202-205`, `native-module/src/speaker/windows.rs:244-246`, `native-module/src/lib.rs:130-143`, `native-module/src/lib.rs:213-220`, `electron/audio/SystemAudioCapture.ts:87-107`, `electron/audio/meetingAudioSequencing.ts:111-129`

**Root cause:** WASAPI init failures and init timeouts are converted into a fake sample rate (`44100`) instead of a hard failure. Later, if the WASAPI event wait times out once, the native capture loop exits, but the outer DSP loop keeps emitting synthetic silence every 100 ms.

**Reproduction:**
1. Start a meeting while the default output device is changing, resuming from sleep, or otherwise slow to initialize.
2. The TypeScript wrapper waits only 3 seconds, while Rust waits up to 5 seconds before deciding init succeeded.
3. If init fails or stalls, Rust falls back to `44100` and JS still proceeds.
4. If the loopback event wait later times out once, the capture loop exits permanently.
5. The JS layer still receives silence buffers, so the meeting appears alive while interviewer audio is gone.

**Why this fails specifically on Windows:** This is the Windows WASAPI loopback path. The failure modes are tied to render-endpoint initialization and event-driven loopback capture.

**Impact under heavy usage:** Silent transcription loss, wrong STT sample-rate configuration, long sessions with no system audio despite no obvious fatal error, and user-visible trust failure.

**Concrete fix:** Make Windows loopback startup explicit: ready, failed, or retrying. Do not return a fake sample rate. Treat a WASAPI wait timeout as fatal, stop the stream, surface the error to Electron, and perform bounded reinitialization before resuming STT.

### 3. High - Audio ring buffers drop samples silently under load

**Files:** `native-module/src/microphone.rs:193-199`, `native-module/src/microphone.rs:221-228`, `native-module/src/microphone.rs:251-257`, `native-module/src/speaker/windows.rs:233-235`

**Root cause:** `try_push()` and `push_slice()` results are ignored in the real-time callbacks. When producers outrun consumers, data loss is silent.

**Reproduction:**
1. Run a long meeting on Windows 11 under CPU pressure or power-state jitter.
2. Let the renderer, main process, and STT pipelines contend for time.
3. The audio callbacks continue producing samples while the consumer drains too slowly.
4. Buffer writes begin failing or partially failing with no telemetry or recovery.

**Why this fails specifically on Windows:** Windows audio stacks frequently hit short bursts of scheduling jitter during device changes, sleep/wake transitions, Defender scans, and dock/undock activity.

**Impact under heavy usage:** Missing words, clipped speech boundaries, unstable VAD behavior, and harder-to-diagnose transcription quality drops instead of explicit errors.

**Concrete fix:** Check all ring-buffer write results, count drops, emit health telemetry, and add backpressure or stream recovery when drops exceed a threshold. Increase buffer sizing only together with explicit drop accounting.

### 4. High - There is no Windows sleep/resume recovery path, and STT exhaustion is terminal

**Files:** `electron/main.ts:483-495`, `electron/main.ts:3083-3160`, `electron/STTReconnector.ts:31-39`, `electron/STTReconnector.ts:50-76`

**Root cause:** The main process has no Windows `powerMonitor` suspend/resume recovery for meeting audio. `STTReconnector` gives up after five attempts, emits `exhausted`, and I found no production call site that resets it afterward.

**Reproduction:**
1. Start a meeting.
2. Put the machine to sleep or let Windows 11 enter Modern Standby.
3. Resume with changed network or audio device state.
4. Let reconnect attempts fail five times.
5. The speaker remains permanently dead until the meeting is restarted.

**Why this fails specifically on Windows:** Sleep/resume on Windows commonly changes endpoint availability, network readiness, and device identifiers in ways that need explicit recovery.

**Impact under heavy usage:** Meetings that cross suspend/resume or device churn can permanently lose interviewer or user transcription mid-session.

**Concrete fix:** Add `powerMonitor` handlers for suspend, resume, lock, and unlock. Pause audio/STT cleanly before sleep, recreate capture pipelines on resume, and call `STTReconnector.reset(speaker)` after a successful transport or device recovery.

### 5. High - SQLite migration rollback is unsafe for WAL mode on Windows

**Files:** `electron/db/DatabaseManager.ts:109-114`, `electron/db/DatabaseManager.ts:430-491`

**Root cause:** The database runs in WAL mode, but migration backup and restore only copy `natively.db`. They ignore `natively.db-wal` and `natively.db-shm`, and restore writes over the live DB path while the process still holds the connection.

**Reproduction:**
1. Accumulate recent writes so data still lives in the WAL file.
2. Trigger the v10 migration path or a migration failure that calls `restoreMigrationBackup()`.
3. The restore copies only the main DB file and does so while the connection is open.

**Why this fails specifically on Windows:** NTFS file-locking and WAL sidecar behavior make raw file replacement riskier than on a cooperative Unix-like setup.

**Impact under heavy usage:** Lost recent meeting writes, startup migration failures, stale rollback state, and corrupted or inconsistent persistence after failed upgrades.

**Concrete fix:** Before backup or restore, checkpoint WAL and close the active connection. Back up the DB, WAL, and SHM as a unit, or use SQLite's backup API or `VACUUM INTO` through a separate connection instead of `copyFileSync`.

### 6. High - Meeting checkpointing rewrites the full meeting synchronously on the Electron main thread

**Files:** `electron/MeetingCheckpointer.ts:16-27`, `electron/MeetingCheckpointer.ts:47-91`, `electron/db/DatabaseManager.ts:677-771`

**Root cause:** Every checkpoint deletes and reinserts all transcript and interaction rows inside a synchronous `better-sqlite3` transaction, and checkpointing runs from the main process every 60 seconds.

**Reproduction:**
1. Run a long meeting with growing transcript and usage history.
2. Let checkpoints continue every minute.
3. Each checkpoint performs a larger synchronous rewrite on the main thread.

**Why this fails specifically on Windows:** NTFS and Defender-related latency spikes make synchronous file-backed DB work more visible in Electron's main thread than in ideal conditions.

**Impact under heavy usage:** Increasing UI stalls, more WAL churn, slower background work, and a higher chance that meeting control actions lag or miss deadlines.

**Concrete fix:** Store incremental checkpoints only. Append new transcript and interaction rows instead of delete-and-reinsert. Move persistence work off the main thread or serialize it through a dedicated worker process.

### 7. High - Windows monitoring detection can false-positive on ordinary browser usage and hard-quit the app

**Files:** `electron/stealth/MonitoringDetector.ts:125-138`, `electron/stealth/MonitoringDetector.ts:168-186`, `electron/stealth/signatures/monitoring-software.json:36-55`, `electron/stealth/signatures/monitoring-software.json:200-220`, `electron/stealth/StealthManager.ts:1310-1343`

**Root cause:** The Windows signatures treat `chrome.exe`, `msedge.exe`, and generic browser-profile directories as high-confidence proctoring signals for tools like Proctorio, Honorlock, HackerRank, and CoderPad. `StealthManager` quits the app when any detection fires.

**Reproduction:**
1. Enable the capture detection watchdog.
2. Run Chrome or Edge normally on Windows 11.
3. If the signature set matches the browser process and common user-data paths, `pollMonitoringThreats()` calls `quitApplication()`.

**Why this fails specifically on Windows:** These Windows signatures explicitly include generic Windows browser executables and paths.

**Impact under heavy usage:** Unexpected self-termination during normal work, especially in browser-heavy environments.

**Concrete fix:** Remove generic browser executables and generic profile directories from high-confidence Windows signatures. Require extension-specific artifacts plus corroborating window title, registry key, or another independent signal before quitting.

### 8. High - Windows screen-share detection treats app presence as active sharing

**Files:** `electron/stealth/ScreenShareDetector.ts:74-118`, `electron/stealth/signatures/screen-share-apps.json:1-53`, `electron/stealth/StealthManager.ts:969-1004`

**Root cause:** For Windows, the detector declares active screen sharing from process presence alone for apps like Zoom, Teams, Slack, Discord, OBS, and others. The watchdog response is to hide and restore visible windows.

**Reproduction:**
1. Enable the capture detection watchdog.
2. Launch Teams, Zoom, Slack, Discord, or OBS without actually sharing your screen.
3. `detectByProcess()` marks sharing active and `pollCaptureTools()` triggers suppression.

**Why this fails specifically on Windows:** The Windows path relies on `tasklist` process presence, not share-state confirmation.

**Impact under heavy usage:** Window flicker, focus disruption, and false capture suppression during ordinary meetings or when collaboration tools are merely open.

**Concrete fix:** On Windows, require share-state evidence such as share-specific window titles, native APIs, or explicit capture-session confirmation. Do not treat bare process presence as an active screen-share signal.

### 9. High - Windows screenshot features are functionally wrong for selective capture and multi-monitor use

**Files:** `electron/ScreenshotHelper.ts:104-107`, `electron/ScreenshotHelper.ts:152-228`

**Root cause:** The Windows PowerShell path always captures `PrimaryScreen`, and the `interactive` flag is ignored. `takeSelectiveScreenshot()` therefore still performs a full primary-monitor capture.

**Reproduction:**
1. Use selective screenshot on Windows 11.
2. The helper still calls the same primary-screen PowerShell capture path.
3. On a multi-monitor setup, screenshots always come from monitor 1.

**Why this fails specifically on Windows:** The Windows implementation is a custom PowerShell fallback that hardcodes `System.Windows.Forms.Screen]::PrimaryScreen`.

**Impact under heavy usage:** Wrong captures, privacy mistakes, broken selective-capture UX, and unusable workflows on multi-monitor desks.

**Concrete fix:** Split Windows full-screen and selective capture into separate implementations. Use a region-selection overlay or desktop duplication for selective mode, and support either virtual desktop capture or the display nearest the active window.

### 10. Medium - Window sizing and placement assume the primary display

**Files:** `electron/WindowHelper.ts:132-177`, `electron/WindowHelper.ts:197-213`, `electron/WindowHelper.ts:505-525`

**Root cause:** Resizing, creation, and overlay recentering all rely on `screen.getPrimaryDisplay()` instead of the display that currently owns the window.

**Reproduction:**
1. Run the app on a multi-monitor Windows 11 setup.
2. Move the launcher or overlay to a secondary display.
3. Resize the window or switch into overlay mode.
4. Bounds are clamped and recentered against the primary display work area.

**Why this fails specifically on Windows:** Multi-monitor desktop setups are common on Windows, and the code never uses `getDisplayMatching` or `getDisplayNearestPoint`.

**Impact under heavy usage:** Windows appear on the wrong monitor, jump unexpectedly, or clamp to the wrong work area.

**Concrete fix:** Resolve the active display from the current window bounds and apply work-area calculations against that display instead of the primary display.

### 11. High - The main overlay rerenders on every token and transcript chunk

**Files:** `src/components/NativelyInterface.tsx:293-301`, `src/components/NativelyInterface.tsx:461-512`, `src/components/NativelyInterface.tsx:540-739`, `src/components/NativelyInterface.tsx:893-1027`, `src/hooks/useStreamBuffer.ts:1-59`

**Root cause:** `NativelyInterface` updates top-level React state for partial transcripts, rolling transcript content, and multiple stream token handlers on every chunk. Unlike the chat overlays, it does not consistently use the existing RAF batching helper.

**Reproduction:**
1. Run a meeting with continuous interviewer speech.
2. Trigger long streamed answers or multiple assist operations.
3. The top-level overlay component rerenders for every partial transcript and token append.

**Why this fails specifically on Windows:** Combined with the Windows offscreen shell path, excessive renderer churn becomes more expensive because every repaint already has a high transport cost.

**Impact under heavy usage:** Input lag, resize jitter, scroll lag, and visible responsiveness problems during long or active sessions.

**Concrete fix:** Move rolling transcript and streaming message state into isolated memoized subcomponents and use `useStreamBuffer()` or equivalent RAF batching for every token-based stream.

### 12. High - Stream IPC contracts are not request-scoped, and `MeetingChatOverlay` leaks active listeners

**Files:** `src/types/electron.d.ts:157-160`, `src/types/electron.d.ts:232-234`, `electron/ipcHandlers.ts:278-295`, `electron/ipc/registerRagHandlers.ts:44-126`, `src/components/MeetingChatOverlay.tsx:217-241`, `src/components/MeetingChatOverlay.tsx:295-480`, `src/components/GlobalChatOverlay.tsx:167-183`, `src/components/GlobalChatOverlay.tsx:232-367`, `src/components/NativelyInterface.tsx:893-1027`

**Root cause:** Gemini stream events carry no request identity at all. RAG stream events do include meeting/global metadata, but some consumers ignore it. `MeetingChatOverlay` installs stream listeners per request and only cleans them up on normal completion or error, not on close or superseded requests.

**Reproduction:**
1. Open a meeting chat or trigger a stream in the main overlay.
2. Close the overlay mid-stream or start another query before the prior one completes.
3. The old listeners remain active until the stream finishes.
4. Any component listening to the same global stream channel in the same window can consume unrelated events.

**Why this fails specifically on Windows:** It is platform-agnostic in logic, but the impact is worse on Windows here because the renderer and IPC paths are already heavier and more timing-sensitive.

**Impact under heavy usage:** Stale UI updates, duplicate handlers, cross-talk between features, and progressively more erratic chat behavior over long sessions.

**Concrete fix:** Add request IDs to every stream contract, enforce request scoping in preload and renderer consumers, and give `MeetingChatOverlay` the same active-request cleanup pattern already used in `GlobalChatOverlay`.

### 13. Medium - Windows stealth verification and monitoring are hidden behind unrelated feature gates

**Files:** `electron/config/optimizations.ts:37-110`, `electron/services/SettingsManager.ts:102-104`, `electron/main.ts:394-396`, `electron/stealth/StealthManager.ts:473-475`, `electron/stealth/StealthManager.ts:923-937`, `electron/stealth/StealthManager.ts:1310-1316`

**Root cause:** `isOptimizationActive()` requires `accelerationEnabled=true`. On a fresh install, acceleration defaults to `false`. Some Windows stealth verification and monitoring paths use `isEnhancedStealthEnabled()` as a prerequisite, so they do not run even if undetectable mode is enabled.

**Reproduction:**
1. Fresh install with default settings.
2. Turn on undetectable mode without enabling acceleration mode.
3. Native window stealth still applies, but watchdog-gated Windows verification and monitoring paths remain disabled.

**Why this fails specifically on Windows:** The affected code paths include Windows affinity verification and Windows monitoring loops.

**Impact under heavy usage:** Hidden behavior differences between standard and acceleration-enabled installs, inconsistent stealth verification, and harder support/debugging.

**Concrete fix:** Decouple Windows reliability and stealth verification behavior from the acceleration master switch. Gate them on explicit stealth settings, not on the optimization bundle.

### 14. Medium - Shutdown and recovery still assume the app will restart cleanly

**Files:** `electron/MeetingPersistence.ts:51-68`, `electron/MeetingPersistence.ts:75-127`, `electron/MeetingPersistence.ts:200-229`, `electron/MeetingPersistence.ts:236-284`, `electron/main.ts:3083-3085`, `electron/main.ts:3120-3160`

**Root cause:** Recovery of unprocessed meetings only runs at startup. On quit, the app waits up to 10 seconds for pending saves and then forces `app.exit()`. There is no durable resumable job record for the LLM post-processing stage beyond the placeholder meeting row.

**Reproduction:**
1. End a long meeting so summarization begins.
2. Restart or log off Windows before the background save completes.
3. If the app is later kept alive in the tray for long periods, there is no periodic self-healing sweep.

**Why this fails specifically on Windows:** Windows logoff, restart, and update flows frequently terminate apps during shutdown windows and later restore them into long-lived tray sessions.

**Impact under heavy usage:** Meetings remain stuck in processing until restart, and repeated shutdown interruptions can build a backlog of unresolved work.

**Concrete fix:** Persist a durable raw snapshot before any LLM work starts, make summarization resumable, add a periodic stale-job recovery sweep, and prefer graceful quit completion over `app.exit()` once durable state is secured.

## Claims I Could Not Verify From Code Alone

- Actual CPU, GPU, and memory cost of the Windows offscreen shell path on target hardware.
- Real WASAPI behavior across Bluetooth headsets, USB docks, and driver restarts.
- Whether `safeStorage` or DPAPI fails in the intended Windows deployment environments often enough to be operationally relevant.
- Whether production packaging always ships a working Windows `sqlite-vec` load path.
- The real rate of render paints and token events in production sessions.

## Runtime Testing And Profiling Still Required

1. Eight-hour soak test on Windows 11 with live transcription, long streamed answers, and periodic screenshots.
2. Sleep, hibernate, lock, unlock, and resume while a meeting is active.
3. Audio hotplug testing: Bluetooth disconnect, USB headset removal, default speaker change, and driver reset.
4. Multi-monitor testing for launcher placement, overlay placement, and screenshot correctness.
5. ETW or equivalent profiling for Electron main thread, renderer thread, memory growth, and native audio threads.
6. Shutdown testing during active checkpointing and during meeting post-processing.
7. Watchdog-enabled testing with common browsers and collaboration apps open but not actively sharing.

## Why This Is Not Production-Grade Yet

- Windows standard mode is still coupled to the expensive offscreen shell architecture.
- Core audio failure modes can degrade into silence instead of explicit failure.
- Persistence work scales with transcript size and runs synchronously on the main process.
- Recovery is still restart-dependent for some important failure classes.
- Watchdog-based stealth protections can disrupt or terminate ordinary Windows sessions.

## Implementation Order

### Phase 1

- [x] Remove unconditional Windows `StealthRuntime` usage for standard mode.
- [x] Make Windows loopback startup explicit and fail-fast instead of falling back to fake sample rates.
- [x] Surface Windows audio-loop fatal errors to Electron and add bounded auto-restart.
- [x] Add explicit drop accounting for microphone and system-audio ring buffers.
- [x] Add Windows sleep/resume recovery for active meetings and reset exhausted STT reconnectors.

### Phase 2

- [x] Replace raw DB-file migration backup/restore with WAL-safe SQLite backup logic.
- [x] Convert checkpointing to incremental writes off the main thread.
- [x] Make meeting post-processing resumable and add periodic stale-job recovery.
- [x] Fix Windows screenshot capture so selective and multi-monitor paths are real.
- [x] Use display-aware placement instead of `getPrimaryDisplay()` for active windows.

### Phase 3

- [x] Remove generic browser/process signatures from Windows monitoring detection.
- [x] Require share-state confirmation before suppressing windows for screen-share detection.
- [x] Scope all stream IPC events by request ID and clean up listeners on close or supersede.
- [x] Batch `NativelyInterface` transcript and token updates with RAF-throttled state.
- [x] Decouple Windows stealth verification from the acceleration master flag.

## Verification Status

- [x] `npm run test:electron`
- [x] `cargo test --manifest-path native-module/Cargo.toml`
- [ ] Runtime soak, profiling, and Windows device/power-state validation still required
