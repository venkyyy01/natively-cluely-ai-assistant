//! macOS cursor hook using CGEventTap.
//!
//! Goal: when the OS hardware cursor is over the Natively overlay rectangle,
//! freeze it at the boundary by swallowing mouse-move events at the HID tap
//! and instead emit a virtual cursor position via a thread-safe N-API
//! callback. The renderer paints a software cursor at that position.
//!
//! Result for screen-share captures: the hardware cursor visibly stops
//! at the edge of the overlay, never appears to interact with empty space,
//! and the React-painted software cursor lives entirely inside the
//! capture-excluded overlay window so it is invisible to proctors.
//!
//! Permissions: requires Accessibility permission on macOS (CGEventTap at
//! kCGHIDEventTap is gated behind it). The TS layer must catch start
//! failures and fall back to "no hook installed" mode.
//!
//! Tap location choice: kCGHIDEventTap (placement: head-insert) so we see
//! events before WindowServer composes the cursor sprite. This is the only
//! tap location at which returning NULL actually freezes the visible
//! cursor — kCGSessionEventTap is too late.

use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ErrorStrategy, ThreadsafeFunction, ThreadsafeFunctionCallMode};
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

/// Snapshot of the overlay's bounding rectangle in global screen coords.
/// Updated from the TS layer whenever the overlay moves or resizes. The
/// callback thread reads this on every event — keep it Copy so the hot path
/// can clone without locking when possible.
#[derive(Debug, Clone, Copy, Default)]
pub struct OverlayBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    /// Whether the overlay is currently visible. When false the hook is a
    /// no-op even if it's still installed; mouse events pass through.
    pub active: bool,
}

/// Shared bounds wrapped in a Mutex so the JS thread can update them while
/// the tap callback reads. The callback only takes the lock for the
/// duration of a single `*ptr` copy so contention is irrelevant.
pub type SharedOverlayBounds = Arc<Mutex<OverlayBounds>>;

/// Payload emitted to JS for every virtual mouse event.
///
/// All coordinates are in global screen space (same coordinate system as
/// `CGEventGetLocation` / NSScreen), `top-left = (0, 0)` and Y increases
/// downward. The TS layer translates to overlay-local coords for React.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VirtualMouseEvent {
    /// Event type — "move", "down", "up", "scroll".
    pub kind: String,
    /// Mouse button — 0 = left, 1 = right, 2 = other. Undefined for move/scroll.
    pub button: i32,
    /// Virtual cursor X in global screen coordinates.
    pub x: f64,
    /// Virtual cursor Y in global screen coordinates.
    pub y: f64,
    /// Scroll wheel delta X (only set for scroll events; 0 otherwise).
    pub scroll_dx: f64,
    /// Scroll wheel delta Y (only set for scroll events; 0 otherwise).
    pub scroll_dy: f64,
}

#[cfg(target_os = "macos")]
mod macos_cursor {
    use super::*;
    use std::os::raw::c_void;
    use std::ptr;
    use std::sync::mpsc;
    use std::thread;
    use std::time::Duration;

    // CG types — we only need pointer-shaped opaque structs.
    type CGEventTapLocation = u32;
    type CGEventTapPlacement = u32;
    type CGEventTapOptions = u32;
    type CGEventMask = u64;
    type CGEventType = u32;

    // kCGHIDEventTap: placed at the lowest level — earliest opportunity to
    // suppress cursor movement before WindowServer animates the sprite.
    const K_CG_HID_EVENT_TAP: CGEventTapLocation = 0;
    const K_CG_HEAD_INSERT_EVENT_TAP: CGEventTapPlacement = 0;
    const K_CG_EVENT_TAP_OPTION_DEFAULT: CGEventTapOptions = 0;

    // CGEventType values
    const K_CG_EVENT_MOUSE_MOVED: CGEventType = 5;
    const K_CG_EVENT_LEFT_MOUSE_DRAGGED: CGEventType = 6;
    const K_CG_EVENT_RIGHT_MOUSE_DRAGGED: CGEventType = 7;
    const K_CG_EVENT_OTHER_MOUSE_DRAGGED: CGEventType = 27;
    const K_CG_EVENT_LEFT_MOUSE_DOWN: CGEventType = 1;
    const K_CG_EVENT_LEFT_MOUSE_UP: CGEventType = 2;
    const K_CG_EVENT_RIGHT_MOUSE_DOWN: CGEventType = 3;
    const K_CG_EVENT_RIGHT_MOUSE_UP: CGEventType = 4;
    const K_CG_EVENT_OTHER_MOUSE_DOWN: CGEventType = 25;
    const K_CG_EVENT_OTHER_MOUSE_UP: CGEventType = 26;
    const K_CG_EVENT_SCROLL_WHEEL: CGEventType = 22;

    // CGEventField numbers (from CGEventTypes.h)
    const K_CG_MOUSE_EVENT_DELTA_X: u32 = 4;
    const K_CG_MOUSE_EVENT_DELTA_Y: u32 = 5;
    const K_CG_SCROLL_WHEEL_EVENT_DELTA_AXIS_1: u32 = 11; // Y
    const K_CG_SCROLL_WHEEL_EVENT_DELTA_AXIS_2: u32 = 12; // X

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

    #[repr(C, packed)]
    #[derive(Copy, Clone)]
    struct CGPoint {
        x: f64,
        y: f64,
    }

    type CGEventTapCallBack = unsafe extern "C" fn(
        proxy: *mut c_void,
        event_type: CGEventType,
        event: CGEventRef,
        user_info: *mut c_void,
    ) -> CGEventRef;

    // CGEventTapCreate, CFMachPortCreateRunLoopSource, etc. are also declared
    // by `stealth_keys::macos_tap` with module-private opaque pointer types.
    // Both modules link to the same CoreGraphics symbols at runtime; the
    // duplicate declarations are an artifact of Rust's privacy model. The
    // signatures are ABI-identical (only nominal type names differ).
    #[allow(clashing_extern_declarations)]
    extern "C" {
        fn CGEventTapCreate(
            tap: CGEventTapLocation,
            place: CGEventTapPlacement,
            options: CGEventTapOptions,
            events_of_interest: CGEventMask,
            callback: CGEventTapCallBack,
            user_info: *mut c_void,
        ) -> CFMachPortRef;

        fn CGEventGetLocation(event: CGEventRef) -> CGPoint;
        fn CGEventGetDoubleValueField(event: CGEventRef, field: u32) -> f64;
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

    #[allow(clashing_extern_declarations)]
    extern "C" {
        static kCFRunLoopDefaultMode: *const c_void;
    }

    /// Mutable virtual cursor state kept on the tap thread.
    /// Held inside a Mutex on the heap so it survives across callback invocations
    /// and so the JS thread can read it (for diagnostics).
    #[derive(Debug, Clone, Copy)]
    pub struct VirtualCursorState {
        pub x: f64,
        pub y: f64,
        pub seeded: bool,
    }

    impl Default for VirtualCursorState {
        fn default() -> Self {
            VirtualCursorState {
                x: 0.0,
                y: 0.0,
                seeded: false,
            }
        }
    }

    pub type SharedCursorState = Arc<Mutex<VirtualCursorState>>;

    /// Test-friendly wrapper: virtual cursor lives in `state`, gets clamped
    /// to `bounds` when bounds.active is true and the real cursor is inside.
    /// Returns `(virtual_x, virtual_y, swallow)` — `swallow=true` means the
    /// caller should suppress the OS event.
    ///
    /// Pure function so it's covered by the unit tests below.
    pub fn process_move(
        real_x: f64,
        real_y: f64,
        delta_x: f64,
        delta_y: f64,
        bounds: OverlayBounds,
        state: &mut VirtualCursorState,
    ) -> (f64, f64, bool) {
        if !bounds.active {
            // Hook idle: keep state in sync but never swallow.
            state.x = real_x;
            state.y = real_y;
            state.seeded = true;
            return (real_x, real_y, false);
        }

        let inside_real = point_inside(real_x, real_y, &bounds);

        if !inside_real {
            // Cursor is outside the overlay — let the OS handle everything
            // and re-seed virtual position from the real cursor so the next
            // entry into the overlay starts from the correct edge.
            state.x = real_x;
            state.y = real_y;
            state.seeded = true;
            return (real_x, real_y, false);
        }

        // Cursor is inside the overlay.
        if !state.seeded {
            // First time inside since activation — initialize at the real
            // cursor position (the user's hardware cursor is already in
            // place, so the software cursor takes over from there).
            state.x = real_x;
            state.y = real_y;
            state.seeded = true;
        } else {
            // Accumulate deltas onto the virtual position. Clamp to bounds
            // so the virtual cursor never escapes the rectangle while the
            // hardware cursor is frozen at the boundary.
            state.x = (state.x + delta_x).clamp(bounds.x, bounds.x + bounds.width);
            state.y = (state.y + delta_y).clamp(bounds.y, bounds.y + bounds.height);
        }

        (state.x, state.y, true)
    }

    /// Pure point-in-rect helper. Public so tests can exercise it.
    pub fn point_inside(x: f64, y: f64, bounds: &OverlayBounds) -> bool {
        x >= bounds.x
            && x <= bounds.x + bounds.width
            && y >= bounds.y
            && y <= bounds.y + bounds.height
    }

    /// Context passed to the CGEventTap callback via user_info.
    struct CursorTapContext {
        callback: ThreadsafeFunction<String, ErrorStrategy::CalleeHandled>,
        stop_signal: Arc<AtomicBool>,
        bounds: SharedOverlayBounds,
        state: SharedCursorState,
    }

    fn current_bounds(ctx: &CursorTapContext) -> OverlayBounds {
        ctx.bounds.lock().map(|b| *b).unwrap_or_default()
    }

    fn dispatch_event(
        ctx: &CursorTapContext,
        kind: &str,
        button: i32,
        x: f64,
        y: f64,
        scroll_dx: f64,
        scroll_dy: f64,
    ) {
        let payload = VirtualMouseEvent {
            kind: kind.to_string(),
            button,
            x,
            y,
            scroll_dx,
            scroll_dy,
        };
        match serde_json::to_string(&payload) {
            Ok(json) => {
                ctx.callback
                    .call(Ok(json), ThreadsafeFunctionCallMode::NonBlocking);
            }
            Err(err) => {
                eprintln!("[CursorHook] failed to serialise virtual event: {}", err);
            }
        }
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
        let ctx = &*(user_info as *const CursorTapContext);
        if ctx.stop_signal.load(Ordering::Relaxed) {
            return event;
        }

        let bounds = current_bounds(ctx);
        let location = CGEventGetLocation(event);
        let real_x = location.x;
        let real_y = location.y;

        match event_type {
            K_CG_EVENT_MOUSE_MOVED
            | K_CG_EVENT_LEFT_MOUSE_DRAGGED
            | K_CG_EVENT_RIGHT_MOUSE_DRAGGED
            | K_CG_EVENT_OTHER_MOUSE_DRAGGED => {
                let delta_x = CGEventGetDoubleValueField(event, K_CG_MOUSE_EVENT_DELTA_X);
                let delta_y = CGEventGetDoubleValueField(event, K_CG_MOUSE_EVENT_DELTA_Y);
                let mut state = ctx
                    .state
                    .lock()
                    .map(|guard| *guard)
                    .unwrap_or_default();
                let (vx, vy, swallow) =
                    process_move(real_x, real_y, delta_x, delta_y, bounds, &mut state);
                if let Ok(mut guard) = ctx.state.lock() {
                    *guard = state;
                }
                if swallow {
                    dispatch_event(ctx, "move", -1, vx, vy, 0.0, 0.0);
                    return ptr::null_mut();
                }
                event
            }
            K_CG_EVENT_LEFT_MOUSE_DOWN
            | K_CG_EVENT_LEFT_MOUSE_UP
            | K_CG_EVENT_RIGHT_MOUSE_DOWN
            | K_CG_EVENT_RIGHT_MOUSE_UP
            | K_CG_EVENT_OTHER_MOUSE_DOWN
            | K_CG_EVENT_OTHER_MOUSE_UP => {
                if !bounds.active || !point_inside(real_x, real_y, &bounds) {
                    return event;
                }
                let virt = ctx
                    .state
                    .lock()
                    .map(|guard| (guard.x, guard.y))
                    .unwrap_or((real_x, real_y));
                let (kind, button) = match event_type {
                    K_CG_EVENT_LEFT_MOUSE_DOWN => ("down", 0),
                    K_CG_EVENT_LEFT_MOUSE_UP => ("up", 0),
                    K_CG_EVENT_RIGHT_MOUSE_DOWN => ("down", 1),
                    K_CG_EVENT_RIGHT_MOUSE_UP => ("up", 1),
                    K_CG_EVENT_OTHER_MOUSE_DOWN => ("down", 2),
                    K_CG_EVENT_OTHER_MOUSE_UP => ("up", 2),
                    _ => unreachable!(),
                };
                dispatch_event(ctx, kind, button, virt.0, virt.1, 0.0, 0.0);
                ptr::null_mut()
            }
            K_CG_EVENT_SCROLL_WHEEL => {
                if !bounds.active || !point_inside(real_x, real_y, &bounds) {
                    return event;
                }
                let dy = CGEventGetDoubleValueField(event, K_CG_SCROLL_WHEEL_EVENT_DELTA_AXIS_1);
                let dx = CGEventGetDoubleValueField(event, K_CG_SCROLL_WHEEL_EVENT_DELTA_AXIS_2);
                let virt = ctx
                    .state
                    .lock()
                    .map(|guard| (guard.x, guard.y))
                    .unwrap_or((real_x, real_y));
                dispatch_event(ctx, "scroll", -1, virt.0, virt.1, dx, dy);
                ptr::null_mut()
            }
            _ => event,
        }
    }

    pub fn start_cursor_tap(
        callback: ThreadsafeFunction<String, ErrorStrategy::CalleeHandled>,
        stop_signal: Arc<AtomicBool>,
        bounds: SharedOverlayBounds,
        state: SharedCursorState,
    ) -> napi::Result<()> {
        let ctx = Box::new(CursorTapContext {
            callback,
            stop_signal: stop_signal.clone(),
            bounds,
            state,
        });
        let raw_ptr = Box::into_raw(ctx) as usize;
        let stop = stop_signal;

        let (tx, rx) = mpsc::channel::<std::result::Result<(), String>>();

        thread::spawn(move || {
            let ctx_ptr = raw_ptr as *mut c_void;
            unsafe {
                let event_mask: CGEventMask = (1u64 << K_CG_EVENT_MOUSE_MOVED)
                    | (1u64 << K_CG_EVENT_LEFT_MOUSE_DRAGGED)
                    | (1u64 << K_CG_EVENT_RIGHT_MOUSE_DRAGGED)
                    | (1u64 << K_CG_EVENT_OTHER_MOUSE_DRAGGED)
                    | (1u64 << K_CG_EVENT_LEFT_MOUSE_DOWN)
                    | (1u64 << K_CG_EVENT_LEFT_MOUSE_UP)
                    | (1u64 << K_CG_EVENT_RIGHT_MOUSE_DOWN)
                    | (1u64 << K_CG_EVENT_RIGHT_MOUSE_UP)
                    | (1u64 << K_CG_EVENT_OTHER_MOUSE_DOWN)
                    | (1u64 << K_CG_EVENT_OTHER_MOUSE_UP)
                    | (1u64 << K_CG_EVENT_SCROLL_WHEEL);

                let tap = CGEventTapCreate(
                    K_CG_HID_EVENT_TAP,
                    K_CG_HEAD_INSERT_EVENT_TAP,
                    K_CG_EVENT_TAP_OPTION_DEFAULT,
                    event_mask,
                    tap_callback,
                    ctx_ptr,
                );

                if tap.is_null() {
                    eprintln!("[CursorHook] CGEventTapCreate failed — Accessibility permission required");
                    let _ = Box::from_raw(ctx_ptr as *mut CursorTapContext);
                    let _ = tx.send(Err(
                        "Failed to create CGEventTap: Accessibility permission is required."
                            .to_string(),
                    ));
                    return;
                }

                let source = CFMachPortCreateRunLoopSource(ptr::null(), tap, 0);
                if source.is_null() {
                    eprintln!("[CursorHook] CFMachPortCreateRunLoopSource failed");
                    CFMachPortInvalidate(tap);
                    CFRelease(tap as *const c_void);
                    let _ = Box::from_raw(ctx_ptr as *mut CursorTapContext);
                    let _ = tx.send(Err(
                        "Failed to create CFRunLoopSource for cursor tap.".to_string(),
                    ));
                    return;
                }

                let run_loop = CFRunLoopGetCurrent();
                CFRunLoopAddSource(run_loop, source, kCFRunLoopDefaultMode);
                CGEventTapEnable(tap, true);

                let _ = tx.send(Ok(()));

                loop {
                    if stop.load(Ordering::Relaxed) {
                        break;
                    }
                    CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.1, 0);
                }

                CGEventTapEnable(tap, false);
                CFMachPortInvalidate(tap);
                CFRelease(source as *const c_void);
                CFRelease(tap as *const c_void);
                let _ = Box::from_raw(ctx_ptr as *mut CursorTapContext);
            }
        });

        match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(Ok(())) => Ok(()),
            Ok(Err(msg)) => Err(napi::Error::from_reason(msg)),
            Err(_) => Ok(()),
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod macos_cursor {
    use super::*;

    #[derive(Debug, Clone, Copy, Default)]
    pub struct VirtualCursorState {
        pub x: f64,
        pub y: f64,
        pub seeded: bool,
    }

    pub type SharedCursorState = Arc<Mutex<VirtualCursorState>>;

    pub fn point_inside(x: f64, y: f64, bounds: &OverlayBounds) -> bool {
        x >= bounds.x
            && x <= bounds.x + bounds.width
            && y >= bounds.y
            && y <= bounds.y + bounds.height
    }

    pub fn process_move(
        real_x: f64,
        real_y: f64,
        _delta_x: f64,
        _delta_y: f64,
        _bounds: OverlayBounds,
        state: &mut VirtualCursorState,
    ) -> (f64, f64, bool) {
        // No CGEventTap on non-macOS — the function exists only to keep the
        // unit tests compilable. It always reports "do not swallow".
        state.x = real_x;
        state.y = real_y;
        state.seeded = true;
        (real_x, real_y, false)
    }

    pub fn start_cursor_tap(
        _callback: ThreadsafeFunction<String, ErrorStrategy::CalleeHandled>,
        _stop_signal: Arc<AtomicBool>,
        _bounds: SharedOverlayBounds,
        _state: SharedCursorState,
    ) -> napi::Result<()> {
        Ok(())
    }
}

// ============================================================================
// NAPI exports
// ============================================================================

/// JS-facing macOS cursor hook controller.
///
/// Lifecycle:
///   const hook = new MacosCursorHook();
///   hook.setOverlayBounds(x, y, width, height);
///   hook.setActive(true);                    // arms the tap (overlay visible)
///   hook.start(event => { ... });            // creates tap, throws if Accessibility denied
///   ...
///   hook.setActive(false);                   // disarms tap (overlay hidden)
///   hook.stop();                             // tears tap down
#[napi]
pub struct MacosCursorHook {
    stop_signal: Arc<AtomicBool>,
    bounds: SharedOverlayBounds,
    state: macos_cursor::SharedCursorState,
    started: bool,
}

#[napi]
impl MacosCursorHook {
    #[napi(constructor)]
    pub fn new() -> Self {
        MacosCursorHook {
            stop_signal: Arc::new(AtomicBool::new(false)),
            bounds: Arc::new(Mutex::new(OverlayBounds::default())),
            state: Arc::new(Mutex::new(macos_cursor::VirtualCursorState::default())),
            started: false,
        }
    }

    /// Update the overlay bounding rectangle in global screen coordinates.
    /// Called whenever the overlay moves, resizes, or changes display.
    #[napi]
    pub fn set_overlay_bounds(&self, x: f64, y: f64, width: f64, height: f64) -> napi::Result<()> {
        if width < 0.0 || height < 0.0 {
            return Err(napi::Error::from_reason(
                "Overlay bounds must have non-negative width and height".to_string(),
            ));
        }
        let mut guard = self.bounds.lock().map_err(|e| {
            napi::Error::from_reason(format!("Failed to lock cursor bounds: {}", e))
        })?;
        guard.x = x;
        guard.y = y;
        guard.width = width;
        guard.height = height;
        Ok(())
    }

    /// Toggle whether the hook should suppress events when the cursor enters
    /// the overlay. The tap stays installed either way; setActive=false just
    /// makes the hot path a passthrough so we don't pay the round-trip cost
    /// of starting / stopping the tap on every overlay show/hide.
    #[napi]
    pub fn set_active(&self, active: bool) -> napi::Result<()> {
        let mut guard = self.bounds.lock().map_err(|e| {
            napi::Error::from_reason(format!("Failed to lock cursor bounds: {}", e))
        })?;
        guard.active = active;
        Ok(())
    }

    /// Start the cursor tap. Returns an error if Accessibility permission is
    /// not granted — the JS layer should treat this as "feature unavailable"
    /// and fall back gracefully.
    #[napi]
    pub fn start(&mut self, callback: JsFunction) -> napi::Result<()> {
        if self.started {
            return Ok(());
        }
        let tsfn: ThreadsafeFunction<String, ErrorStrategy::CalleeHandled> =
            callback.create_threadsafe_function(0, |ctx| Ok(vec![ctx.value]))?;
        self.stop_signal.store(false, Ordering::SeqCst);
        match macos_cursor::start_cursor_tap(
            tsfn,
            self.stop_signal.clone(),
            self.bounds.clone(),
            self.state.clone(),
        ) {
            Ok(()) => {
                self.started = true;
                Ok(())
            }
            Err(err) => {
                self.started = false;
                Err(err)
            }
        }
    }

    #[napi]
    pub fn stop(&mut self) {
        self.stop_signal.store(true, Ordering::SeqCst);
        self.started = false;
        if let Ok(mut guard) = self.state.lock() {
            *guard = macos_cursor::VirtualCursorState::default();
        }
    }

    /// Whether the tap is currently running.
    #[napi]
    pub fn is_active(&self) -> bool {
        self.started
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use macos_cursor::{point_inside, process_move, VirtualCursorState};

    fn bounds() -> OverlayBounds {
        OverlayBounds {
            x: 100.0,
            y: 100.0,
            width: 600.0,
            height: 400.0,
            active: true,
        }
    }

    #[test]
    fn point_inside_handles_bounds_correctly() {
        let b = bounds();
        assert!(point_inside(100.0, 100.0, &b));
        assert!(point_inside(700.0, 500.0, &b));
        assert!(point_inside(400.0, 250.0, &b));
        assert!(!point_inside(99.0, 250.0, &b));
        assert!(!point_inside(701.0, 250.0, &b));
        assert!(!point_inside(400.0, 99.0, &b));
        assert!(!point_inside(400.0, 501.0, &b));
    }

    #[test]
    fn process_move_passes_through_when_inactive() {
        let mut state = VirtualCursorState::default();
        let mut b = bounds();
        b.active = false;
        let (vx, vy, swallow) = process_move(50.0, 50.0, 5.0, 5.0, b, &mut state);
        assert_eq!((vx, vy), (50.0, 50.0));
        assert!(!swallow);
        assert!(state.seeded);
    }

    #[test]
    fn process_move_passes_through_outside_overlay() {
        let mut state = VirtualCursorState::default();
        let (vx, vy, swallow) = process_move(50.0, 50.0, 1.0, 1.0, bounds(), &mut state);
        assert_eq!((vx, vy), (50.0, 50.0));
        assert!(!swallow);
        assert!(state.seeded);
    }

    #[test]
    fn process_move_seeds_state_on_first_overlay_entry() {
        let mut state = VirtualCursorState::default();
        let (vx, vy, swallow) = process_move(200.0, 200.0, 10.0, 10.0, bounds(), &mut state);
        assert_eq!((vx, vy), (200.0, 200.0));
        assert!(swallow);
        assert!(state.seeded);
    }

    #[test]
    fn process_move_accumulates_deltas_inside_overlay() {
        let mut state = VirtualCursorState::default();
        // First entry seeds at the real cursor position.
        process_move(200.0, 200.0, 0.0, 0.0, bounds(), &mut state);
        // Subsequent moves accumulate deltas, hardware cursor is frozen so
        // real_x/y won't be respected once we're seeded.
        let (vx, vy, swallow) = process_move(200.0, 200.0, 5.0, 7.0, bounds(), &mut state);
        assert_eq!((vx, vy), (205.0, 207.0));
        assert!(swallow);
    }

    #[test]
    fn process_move_clamps_virtual_cursor_to_bounds() {
        let mut state = VirtualCursorState::default();
        process_move(200.0, 200.0, 0.0, 0.0, bounds(), &mut state);
        // Push the cursor far past the right edge — should clamp at 700.
        let (vx, _vy, swallow) = process_move(200.0, 200.0, 9999.0, 0.0, bounds(), &mut state);
        assert!(swallow);
        assert!((vx - 700.0).abs() < f64::EPSILON);

        // Now far past the left edge — clamp at 100.
        let (vx, _vy, _) = process_move(200.0, 200.0, -9999.0, 0.0, bounds(), &mut state);
        assert!((vx - 100.0).abs() < f64::EPSILON);
    }

    #[test]
    fn process_move_resets_seed_when_cursor_leaves_overlay() {
        let mut state = VirtualCursorState::default();
        // Enter overlay, accumulate.
        process_move(200.0, 200.0, 0.0, 0.0, bounds(), &mut state);
        process_move(200.0, 200.0, 50.0, 50.0, bounds(), &mut state);
        // User flicks cursor off-overlay — virtual state should resync to
        // the real cursor position, so the next entry seeds correctly.
        let (vx, vy, swallow) = process_move(50.0, 50.0, 5.0, 5.0, bounds(), &mut state);
        assert!(!swallow);
        assert_eq!((vx, vy), (50.0, 50.0));
        assert_eq!(state.x, 50.0);
        assert_eq!(state.y, 50.0);
    }
}
