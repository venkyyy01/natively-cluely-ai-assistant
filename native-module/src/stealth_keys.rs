//! Stealth keyboard monitor using CGEventTap.
//!
//! Unlike Electron's `globalShortcut.register()` which uses `RegisterEventHotKey`
//! (visible to any app with Accessibility permissions), CGEventTap operates as a
//! passive observer that cannot be enumerated by other processes.
//!
//! Proctoring software (HackerRank, CodeSignal, ProctorU, Karat) can detect:
//! - Registered global hotkeys via Carbon Event Manager inspection
//! - IOHIDManager key monitors
//! - Accessibility API observers
//!
//! CGEventTap at kCGAnnotatedSessionEventTap is NOT enumerable by other processes.
//! It requires Accessibility permission but does not register a visible hotkey.
//!
//! ## Dual-Binding Mode
//!
//! When `dual_binding_mode` is enabled, the CGEventTap operates as an **active** tap
//! that suppresses matched key events (returns NULL from the callback). This prevents
//! the keystroke from propagating to the focused application or to Electron's
//! `globalShortcut` handler. This is critical for stealth: it ensures that shortcut
//! keystrokes never reach a proctored browser window.
//!
//! When `dual_binding_mode` is disabled (default), the tap operates passively — it
//! observes and notifies via callback but does not suppress events. In this mode,
//! Electron's `globalShortcut` can coexist and handle the same shortcuts as a fallback.

use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ErrorStrategy, ThreadsafeFunction, ThreadsafeFunctionCallMode};
use serde::Deserialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

/// A single shortcut entry from the TypeScript layer's keybind configuration.
///
/// The JSON format expected from the TypeScript layer is:
/// ```json
/// [{"actionId": "general:take-screenshot", "keycode": 1, "modifiers": 1048576}]
/// ```
/// where `keycode` is the macOS virtual key code and `modifiers` is the
/// CGEventFlags bitmask (e.g., Command = 1<<20 = 1048576).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutEntry {
    /// The action identifier (e.g., "general:take-screenshot")
    pub action_id: String,
    /// The macOS virtual key code (CGKeyCode)
    pub keycode: u16,
    /// The modifier flags bitmask (CGEventFlags)
    pub modifiers: u64,
}

/// Shared shortcut configuration that can be updated from the TypeScript layer
/// and read by the CGEventTap callback thread.
type ShortcutConfig = Arc<Mutex<Vec<ShortcutEntry>>>;

#[cfg(target_os = "macos")]
mod macos_tap {
    use super::*;
    use std::os::raw::c_void;
    use std::ptr;
    use std::sync::mpsc;
    use std::thread;
    use std::time::Duration;

    // CGEvent types and functions from CoreGraphics
    type CGEventTapLocation = u32;
    type CGEventTapPlacement = u32;
    type CGEventTapOptions = u32;
    type CGEventMask = u64;
    type CGEventType = u32;
    type CGEventFlags = u64;
    type CGKeyCode = u16;

    const K_CG_SESSION_EVENT_TAP: CGEventTapLocation = 1; // kCGSessionEventTap
    const K_CG_HEAD_INSERT_EVENT_TAP: CGEventTapPlacement = 0;
    const K_CG_EVENT_TAP_OPTION_DEFAULT: CGEventTapOptions = 0; // active tap, can modify/suppress events
    #[allow(dead_code)]
    const K_CG_EVENT_TAP_OPTION_LISTEN_ONLY: CGEventTapOptions = 1; // passive, no modification
    const K_CG_EVENT_KEY_DOWN: CGEventType = 10;
    const K_CG_EVENT_FLAGS_CHANGED: CGEventType = 12;

    // Modifier flags
    const K_CG_EVENT_FLAG_MASK_COMMAND: CGEventFlags = 1 << 20;
    const K_CG_EVENT_FLAG_MASK_SHIFT: CGEventFlags = 1 << 17;
    const K_CG_EVENT_FLAG_MASK_ALTERNATE: CGEventFlags = 1 << 19;
    const K_CG_EVENT_FLAG_MASK_CONTROL: CGEventFlags = 1 << 18;

    // Key codes (virtual key codes on macOS)
    const K_VK_RETURN: CGKeyCode = 36; // Enter/Return
    const K_VK_S: CGKeyCode = 1;       // S
    #[allow(dead_code)]
    const K_VK_B: CGKeyCode = 11;      // B (reserved for future use)
    const K_VK_H: CGKeyCode = 4;       // H
    const K_VK_M: CGKeyCode = 46;      // M
    const K_VK_V: CGKeyCode = 9;       // V
    const K_VK_A: CGKeyCode = 0;       // A
    const K_VK_X: CGKeyCode = 7;       // X
    const K_VK_ESCAPE: CGKeyCode = 53; // Escape
    const K_VK_SLASH: CGKeyCode = 44;  // / (Cmd+Shift+/ produces "?" on US layouts)

    #[repr(C)]
    struct __CGEvent(c_void);
    type CGEventRef = *mut __CGEvent;

    #[repr(C)]
    struct __CFMachPort(c_void);
    type CFMachPortRef = *mut __CFMachPort;

    #[repr(C)]
    struct __CFRunLoop(c_void);
    type CFRunLoopRef = *mut __CFRunLoop;

    #[repr(C)]
    struct __CFRunLoopSource(c_void);
    type CFRunLoopSourceRef = *mut __CFRunLoopSource;

    type CGEventTapCallBack = unsafe extern "C" fn(
        proxy: *mut c_void,
        event_type: CGEventType,
        event: CGEventRef,
        user_info: *mut c_void,
    ) -> CGEventRef;

    extern "C" {
        fn CGEventTapCreate(
            tap: CGEventTapLocation,
            place: CGEventTapPlacement,
            options: CGEventTapOptions,
            events_of_interest: CGEventMask,
            callback: CGEventTapCallBack,
            user_info: *mut c_void,
        ) -> CFMachPortRef;

        fn CGEventGetFlags(event: CGEventRef) -> CGEventFlags;
        fn CGEventGetIntegerValueField(event: CGEventRef, field: u32) -> i64;
        fn CFMachPortCreateRunLoopSource(
            allocator: *const c_void,
            port: CFMachPortRef,
            order: i64,
        ) -> CFRunLoopSourceRef;
        fn CFRunLoopGetCurrent() -> CFRunLoopRef;
        fn CFRunLoopAddSource(rl: CFRunLoopRef, source: CFRunLoopSourceRef, mode: *const c_void);
        fn CFRunLoopRunInMode(mode: *const c_void, seconds: f64, return_after_source_handled: u8) -> i32;
        fn CFMachPortInvalidate(port: CFMachPortRef);
        fn CFRelease(cf: *const c_void);
        fn CGEventTapEnable(tap: CFMachPortRef, enable: bool);
    }

    // kCGKeyboardEventKeycode field
    const K_CG_KEYBOARD_EVENT_KEYCODE: u32 = 9;

    // CFRunLoopMode
    extern "C" {
        static kCFRunLoopDefaultMode: *const c_void;
    }

    /// Represents a matched shortcut action
    #[derive(Debug, Clone, PartialEq)]
    pub(crate) enum StealthAction {
        TakeScreenshot,       // Cmd+Shift+S or Cmd+Alt+Shift+S
        ProcessScreenshots,   // Cmd+Enter
        ToggleVisibility,     // Cmd+Alt+Shift+V
        EmergencyHide,        // Cmd+Shift+H or Cmd+Shift+X
        ToggleClickthrough,   // Cmd+Shift+M
        SelectiveScreenshot,  // Cmd+Alt+Shift+A
        RestoreFullStealth,   // Shift+Esc
    }

    impl StealthAction {
        pub(crate) fn as_str(&self) -> &'static str {
            match self {
                Self::TakeScreenshot => "general:take-screenshot",
                Self::ProcessScreenshots => "general:process-screenshots",
                Self::ToggleVisibility => "general:toggle-visibility",
                Self::EmergencyHide => "general:emergency-hide",
                Self::ToggleClickthrough => "general:toggle-clickthrough",
                Self::SelectiveScreenshot => "general:selective-screenshot",
                Self::RestoreFullStealth => "general:restore-full-stealth",
            }
        }
    }

    /// Match a key event against our stealth shortcuts
    fn match_shortcut(keycode: CGKeyCode, flags: CGEventFlags) -> Option<StealthAction> {
        let cmd = flags & K_CG_EVENT_FLAG_MASK_COMMAND != 0;
        let shift = flags & K_CG_EVENT_FLAG_MASK_SHIFT != 0;
        let alt = flags & K_CG_EVENT_FLAG_MASK_ALTERNATE != 0;
        let _ctrl = flags & K_CG_EVENT_FLAG_MASK_CONTROL != 0;

        match (cmd, shift, alt, keycode) {
            // Cmd+Enter — Process Screenshots
            (true, false, false, K_VK_RETURN) => Some(StealthAction::ProcessScreenshots),
            // Cmd+Shift+Enter — also Process Screenshots (alternate)
            (true, true, false, K_VK_RETURN) => Some(StealthAction::ProcessScreenshots),

            // Cmd+Shift+S — Take Screenshot
            (true, true, false, K_VK_S) => Some(StealthAction::TakeScreenshot),
            // Cmd+Alt+Shift+S — Take Screenshot (primary)
            (true, true, true, K_VK_S) => Some(StealthAction::TakeScreenshot),

            // Cmd+Alt+Shift+V — Toggle Visibility
            (true, true, true, K_VK_V) => Some(StealthAction::ToggleVisibility),

            // Cmd+Shift+H — Emergency Hide
            (true, true, false, K_VK_H) => Some(StealthAction::EmergencyHide),
            // Cmd+Shift+X — Emergency Hide (alternate)
            (true, true, false, K_VK_X) => Some(StealthAction::EmergencyHide),

            // Cmd+Shift+M — Toggle Clickthrough
            (true, true, false, K_VK_M) => Some(StealthAction::ToggleClickthrough),
            // Cmd+Shift+/ ("?") — Toggle Clickthrough (alternate, comparable
            // stealth to Cmd+Shift+S — handled by the same CGEventTap path).
            (true, true, false, K_VK_SLASH) => Some(StealthAction::ToggleClickthrough),

            // Cmd+Alt+Shift+A — Selective Screenshot
            (true, true, true, K_VK_A) => Some(StealthAction::SelectiveScreenshot),

            // Shift+Esc — Restore Full Stealth
            (false, true, false, K_VK_ESCAPE) => Some(StealthAction::RestoreFullStealth),

            _ => None,
        }
    }

    /// Context passed to the CGEventTap callback via user_info pointer.
    ///
    /// `dual_binding_mode` controls whether matched events are suppressed:
    /// - `true`: the tap swallows matched key events (returns NULL), preventing them
    ///   from reaching the active app or Electron's globalShortcut.
    /// - `false`: the tap passes all events through unchanged (listen-only behavior).
    struct TapContext {
        callback: ThreadsafeFunction<String, ErrorStrategy::CalleeHandled>,
        stop_signal: Arc<AtomicBool>,
        dual_binding_mode: Arc<AtomicBool>,
        shortcut_config: ShortcutConfig,
    }

    /// Check if a key event matches any entry in the dynamic shortcut config.
    ///
    /// Returns the action_id if a match is found, None otherwise.
    /// The matching compares keycode exactly and checks that all specified
    /// modifier flags are present in the event flags.
    pub(crate) fn match_dynamic_config(
        keycode: CGKeyCode,
        flags: CGEventFlags,
        config: &[ShortcutEntry],
    ) -> Option<String> {
        // Mask out device-dependent bits — only compare modifier key flags.
        // CGEventFlags includes device-specific bits in the lower 16 bits;
        // we only care about the modifier mask portion (bits 16+).
        let modifier_mask: CGEventFlags = K_CG_EVENT_FLAG_MASK_COMMAND
            | K_CG_EVENT_FLAG_MASK_SHIFT
            | K_CG_EVENT_FLAG_MASK_ALTERNATE
            | K_CG_EVENT_FLAG_MASK_CONTROL;
        let event_modifiers = flags & modifier_mask;

        for entry in config {
            let entry_modifiers = entry.modifiers & modifier_mask;
            if entry.keycode == keycode && entry_modifiers == event_modifiers {
                return Some(entry.action_id.clone());
            }
        }
        None
    }

    /// CGEventTap callback function.
    ///
    /// When dual-binding mode is active and a shortcut matches, returns NULL to
    /// suppress the event. Otherwise, returns the event unchanged.
    ///
    /// Matching priority:
    /// 1. Dynamic shortcut config (from TypeScript layer via `updateShortcutConfig`)
    /// 2. Hardcoded defaults (via `match_shortcut`)
    unsafe extern "C" fn tap_callback(
        _proxy: *mut c_void,
        event_type: CGEventType,
        event: CGEventRef,
        user_info: *mut c_void,
    ) -> CGEventRef {
        if event.is_null() || user_info.is_null() {
            return event;
        }

        // Only process keyDown events
        if event_type != K_CG_EVENT_KEY_DOWN {
            return event;
        }

        let ctx = &*(user_info as *const TapContext);

        if ctx.stop_signal.load(Ordering::Relaxed) {
            return event;
        }

        let keycode = CGEventGetIntegerValueField(event, K_CG_KEYBOARD_EVENT_KEYCODE) as CGKeyCode;
        let flags = CGEventGetFlags(event);

        // Try dynamic config first, then fall back to hardcoded shortcuts
        let matched_action: Option<String> = {
            let config = ctx.shortcut_config.lock().unwrap_or_else(|e| e.into_inner());
            if !config.is_empty() {
                match_dynamic_config(keycode, flags, &config)
            } else {
                None
            }
        }
        .or_else(|| match_shortcut(keycode, flags).map(|a| a.as_str().to_string()));

        if let Some(action_id) = matched_action {
            // Notify the JS callback regardless of suppression mode
            ctx.callback.call(
                Ok(action_id),
                ThreadsafeFunctionCallMode::NonBlocking,
            );

            // In dual-binding mode, suppress the event so it doesn't reach
            // the active application or Electron's globalShortcut handler.
            // This prevents keystroke leakage to proctored browser windows.
            if ctx.dual_binding_mode.load(Ordering::Relaxed) {
                return ptr::null_mut();
            }
        }

        // Pass the event through unchanged
        event
    }

    /// Check whether a given key event (keycode + modifier flags) matches a
    /// registered stealth shortcut and should be suppressed.
    ///
    /// Returns `true` if the event matches a shortcut (i.e., it should be
    /// swallowed at the tap level to prevent keystroke leakage to browsers),
    /// `false` otherwise.
    ///
    /// This is a public API wrapper around `match_shortcut` that can be called
    /// from the TypeScript layer to query suppression status for a specific
    /// key event without requiring the tap to be running.
    pub(crate) fn suppress_key_event(keycode: CGKeyCode, flags: CGEventFlags) -> bool {
        match_shortcut(keycode, flags).is_some()
    }

    /// Start the CGEventTap with dual-binding support.
    ///
    /// The tap is created as an **active** tap (not listen-only) so it has the
    /// capability to suppress events when dual-binding mode is enabled. When
    /// dual-binding mode is disabled, it behaves identically to a listen-only tap
    /// (all events pass through).
    ///
    /// An active tap requires Accessibility permissions on macOS. If permissions
    /// are not granted, this function returns an error rather than crashing, so
    /// the TypeScript layer can fall back to globalShortcut.
    pub(crate) fn start_stealth_tap(
        callback: ThreadsafeFunction<String, ErrorStrategy::CalleeHandled>,
        stop_signal: Arc<AtomicBool>,
        dual_binding_mode: Arc<AtomicBool>,
        shortcut_config: ShortcutConfig,
    ) -> napi::Result<()> {
        let ctx = Box::new(TapContext {
            callback,
            stop_signal: stop_signal.clone(),
            dual_binding_mode,
            shortcut_config,
        });
        let raw_ptr = Box::into_raw(ctx) as usize; // usize is Send
        let stop = stop_signal;

        // Use a channel to communicate tap creation result back to the caller.
        // This allows us to detect permission failures and report them as errors
        // instead of silently failing in the background thread.
        let (tx, rx) = mpsc::channel::<std::result::Result<(), String>>();

        thread::spawn(move || {
            let ctx_ptr = raw_ptr as *mut c_void;
            unsafe {
                // Listen for keyDown and flagsChanged events
                let event_mask: CGEventMask =
                    (1 << K_CG_EVENT_KEY_DOWN) | (1 << K_CG_EVENT_FLAGS_CHANGED);

                // Use active tap (K_CG_EVENT_TAP_OPTION_DEFAULT) to enable event
                // suppression when dual-binding mode is active. When dual-binding
                // is off, the callback simply returns the event unchanged, making
                // it behave like a listen-only tap.
                let tap = CGEventTapCreate(
                    K_CG_SESSION_EVENT_TAP,
                    K_CG_HEAD_INSERT_EVENT_TAP,
                    K_CG_EVENT_TAP_OPTION_DEFAULT, // Active tap: can suppress events
                    event_mask,
                    tap_callback,
                    ctx_ptr,
                );

                if tap.is_null() {
                    eprintln!("[StealthKeys] Failed to create CGEventTap — Accessibility permission required. Grant access in System Settings > Privacy & Security > Accessibility.");
                    let _ = Box::from_raw(ctx_ptr as *mut TapContext);
                    let _ = tx.send(Err(
                        "Failed to create CGEventTap: Accessibility permission is required. \
                         Grant access in System Settings > Privacy & Security > Accessibility."
                            .to_string(),
                    ));
                    return;
                }

                let source = CFMachPortCreateRunLoopSource(std::ptr::null(), tap, 0);
                if source.is_null() {
                    eprintln!("[StealthKeys] Failed to create run loop source");
                    CFMachPortInvalidate(tap);
                    CFRelease(tap as *const c_void);
                    let _ = Box::from_raw(ctx_ptr as *mut TapContext);
                    let _ = tx.send(Err(
                        "Failed to create CFRunLoopSource for CGEventTap.".to_string(),
                    ));
                    return;
                }

                let run_loop = CFRunLoopGetCurrent();
                CFRunLoopAddSource(run_loop, source, kCFRunLoopDefaultMode);
                CGEventTapEnable(tap, true);

                // Signal success — the tap was created and is running.
                let _ = tx.send(Ok(()));

                // Run the event loop until stop signal
                loop {
                    if stop.load(Ordering::Relaxed) {
                        break;
                    }
                    // Run for 100ms at a time, then check stop signal
                    CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.1, 0);
                }

                // Cleanup
                CGEventTapEnable(tap, false);
                CFMachPortInvalidate(tap);
                CFRelease(source as *const c_void);
                CFRelease(tap as *const c_void);
                let _ = Box::from_raw(ctx_ptr as *mut TapContext);
            }
        });

        // Wait briefly for the thread to report whether the tap was created
        // successfully. A 200ms timeout gives the thread enough time to call
        // CGEventTapCreate and send the result.
        match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(Ok(())) => Ok(()),
            Ok(Err(msg)) => Err(napi::Error::from_reason(msg)),
            Err(_) => {
                // Timeout — the thread hasn't reported back yet. This likely means
                // the tap was created successfully (the thread is now in the run loop).
                // Treat as success.
                Ok(())
            }
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod macos_tap {
    use super::*;

    pub(crate) fn suppress_key_event(_keycode: u16, _flags: u64) -> bool {
        // No suppression on non-macOS platforms
        false
    }

    pub(crate) fn match_dynamic_config(
        keycode: u16,
        flags: u64,
        config: &[ShortcutEntry],
    ) -> Option<String> {
        // Modifier mask matching logic (same as macOS implementation)
        let modifier_mask: u64 = (1 << 20) | (1 << 17) | (1 << 19) | (1 << 18);
        let event_modifiers = flags & modifier_mask;

        for entry in config {
            let entry_modifiers = entry.modifiers & modifier_mask;
            if entry.keycode == keycode && entry_modifiers == event_modifiers {
                return Some(entry.action_id.clone());
            }
        }
        None
    }

    pub(crate) fn start_stealth_tap(
        _callback: ThreadsafeFunction<String, ErrorStrategy::CalleeHandled>,
        _stop_signal: Arc<AtomicBool>,
        _dual_binding_mode: Arc<AtomicBool>,
        _shortcut_config: ShortcutConfig,
    ) -> napi::Result<()> {
        // No-op on non-macOS platforms
        Ok(())
    }
}

// ============================================================================
// NAPI exports
// ============================================================================

/// A stealth keyboard monitor that uses CGEventTap instead of globalShortcut.
/// This is invisible to proctoring software that enumerates registered hotkeys.
///
/// ## Dual-Binding Mode
///
/// When dual-binding mode is enabled via `setDualBindingMode(true)`, the tap
/// suppresses matched key events so they never reach the active application or
/// Electron's `globalShortcut`. This allows the CGEventTap to take priority over
/// globalShortcut when both are registered for the same keys.
///
/// When dual-binding mode is disabled (default), the tap passes events through
/// unchanged, allowing Electron's `globalShortcut` to also handle them as a
/// fallback mechanism.
#[napi]
pub struct StealthKeyMonitor {
    stop_signal: Arc<AtomicBool>,
    dual_binding_mode: Arc<AtomicBool>,
    shortcut_config: ShortcutConfig,
    started: bool,
}

#[napi]
impl StealthKeyMonitor {
    #[napi(constructor)]
    pub fn new() -> Self {
        StealthKeyMonitor {
            stop_signal: Arc::new(AtomicBool::new(false)),
            dual_binding_mode: Arc::new(AtomicBool::new(false)),
            shortcut_config: Arc::new(Mutex::new(Vec::new())),
            started: false,
        }
    }

    /// Start the stealth key monitor. The callback receives action IDs
    /// (e.g. "general:take-screenshot") when matching key combinations are pressed.
    /// Unlike globalShortcut, this cannot be enumerated by other processes.
    ///
    /// By default, dual-binding mode is off — events pass through to the active
    /// application and Electron's globalShortcut. Call `setDualBindingMode(true)`
    /// to suppress matched events at the tap level.
    ///
    /// Returns an error if the CGEventTap cannot be created (e.g., Accessibility
    /// permission not granted). The TypeScript layer should catch this error and
    /// fall back to Electron's `globalShortcut` mechanism.
    #[napi]
    pub fn start(&mut self, callback: JsFunction) -> napi::Result<()> {
        if self.started {
            return Ok(());
        }

        let tsfn: ThreadsafeFunction<String, ErrorStrategy::CalleeHandled> =
            callback.create_threadsafe_function(0, |ctx| Ok(vec![ctx.value]))?;

        self.stop_signal.store(false, Ordering::SeqCst);

        match macos_tap::start_stealth_tap(
            tsfn,
            self.stop_signal.clone(),
            self.dual_binding_mode.clone(),
            self.shortcut_config.clone(),
        ) {
            Ok(()) => {
                self.started = true;
                Ok(())
            }
            Err(e) => {
                // Tap failed to start — ensure started remains false so
                // is_tap_active() correctly reports the tap is not running.
                self.started = false;
                Err(e)
            }
        }
    }

    /// Stop the stealth key monitor.
    #[napi]
    pub fn stop(&mut self) {
        self.stop_signal.store(true, Ordering::SeqCst);
        self.started = false;
    }

    /// Update the shortcut configuration from the TypeScript layer.
    ///
    /// Accepts a JSON string representing an array of shortcut entries:
    /// ```json
    /// [
    ///   {"actionId": "general:take-screenshot", "keycode": 1, "modifiers": 1048576},
    ///   {"actionId": "general:toggle-visibility", "keycode": 9, "modifiers": 1966080}
    /// ]
    /// ```
    ///
    /// Where:
    /// - `actionId`: The action identifier string (e.g., "general:take-screenshot")
    /// - `keycode`: The macOS virtual key code (u16)
    /// - `modifiers`: The CGEventFlags bitmask for modifier keys
    ///   - Command: 1 << 20 = 1048576
    ///   - Shift: 1 << 17 = 131072
    ///   - Alt/Option: 1 << 19 = 524288
    ///   - Control: 1 << 18 = 262144
    ///
    /// The dynamic config takes priority over hardcoded defaults when non-empty.
    /// Pass an empty array `"[]"` to clear the dynamic config and revert to defaults.
    ///
    /// This can be called at any time, including while the tap is running.
    /// The update is atomic — the tap callback will see the new config on its
    /// next key event.
    #[napi]
    pub fn update_shortcut_config(&self, config_json: String) -> napi::Result<()> {
        let entries: Vec<ShortcutEntry> = serde_json::from_str(&config_json).map_err(|e| {
            napi::Error::from_reason(format!("Failed to parse shortcut config JSON: {}", e))
        })?;

        let mut config = self
            .shortcut_config
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        *config = entries;

        Ok(())
    }

    /// Enable or disable dual-binding mode at runtime.
    ///
    /// When enabled (`true`):
    /// - The CGEventTap suppresses matched key events (returns NULL from callback)
    /// - Keystrokes for registered shortcuts never reach the active app or globalShortcut
    /// - The tap takes full priority for shortcut handling
    ///
    /// When disabled (`false`, default):
    /// - The CGEventTap passes all events through unchanged
    /// - Electron's globalShortcut can still handle the same shortcuts as a fallback
    /// - Both the tap callback AND globalShortcut will fire for matched keys
    ///
    /// This can be toggled at any time, even while the tap is running.
    #[napi]
    pub fn set_dual_binding_mode(&self, enabled: bool) {
        self.dual_binding_mode.store(enabled, Ordering::SeqCst);
    }

    /// Query whether dual-binding mode is currently active.
    #[napi]
    pub fn get_dual_binding_mode(&self) -> bool {
        self.dual_binding_mode.load(Ordering::SeqCst)
    }

    /// Health-check: returns whether the CGEventTap is currently active.
    ///
    /// The tap is considered active when:
    /// 1. `start()` has been called (started == true), AND
    /// 2. The stop signal has NOT been set (the tap thread is still running)
    ///
    /// This allows the TypeScript layer to verify the tap is healthy and
    /// decide whether to fall back to globalShortcut.
    #[napi]
    pub fn is_tap_active(&self) -> bool {
        self.started && !self.stop_signal.load(Ordering::SeqCst)
    }
}

/// Check whether a specific key event (keycode + modifier flags) would be
/// suppressed by the stealth tap.
///
/// This is a standalone query function that does not require the tap to be
/// running. It checks if the given keycode and flags match any registered
/// stealth shortcut.
///
/// Returns `true` if the event matches a shortcut and should be suppressed
/// (i.e., swallowed at the tap level before reaching the active application),
/// `false` otherwise.
///
/// Parameters:
/// - `keycode`: Virtual key code (CGKeyCode, u16 on macOS)
/// - `flags`: Modifier flags (CGEventFlags, passed as i64 to accommodate
///   JavaScript number type; internally cast to u64)
///
/// On non-macOS platforms, always returns `false` (no suppression).
#[napi]
pub fn suppress_key_event(keycode: u16, flags: i64) -> bool {
    macos_tap::suppress_key_event(keycode, flags as u64)
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    // Modifier flag constants (CGEventFlags bitmask values)
    const FLAG_COMMAND: u64 = 1 << 20; // 0x100000
    const FLAG_SHIFT: u64 = 1 << 17;   // 0x020000
    const FLAG_ALT: u64 = 1 << 19;     // 0x080000
    #[allow(dead_code)]
    const FLAG_CONTROL: u64 = 1 << 18;  // 0x040000

    // Key codes (macOS virtual key codes)
    const VK_A: u16 = 0;
    const VK_S: u16 = 1;
    const VK_H: u16 = 4;
    const VK_V: u16 = 9;
    const VK_RETURN: u16 = 36;
    const VK_ESCAPE: u16 = 53;

    // ========================================================================
    // Test 1: suppress_key_event returns true for known shortcuts
    // ========================================================================

    #[cfg(target_os = "macos")]
    #[test]
    fn test_suppress_key_event_matches_known_shortcuts() {
        // Cmd+Shift+S = Take Screenshot
        assert!(macos_tap::suppress_key_event(VK_S, FLAG_COMMAND | FLAG_SHIFT));

        // Cmd+Enter = Process Screenshots
        assert!(macos_tap::suppress_key_event(VK_RETURN, FLAG_COMMAND));

        // Cmd+Shift+H = Emergency Hide
        assert!(macos_tap::suppress_key_event(VK_H, FLAG_COMMAND | FLAG_SHIFT));

        // Cmd+Alt+Shift+V = Toggle Visibility
        assert!(macos_tap::suppress_key_event(VK_V, FLAG_COMMAND | FLAG_SHIFT | FLAG_ALT));

        // Shift+Esc = Restore Full Stealth
        assert!(macos_tap::suppress_key_event(VK_ESCAPE, FLAG_SHIFT));
    }

    // ========================================================================
    // Test 2: suppress_key_event returns false for non-shortcut keys
    // ========================================================================

    #[test]
    fn test_suppress_key_event_rejects_non_shortcut_keys() {
        // Just 'A' with no modifiers — not a shortcut
        assert!(!macos_tap::suppress_key_event(VK_A, 0));

        // Just 'S' with no modifiers — not a shortcut
        assert!(!macos_tap::suppress_key_event(VK_S, 0));

        // Return with no modifiers — not a shortcut
        assert!(!macos_tap::suppress_key_event(VK_RETURN, 0));

        // Escape with no modifiers — not a shortcut
        assert!(!macos_tap::suppress_key_event(VK_ESCAPE, 0));
    }

    // ========================================================================
    // Test 3: suppress_key_event returns false for partial modifier matches
    // ========================================================================

    #[test]
    fn test_suppress_key_event_rejects_partial_modifier_matches() {
        // Cmd+S without Shift — not a registered shortcut (Cmd+Shift+S is)
        assert!(!macos_tap::suppress_key_event(VK_S, FLAG_COMMAND));

        // Shift+S without Cmd — not a registered shortcut
        assert!(!macos_tap::suppress_key_event(VK_S, FLAG_SHIFT));

        // Alt+S — not a registered shortcut
        assert!(!macos_tap::suppress_key_event(VK_S, FLAG_ALT));

        // Cmd+H without Shift — not a registered shortcut (Cmd+Shift+H is)
        assert!(!macos_tap::suppress_key_event(VK_H, FLAG_COMMAND));

        // Cmd+V without Shift+Alt — not a registered shortcut (Cmd+Alt+Shift+V is)
        assert!(!macos_tap::suppress_key_event(VK_V, FLAG_COMMAND));

        // Cmd+Shift+V without Alt — not a registered shortcut (Cmd+Alt+Shift+V is)
        assert!(!macos_tap::suppress_key_event(VK_V, FLAG_COMMAND | FLAG_SHIFT));
    }

    // ========================================================================
    // Test 4: ShortcutEntry struct can be deserialized from JSON correctly
    // ========================================================================

    #[test]
    fn test_shortcut_entry_deserialization() {
        let json = r#"[
            {"actionId": "general:take-screenshot", "keycode": 1, "modifiers": 1048576},
            {"actionId": "general:toggle-visibility", "keycode": 9, "modifiers": 1966080}
        ]"#;

        let entries: Vec<ShortcutEntry> = serde_json::from_str(json).unwrap();

        assert_eq!(entries.len(), 2);

        // First entry: Cmd+S (keycode 1, Command modifier)
        assert_eq!(entries[0].action_id, "general:take-screenshot");
        assert_eq!(entries[0].keycode, 1);
        assert_eq!(entries[0].modifiers, 1048576); // 1 << 20 = Command

        // Second entry: Cmd+Shift+Alt+V (keycode 9, Command+Shift+Alt)
        assert_eq!(entries[1].action_id, "general:toggle-visibility");
        assert_eq!(entries[1].keycode, 9);
        assert_eq!(entries[1].modifiers, 1966080); // Command + Shift + Alt
    }

    #[test]
    fn test_shortcut_entry_deserialization_single_entry() {
        let json = r#"{"actionId": "general:emergency-hide", "keycode": 4, "modifiers": 1179648}"#;

        let entry: ShortcutEntry = serde_json::from_str(json).unwrap();

        assert_eq!(entry.action_id, "general:emergency-hide");
        assert_eq!(entry.keycode, 4); // H
        assert_eq!(entry.modifiers, 1179648); // Command + Shift
    }

    // ========================================================================
    // Test 5: match_dynamic_config matches entries correctly
    // ========================================================================

    #[test]
    fn test_match_dynamic_config_matches_correctly() {
        let config = vec![
            ShortcutEntry {
                action_id: "general:take-screenshot".to_string(),
                keycode: VK_S,
                modifiers: FLAG_COMMAND | FLAG_SHIFT, // Cmd+Shift+S
            },
            ShortcutEntry {
                action_id: "general:toggle-visibility".to_string(),
                keycode: VK_V,
                modifiers: FLAG_COMMAND | FLAG_SHIFT | FLAG_ALT, // Cmd+Shift+Alt+V
            },
            ShortcutEntry {
                action_id: "general:process-screenshots".to_string(),
                keycode: VK_RETURN,
                modifiers: FLAG_COMMAND, // Cmd+Enter
            },
        ];

        // Cmd+Shift+S should match take-screenshot
        let result = macos_tap::match_dynamic_config(VK_S, FLAG_COMMAND | FLAG_SHIFT, &config);
        assert_eq!(result, Some("general:take-screenshot".to_string()));

        // Cmd+Shift+Alt+V should match toggle-visibility
        let result = macos_tap::match_dynamic_config(
            VK_V,
            FLAG_COMMAND | FLAG_SHIFT | FLAG_ALT,
            &config,
        );
        assert_eq!(result, Some("general:toggle-visibility".to_string()));

        // Cmd+Enter should match process-screenshots
        let result = macos_tap::match_dynamic_config(VK_RETURN, FLAG_COMMAND, &config);
        assert_eq!(result, Some("general:process-screenshots".to_string()));
    }

    // ========================================================================
    // Test 6: match_dynamic_config returns None for non-matching entries
    // ========================================================================

    #[test]
    fn test_match_dynamic_config_returns_none_for_non_matching() {
        let config = vec![
            ShortcutEntry {
                action_id: "general:take-screenshot".to_string(),
                keycode: VK_S,
                modifiers: FLAG_COMMAND | FLAG_SHIFT, // Cmd+Shift+S
            },
        ];

        // Wrong keycode (A instead of S)
        let result = macos_tap::match_dynamic_config(VK_A, FLAG_COMMAND | FLAG_SHIFT, &config);
        assert_eq!(result, None);

        // Right keycode but wrong modifiers (Cmd only, missing Shift)
        let result = macos_tap::match_dynamic_config(VK_S, FLAG_COMMAND, &config);
        assert_eq!(result, None);

        // No modifiers at all
        let result = macos_tap::match_dynamic_config(VK_S, 0, &config);
        assert_eq!(result, None);

        // Extra modifiers (Cmd+Shift+Alt when only Cmd+Shift is registered)
        let result =
            macos_tap::match_dynamic_config(VK_S, FLAG_COMMAND | FLAG_SHIFT | FLAG_ALT, &config);
        assert_eq!(result, None);

        // Empty config always returns None
        let empty_config: Vec<ShortcutEntry> = vec![];
        let result = macos_tap::match_dynamic_config(VK_S, FLAG_COMMAND | FLAG_SHIFT, &empty_config);
        assert_eq!(result, None);
    }
}
