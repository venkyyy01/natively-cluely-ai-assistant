# Stealth Validation Manual

Manual validation steps for confirming Natively's stealth hardening against proctoring systems. Run these checks on both macOS 14.x and macOS 15.x before each release.

---

## General Validation Checklist

Run these checks before testing any specific proctoring system:

- [ ] Stealth mode is enabled (`getUndetectable()` returns `true`)
- [ ] Native module loaded successfully (no `native_module_unavailable` warning)
- [ ] SCK exclusion verified (no `sck_exclusion_unverified` warning in logs)
- [ ] CGEventTap installed (no `event_tap_permission_denied` warning)
- [ ] Window does NOT appear in `screencapture -l` output
- [ ] Window does NOT appear in macOS Mission Control (swipe up with three fingers)
- [ ] Window does NOT appear in App Switcher (Cmd+Tab)
- [ ] Window does NOT appear in OBS Studio (ScreenCaptureKit source)
- [ ] Window does NOT appear in Zoom screen-share picker
- [ ] Registered stealth shortcuts do NOT fire `keydown` events in a browser DevTools console listener
- [ ] After sleep/wake cycle, all checks above still pass

---

## HackerRank

**Proctoring method:** Browser-based proctoring with screen sharing detection via `getDisplayMedia`.

### Setup Steps

1. Open a HackerRank test environment (use a practice test or sandbox account).
2. Accept the proctoring prompt that requests screen sharing permission.
3. Select "Entire Screen" when Chrome's `getDisplayMedia` picker appears.
4. Ensure Natively is running with stealth mode enabled.

### What to Verify

| Check | Method | Pass Criteria |
|-------|--------|---------------|
| Window invisibility | Inspect the shared screen feed in HackerRank's proctoring preview | No Natively window pixels visible |
| Enumeration invisibility | Open Chrome DevTools → Console → run `navigator.mediaDevices.getDisplayMedia({video: true})` and inspect available sources | Natively window not listed as a capture source |
| Shortcut invisibility | Add `document.addEventListener('keydown', e => console.log(e.key, e.code))` in DevTools, press stealth shortcuts | No keydown events logged for stealth shortcuts |
| No detection alerts | Complete a short test section | No "suspicious activity" or "another application detected" alerts |

### Expected Results

- HackerRank's screen recording shows only the browser and desktop — no Natively overlay.
- No proctoring violation flags triggered during the test session.
- Stealth shortcuts (e.g., Cmd+Shift+S for screenshot) work without leaking to the page.

### Known Limitations

- HackerRank may update their proctoring SDK without notice; re-validate after major HackerRank platform updates.
- If the user selects "Window" instead of "Entire Screen" in the share picker, only the browser is shared regardless of stealth — this is not a valid test of SCK exclusion.
- Tab-switching detection (focus/blur events) is separate from screen capture; Natively does not prevent `visibilitychange` events on the proctored tab.

---

## CodeSignal

**Proctoring method:** Browser-based proctoring with tab/window detection and periodic screen capture.

### Setup Steps

1. Open a CodeSignal assessment (use a practice assessment or demo environment).
2. Accept the proctoring terms and grant screen recording permission when prompted.
3. Ensure Natively is running with stealth mode enabled.
4. Keep the CodeSignal tab focused as the primary workspace.

### What to Verify

| Check | Method | Pass Criteria |
|-------|--------|---------------|
| Window invisibility | Review CodeSignal's proctoring feed (if accessible) or use a secondary screen recording to compare | No Natively window visible in captured frames |
| Tab detection bypass | Switch focus briefly to Natively, then return to CodeSignal | Verify whether CodeSignal flags a tab switch (note: this tests focus detection, not SCK) |
| Shortcut invisibility | In CodeSignal's editor, press stealth shortcuts | No unexpected characters inserted, no keydown events in their monitoring |
| Capture enumeration | Before starting the test, check `screencapture -l` from Terminal | Natively windows absent from the list |

### Expected Results

- CodeSignal's periodic screen captures do not contain Natively window content.
- No "cheating detected" or "window switch" alerts related to Natively's window presence.
- Stealth shortcuts function without interfering with CodeSignal's code editor.

### Known Limitations

- CodeSignal detects tab focus changes via `document.visibilitychange` — this is expected behavior and not related to SCK stealth. Users should use Natively's overlay mode rather than switching windows.
- CodeSignal's clipboard monitoring may detect paste operations from Natively; this is outside the scope of SCK stealth hardening.
- Some CodeSignal assessments use a lockdown browser extension that may have additional detection vectors.

---

## ProctorU

**Proctoring method:** Desktop agent that monitors running processes, screen capture, and webcam feed.

### Setup Steps

1. Install the ProctorU Guardian Browser or desktop agent as required for the exam.
2. Launch the ProctorU session and complete the system check.
3. Ensure Natively is running with stealth mode enabled BEFORE starting the ProctorU session.
4. Complete the room scan and identity verification.

### What to Verify

| Check | Method | Pass Criteria |
|-------|--------|---------------|
| Process invisibility | During the ProctorU system check, observe whether Natively is flagged as a running application | Natively not listed in flagged processes |
| Window invisibility | ProctorU captures the full screen — verify via the proctor's shared view (if available) or a parallel recording | No Natively window visible |
| Shortcut invisibility | Press stealth shortcuts while ProctorU is monitoring | No alerts about unauthorized keyboard activity |
| Screen capture exclusion | ProctorU takes periodic screenshots — verify these do not contain Natively content | Clean screenshots without Natively pixels |

### Expected Results

- ProctorU's process list does not flag Natively as a suspicious application.
- Screen captures taken by the ProctorU agent show only the exam browser and desktop.
- No proctor intervention or automated flags related to Natively.

### Known Limitations

- ProctorU's desktop agent has deeper system access than browser-based proctors. It may enumerate processes via `ps` or Activity Monitor APIs — process-level hiding is NOT part of SCK stealth hardening.
- If Natively's process name appears in the process list, ProctorU's human proctor may flag it. Process renaming/hiding is a separate concern.
- ProctorU may use `CGWindowListCopyWindowInfo` directly rather than SCK — verify that `filterDisplayList()` confirms Natively windows are excluded from this API as well.
- Webcam-based monitoring (eye tracking, head movement) is unrelated to stealth hardening.

---

## Karat

**Proctoring method:** Browser-based proctoring with screen recording via `getDisplayMedia`.

### Setup Steps

1. Join a Karat interview session (use a mock interview or practice session if available).
2. Accept the screen sharing prompt when the Karat platform requests it.
3. Select "Entire Screen" in the browser's screen share picker.
4. Ensure Natively is running with stealth mode enabled.

### What to Verify

| Check | Method | Pass Criteria |
|-------|--------|---------------|
| Window invisibility | The Karat interviewer sees your shared screen — verify via a test call or self-review recording | No Natively window visible in the shared feed |
| Recording invisibility | After the session, review the recorded video (if accessible) | No Natively content in any frame |
| Shortcut invisibility | Press stealth shortcuts during the interview | No unexpected behavior in the Karat code editor, no keydown artifacts |
| Share picker exclusion | When selecting what to share, check the window list in Chrome's picker | Natively window not listed as a shareable window |

### Expected Results

- Karat's screen recording contains only the interview browser tab and desktop.
- The Karat interviewer (human or AI) does not observe any overlay or secondary application.
- Stealth shortcuts work without disrupting the collaborative code editor.

### Known Limitations

- Karat interviews are conducted by human interviewers who can see your screen in real-time. Any visual glitch during stealth reapplication (e.g., after wake from sleep) could be noticed.
- Karat uses standard `getDisplayMedia` — if Chrome's implementation changes how it queries SCK, re-validate.
- Audio sharing (if enabled) is unrelated to visual stealth.

---

## Validation Matrix Summary

| System | Detection Method | Primary Defense | Fallback |
|--------|-----------------|-----------------|----------|
| HackerRank | `getDisplayMedia` + screen share | SCK exclusion (`CGSSetWindowTags`) | Layer 0 (`setContentProtection`) |
| CodeSignal | `getDisplayMedia` + tab detection | SCK exclusion + overlay mode | Layer 0 |
| ProctorU | Desktop agent + process list + screen capture | SCK exclusion + `filterDisplayList` | Layer 0 (process hiding out of scope) |
| Karat | `getDisplayMedia` + screen recording | SCK exclusion | Layer 0 |

## When to Re-Validate

- After any macOS major or minor version update
- After updating Electron to a new major version
- After changes to `StealthManager`, `stealth.rs`, or `stealth_keys.rs`
- After any proctoring platform reports a detection event
- Before each production release that touches stealth code
