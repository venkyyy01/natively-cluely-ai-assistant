use napi::bindgen_prelude::Buffer;

/// Represents information about a visible window.
/// Used by the Electron side for capture detection instead of spawning Python.
#[derive(Debug)]
#[napi(object)]
pub struct WindowInfo {
    pub window_number: i32,
    pub owner_name: String,
    pub owner_pid: i32,
    pub window_title: String,
    pub is_on_screen: bool,
    pub sharing_state: i32,
    pub alpha: f64,
}

const BROWSER_OWNER_PATTERNS: &[&str] = &[
    "google chrome",
    "chromium",
    "microsoft edge",
    "brave browser",
    "opera",
    "arc",
];

const CAPTURE_TITLE_PATTERNS: &[&str] = &[
    "sharing",
    "presenting",
    "screen",
    "broadcast",
    "meet.google.com",
    "teams.microsoft.com",
    "zoom.us",
    "webex.com",
    "app.slack.com",
    "discord.com",
];

fn is_browser_capture_window(window: &WindowInfo) -> bool {
    let owner = window.owner_name.to_ascii_lowercase();
    let title = window.window_title.to_ascii_lowercase();

    BROWSER_OWNER_PATTERNS
        .iter()
        .any(|pattern| owner.contains(pattern))
        && CAPTURE_TITLE_PATTERNS
            .iter()
            .any(|pattern| title.contains(pattern))
}

#[cfg(target_os = "macos")]
#[allow(unexpected_cfgs, deprecated)]
mod macos {
    use super::{is_browser_capture_window, WindowInfo};
    use cidre::{arc, ns, objc};
    use core_foundation::base::{CFType, TCFType};
    use core_foundation::boolean::CFBoolean;
    use core_foundation::dictionary::{CFDictionary, CFDictionaryRef};
    use core_foundation::number::CFNumber;
    use core_foundation::string::{CFString, CFStringRef};
    use core_graphics::window::{
        copy_window_info, kCGNullWindowID, kCGWindowAlpha, kCGWindowIsOnscreen,
        kCGWindowListOptionAll, kCGWindowName, kCGWindowNumber, kCGWindowOwnerName,
        kCGWindowOwnerPID, kCGWindowSharingState,
    };
    use libc::{c_char, c_void, dlsym, RTLD_DEFAULT};
    use std::ptr::NonNull;

    type CGSMainConnectionIDFn = unsafe extern "C" fn() -> i32;
    type CGSSetWindowSharingStateFn = unsafe extern "C" fn(i32, i32, i32) -> i32;

    const K_CGS_DO_NOT_SHARE: i32 = 0;
    const K_CGS_NORMAL_SHARE: i32 = 1;

    /// Extension trait adding stealth-related selectors that cidre does not wrap.
    /// `setSharingType:` / `sharingType` live on NSWindow but are not in cidre's bindings.
    /// `windows` lives on NSApplication but is also absent.
    ///
    /// Using cidre's `#[objc::msg_send]` attribute lets the proc-macro generate
    /// the objc_msgSend call with proper ABI, without pulling in the deprecated
    /// `cocoa` / `objc` crates.
    trait NSWindowStealthExt {
        fn set_sharing_type(&self, sharing_type: usize);
        fn sharing_type(&self) -> usize;
    }

    impl NSWindowStealthExt for ns::Window {
        #[objc::msg_send(setSharingType:)]
        fn set_sharing_type(&self, sharing_type: usize);

        #[objc::msg_send(sharingType)]
        fn sharing_type(&self) -> usize;
    }

    trait NSAppWindowsExt {
        fn windows(&self) -> &ns::Array<ns::Window>;
    }

    impl NSAppWindowsExt for ns::App {
        #[objc::msg_send(windows)]
        fn windows(&self) -> &ns::Array<ns::Window>;
    }

    pub fn apply(window_number: u32) -> napi::Result<()> {
        let window = find_window_or_err(window_number)?;
        window.set_sharing_type(K_CGS_DO_NOT_SHARE as usize);
        Ok(())
    }

    pub fn remove(window_number: u32) -> napi::Result<()> {
        let window = find_window_or_err(window_number)?;
        window.set_sharing_type(K_CGS_NORMAL_SHARE as usize);
        Ok(())
    }

    pub fn apply_private(window_number: u32) -> napi::Result<()> {
        let _ = find_window_or_err(window_number)?;
        apply_cgs(window_number, K_CGS_DO_NOT_SHARE, "apply")
    }

    pub fn remove_private(window_number: u32) -> napi::Result<()> {
        let _ = find_window_or_err(window_number)?;
        apply_cgs(window_number, K_CGS_NORMAL_SHARE, "remove")
    }

    pub fn set_level(window_number: u32, level: i32) -> napi::Result<()> {
        let mut window = find_window_or_err(window_number)?;
        window.set_level(ns::WindowLevel(level as isize));
        Ok(())
    }

    pub fn verify(window_number: u32) -> napi::Result<i32> {
        if let Some(window) = find_window(window_number) {
            let sharing_type = window.sharing_type();
            return Ok(sharing_type as i32);
        }

        Ok(-1)
    }

    fn find_window(window_number: u32) -> Option<arc::R<ns::Window>> {
        let app = ns::App::shared();
        let windows = app.windows();
        let count = windows.len();

        for index in 0..count {
            let window = match windows.get(index) {
                Ok(w) => w,
                Err(_) => continue,
            };
            let current_window_number = window.window_number();
            if current_window_number == window_number as ns::Integer {
                return Some(window.retained());
            }
        }

        None
    }

    fn find_window_or_err(window_number: u32) -> napi::Result<arc::R<ns::Window>> {
        find_window(window_number).ok_or_else(|| {
            napi::Error::from_reason(format!(
                "macOS window not found for window number {}",
                window_number
            ))
        })
    }

    fn apply_cgs(window_number: u32, sharing_state: i32, operation: &str) -> napi::Result<()> {
        unsafe {
            let connection_symbol = c"CGSMainConnectionID";
            let sharing_symbol = c"CGSSetWindowSharingState";

            let connection_ptr = NonNull::new(dlsym(
                RTLD_DEFAULT,
                connection_symbol.as_ptr() as *const c_char,
            ))
            .ok_or_else(|| {
                napi::Error::from_reason(format!(
                    "CGSMainConnectionID symbol unavailable during {}",
                    operation
                ))
            })?;
            let sharing_ptr = NonNull::new(dlsym(
                RTLD_DEFAULT,
                sharing_symbol.as_ptr() as *const c_char,
            ))
            .ok_or_else(|| {
                napi::Error::from_reason(format!(
                    "CGSSetWindowSharingState symbol unavailable during {}",
                    operation
                ))
            })?;

            let connection_fn: CGSMainConnectionIDFn =
                std::mem::transmute::<*mut c_void, CGSMainConnectionIDFn>(connection_ptr.as_ptr());
            let sharing_fn: CGSSetWindowSharingStateFn = std::mem::transmute::<
                *mut c_void,
                CGSSetWindowSharingStateFn,
            >(sharing_ptr.as_ptr());

            let connection_id = connection_fn();
            let result = sharing_fn(connection_id, window_number as i32, sharing_state);
            if result != 0 {
                return Err(napi::Error::from_reason(format!(
                    "CGSSetWindowSharingState {} rejected with {} for window {}",
                    operation, result, window_number
                )));
            }
        }

        Ok(())
    }

    pub fn list_visible_windows() -> napi::Result<Vec<WindowInfo>> {
        list_window_info()
    }

    pub fn check_browser_capture_windows() -> napi::Result<bool> {
        Ok(list_window_info()?.iter().any(is_browser_capture_window))
    }

    fn list_window_info() -> napi::Result<Vec<WindowInfo>> {
        let array = copy_window_info(kCGWindowListOptionAll, kCGNullWindowID).ok_or_else(|| {
            napi::Error::from_reason("CGWindowListCopyWindowInfo returned null".to_string())
        })?;

        let mut windows = Vec::with_capacity(array.len() as usize);
        for raw_value in array.get_all_values() {
            if raw_value.is_null() {
                continue;
            }

            let dictionary = unsafe {
                CFDictionary::<CFString, CFType>::wrap_under_get_rule(raw_value as CFDictionaryRef)
            };
            if let Some(window) = window_info_from_dictionary(&dictionary) {
                windows.push(window);
            }
        }

        Ok(windows)
    }

    fn window_info_from_dictionary(
        dictionary: &CFDictionary<CFString, CFType>,
    ) -> Option<WindowInfo> {
        let window_number = get_i32(dictionary, unsafe { kCGWindowNumber })?;
        if window_number <= 0 {
            return None;
        }

        Some(WindowInfo {
            window_number,
            owner_name: get_string(dictionary, unsafe { kCGWindowOwnerName }),
            owner_pid: get_i32(dictionary, unsafe { kCGWindowOwnerPID }).unwrap_or(-1),
            window_title: get_string(dictionary, unsafe { kCGWindowName }),
            is_on_screen: get_bool(dictionary, unsafe { kCGWindowIsOnscreen }).unwrap_or(false),
            sharing_state: get_i32(dictionary, unsafe { kCGWindowSharingState }).unwrap_or(0),
            alpha: get_f64(dictionary, unsafe { kCGWindowAlpha }).unwrap_or(1.0),
        })
    }

    fn get_value<'a>(
        dictionary: &'a CFDictionary<CFString, CFType>,
        key: CFStringRef,
    ) -> Option<core_foundation::base::ItemRef<'a, CFType>> {
        dictionary.find(key)
    }

    fn get_i32(dictionary: &CFDictionary<CFString, CFType>, key: CFStringRef) -> Option<i32> {
        get_value(dictionary, key)
            .and_then(|value| value.downcast::<CFNumber>())
            .and_then(|number| number.to_i32())
    }

    fn get_f64(dictionary: &CFDictionary<CFString, CFType>, key: CFStringRef) -> Option<f64> {
        get_value(dictionary, key)
            .and_then(|value| value.downcast::<CFNumber>())
            .and_then(|number| number.to_f64())
    }

    fn get_bool(dictionary: &CFDictionary<CFString, CFType>, key: CFStringRef) -> Option<bool> {
        if let Some(boolean) =
            get_value(dictionary, key).and_then(|value| value.downcast::<CFBoolean>())
        {
            return Some(bool::from(boolean));
        }

        get_i32(dictionary, key).map(|value| value != 0)
    }

    fn get_string(dictionary: &CFDictionary<CFString, CFType>, key: CFStringRef) -> String {
        get_value(dictionary, key)
            .and_then(|value| value.downcast::<CFString>())
            .map(|string| string.to_string())
            .unwrap_or_default()
    }
}

#[cfg(not(target_os = "macos"))]
mod macos {
    use super::WindowInfo;

    pub fn apply(_window_number: u32) -> napi::Result<()> {
        Ok(())
    }

    pub fn remove(_window_number: u32) -> napi::Result<()> {
        Ok(())
    }

    pub fn apply_private(_window_number: u32) -> napi::Result<()> {
        Ok(())
    }

    pub fn remove_private(_window_number: u32) -> napi::Result<()> {
        Ok(())
    }

    pub fn set_level(_window_number: u32, _level: i32) -> napi::Result<()> {
        Ok(())
    }

    pub fn verify(_window_number: u32) -> napi::Result<i32> {
        Ok(-1)
    }

    pub fn list_visible_windows() -> napi::Result<Vec<WindowInfo>> {
        Ok(Vec::new())
    }

    pub fn check_browser_capture_windows() -> napi::Result<bool> {
        Ok(false)
    }
}

#[cfg(target_os = "windows")]
mod windows_impl {
    use super::Buffer;
    use windows::Win32::Foundation::{GetLastError, HWND};
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowDisplayAffinity, SetWindowDisplayAffinity, WDA_MONITOR, WDA_NONE,
        WINDOW_DISPLAY_AFFINITY,
    };

    const WDA_EXCLUDEFROMCAPTURE: WINDOW_DISPLAY_AFFINITY = WINDOW_DISPLAY_AFFINITY(0x00000011);

    pub fn apply(hwnd_buffer: Buffer) -> napi::Result<()> {
        let hwnd = hwnd_from_buffer(&hwnd_buffer)?;

        unsafe {
            if SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE).as_bool() {
                return Ok(());
            }

            let error = GetLastError();
            eprintln!(
                "[stealth] WDA_EXCLUDEFROMCAPTURE failed with {:?}, falling back to WDA_MONITOR",
                error
            );

            if SetWindowDisplayAffinity(hwnd, WDA_MONITOR).as_bool() {
                return Ok(());
            }
        }

        Err(napi::Error::from_reason(
            "Failed to apply Windows window display affinity".to_string(),
        ))
    }

    pub fn remove(hwnd_buffer: Buffer) -> napi::Result<()> {
        let hwnd = hwnd_from_buffer(&hwnd_buffer)?;

        unsafe {
            if SetWindowDisplayAffinity(hwnd, WDA_NONE).as_bool() {
                return Ok(());
            }
        }

        Err(napi::Error::from_reason(
            "Failed to remove Windows window display affinity".to_string(),
        ))
    }

    pub fn verify(hwnd_buffer: Buffer) -> napi::Result<i32> {
        let hwnd = hwnd_from_buffer(&hwnd_buffer)?;
        let mut affinity = WINDOW_DISPLAY_AFFINITY(0);

        unsafe {
            if GetWindowDisplayAffinity(hwnd, &mut affinity).as_bool() {
                return Ok(affinity.0 as i32);
            }
        }

        Ok(-1)
    }

    fn hwnd_from_buffer(buffer: &Buffer) -> napi::Result<HWND> {
        let pointer_size = std::mem::size_of::<isize>();
        if buffer.len() < pointer_size {
            return Err(napi::Error::from_reason(
                "Native window handle buffer is smaller than a pointer".to_string(),
            ));
        }

        let mut raw = [0u8; std::mem::size_of::<isize>()];
        raw.copy_from_slice(&buffer[..pointer_size]);
        Ok(HWND(isize::from_le_bytes(raw)))
    }
}

#[cfg(not(target_os = "windows"))]
mod windows_impl {
    use super::Buffer;

    pub fn apply(_hwnd_buffer: Buffer) -> napi::Result<()> {
        Ok(())
    }

    pub fn remove(_hwnd_buffer: Buffer) -> napi::Result<()> {
        Ok(())
    }

    pub fn verify(_hwnd_buffer: Buffer) -> napi::Result<i32> {
        Ok(-1)
    }
}

#[napi]
pub fn apply_macos_window_stealth(window_number: u32) -> napi::Result<()> {
    macos::apply(window_number)
}

#[napi]
pub fn remove_macos_window_stealth(window_number: u32) -> napi::Result<()> {
    macos::remove(window_number)
}

#[napi]
pub fn apply_macos_private_window_stealth(window_number: u32) -> napi::Result<()> {
    macos::apply_private(window_number)
}

#[napi]
pub fn remove_macos_private_window_stealth(window_number: u32) -> napi::Result<()> {
    macos::remove_private(window_number)
}

#[napi]
pub fn set_macos_window_level(window_number: u32, level: i32) -> napi::Result<()> {
    macos::set_level(window_number, level)
}

#[napi]
pub fn verify_macos_stealth_state(window_number: u32) -> napi::Result<i32> {
    macos::verify(window_number)
}

#[napi]
pub fn apply_windows_window_stealth(hwnd_buffer: Buffer) -> napi::Result<()> {
    windows_impl::apply(hwnd_buffer)
}

#[napi]
pub fn remove_windows_window_stealth(hwnd_buffer: Buffer) -> napi::Result<()> {
    windows_impl::remove(hwnd_buffer)
}

#[napi]
pub fn verify_windows_stealth_state(hwnd_buffer: Buffer) -> napi::Result<i32> {
    windows_impl::verify(hwnd_buffer)
}

// ============================================================================
// S-8: CGWindow List Functions (Native replacement for Python3 subprocess)
// ============================================================================

/// List all visible windows using Core Graphics.
/// This replaces the Python3 subprocess call to Quartz.CGWindowListCopyWindowInfo.
#[napi]
pub fn list_visible_windows() -> napi::Result<Vec<WindowInfo>> {
    macos::list_visible_windows()
}

/// Check if any browser-based capture is active based on window titles.
/// Combines the Quartz window enumeration + browser check in a single native call.
#[napi]
pub fn check_browser_capture_windows() -> napi::Result<bool> {
    macos::check_browser_capture_windows()
}

#[cfg(test)]
mod tests {
    use super::{is_browser_capture_window, WindowInfo};

    fn window(owner_name: &str, window_title: &str) -> WindowInfo {
        WindowInfo {
            window_number: 1,
            owner_name: owner_name.to_string(),
            owner_pid: 42,
            window_title: window_title.to_string(),
            is_on_screen: true,
            sharing_state: 1,
            alpha: 1.0,
        }
    }

    #[test]
    fn browser_capture_detection_requires_browser_owner_and_capture_title() {
        assert!(is_browser_capture_window(&window(
            "Google Chrome",
            "meet.google.com is sharing your screen",
        )));
        assert!(!is_browser_capture_window(&window(
            "Google Chrome",
            "Inbox",
        )));
        assert!(!is_browser_capture_window(&window(
            "Notes",
            "screen broadcast",
        )));
    }
}
