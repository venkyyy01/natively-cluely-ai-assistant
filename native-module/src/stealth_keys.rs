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

use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ErrorStrategy, ThreadsafeFunction, ThreadsafeFunctionCallMode};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

#[cfg(target_os = "macos")]
mod macos_tap {
    use super::*;
    use std::os::raw::c_void;
    use std::thread;

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

            // Cmd+Alt+Shift+A — Selective Screenshot
            (true, true, true, K_VK_A) => Some(StealthAction::SelectiveScreenshot),

            // Shift+Esc — Restore Full Stealth
            (false, true, false, K_VK_ESCAPE) => Some(StealthAction::RestoreFullStealth),

            _ => None,
        }
    }

    struct TapContext {
        callback: ThreadsafeFunction<String, ErrorStrategy::CalleeHandled>,
        stop_signal: Arc<AtomicBool>,
    }

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

        if let Some(action) = match_shortcut(keycode, flags) {
            ctx.callback.call(
                Ok(action.as_str().to_string()),
                ThreadsafeFunctionCallMode::NonBlocking,
            );
        }

        // Always return the event unchanged — we are listen-only
        event
    }

    pub(crate) fn start_stealth_tap(
        callback: ThreadsafeFunction<String, ErrorStrategy::CalleeHandled>,
        stop_signal: Arc<AtomicBool>,
    ) -> napi::Result<()> {
        let ctx = Box::new(TapContext {
            callback,
            stop_signal: stop_signal.clone(),
        });
        let raw_ptr = Box::into_raw(ctx) as usize; // usize is Send
        let stop = stop_signal;

        thread::spawn(move || {
            let ctx_ptr = raw_ptr as *mut c_void;
            unsafe {
                // Listen for keyDown and flagsChanged events
                let event_mask: CGEventMask =
                    (1 << K_CG_EVENT_KEY_DOWN) | (1 << K_CG_EVENT_FLAGS_CHANGED);

                let tap = CGEventTapCreate(
                    K_CG_SESSION_EVENT_TAP,
                    K_CG_HEAD_INSERT_EVENT_TAP,
                    K_CG_EVENT_TAP_OPTION_LISTEN_ONLY, // CRITICAL: listen-only, not active
                    event_mask,
                    tap_callback,
                    ctx_ptr,
                );

                if tap.is_null() {
                    eprintln!("[StealthKeys] Failed to create CGEventTap — Accessibility permission may be required");
                    let _ = Box::from_raw(ctx_ptr as *mut TapContext);
                    return;
                }

                let source = CFMachPortCreateRunLoopSource(std::ptr::null(), tap, 0);
                if source.is_null() {
                    eprintln!("[StealthKeys] Failed to create run loop source");
                    CFMachPortInvalidate(tap);
                    CFRelease(tap as *const c_void);
                    let _ = Box::from_raw(ctx_ptr as *mut TapContext);
                    return;
                }

                let run_loop = CFRunLoopGetCurrent();
                CFRunLoopAddSource(run_loop, source, kCFRunLoopDefaultMode);
                CGEventTapEnable(tap, true);

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

        Ok(())
    }
}

#[cfg(not(target_os = "macos"))]
mod macos_tap {
    use super::*;

    pub(crate) fn start_stealth_tap(
        _callback: ThreadsafeFunction<String, ErrorStrategy::CalleeHandled>,
        _stop_signal: Arc<AtomicBool>,
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
#[napi]
pub struct StealthKeyMonitor {
    stop_signal: Arc<AtomicBool>,
    started: bool,
}

#[napi]
impl StealthKeyMonitor {
    #[napi(constructor)]
    pub fn new() -> Self {
        StealthKeyMonitor {
            stop_signal: Arc::new(AtomicBool::new(false)),
            started: false,
        }
    }

    /// Start the stealth key monitor. The callback receives action IDs
    /// (e.g. "general:take-screenshot") when matching key combinations are pressed.
    /// Unlike globalShortcut, this cannot be enumerated by other processes.
    #[napi]
    pub fn start(&mut self, callback: JsFunction) -> napi::Result<()> {
        if self.started {
            return Ok(());
        }

        let tsfn: ThreadsafeFunction<String, ErrorStrategy::CalleeHandled> =
            callback.create_threadsafe_function(0, |ctx| Ok(vec![ctx.value]))?;

        self.stop_signal.store(false, Ordering::SeqCst);
        macos_tap::start_stealth_tap(tsfn, self.stop_signal.clone())?;
        self.started = true;

        Ok(())
    }

    /// Stop the stealth key monitor.
    #[napi]
    pub fn stop(&mut self) {
        self.stop_signal.store(true, Ordering::SeqCst);
        self.started = false;
    }
}
