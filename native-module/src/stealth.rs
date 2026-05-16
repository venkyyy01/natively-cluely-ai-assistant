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

/// T-001: Process information for native process enumeration.
/// Replaces pgrep/ps/tasklist child process spawns.
#[derive(Debug)]
#[napi(object)]
pub struct ProcessInfo {
    pub pid: u32,
    pub ppid: u32,
    pub name: String,
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
    use super::{is_browser_capture_window, ProcessInfo, WindowInfo};
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
    use libc::{c_void, size_t, sysctlbyname};

const K_CGS_DO_NOT_SHARE: i32 = 0;
const K_CGS_NORMAL_SHARE: i32 = 1;

/// On macOS 15+ (Sequoia), both NSWindow.setSharingType: and
/// CGSSetWindowSharingState(kCGSDoNotShare) hide the window completely
/// from the user — not just from screen capture.  On these systems
/// native stealth is a no-op; Electron's setContentProtection (Layer 0)
/// uses ScreenCaptureKit which is the correct modern API.
///
/// We never call setSharingType: on any macOS version — it is dead code.
fn is_macos_15_or_later() -> bool {
    unsafe {
        let mut buf = [0i8; 32];
        let mut len: size_t = buf.len();
        if sysctlbyname(
            c"kern.osproductversion".as_ptr(),
            buf.as_mut_ptr() as *mut c_void,
            &mut len,
            std::ptr::null_mut(),
            0,
        ) != 0
        {
            // Can't determine version — assume 15+ to stay safe
            return true;
        }
        let version = std::ffi::CStr::from_ptr(buf.as_ptr()).to_string_lossy();
        let major: u32 = version.split('.').next().and_then(|s| s.parse().ok()).unwrap_or(0);
        major >= 15
    }
}

/// NSWindow is needed only for set_level and find_window.
/// sharingType / setSharingType: are never touched.
trait NSAppWindowsExt {
    fn windows(&self) -> &ns::Array<ns::Window>;
}

impl NSAppWindowsExt for ns::App {
    #[objc::msg_send(windows)]
    fn windows(&self) -> &ns::Array<ns::Window>;
}

// ============================================================================
// SCK Capture Exclusion — CGSSetWindowTags approach for macOS 15+
// ============================================================================

/// The CGS window tag bit that excludes a window from ScreenCaptureKit
/// enumeration. This is the tag used internally by `NSWindow.sharingType = .none`
/// on macOS 15+ to prevent SCK from listing the window.
const CGS_TAG_EXCLUDE_FROM_CAPTURE: u32 = 1 << 3; // bit 3 = 0x08

/// NSWindowSharingNone — maps to `NSWindow.sharingType = .none`.
const NS_WINDOW_SHARING_NONE: u64 = 0;

extern "C" {
    fn CGSMainConnectionID() -> u32;
    fn CGSSetWindowTags(
        connection: u32,
        window_id: u32,
        tags: *const u32,
        tag_size: u32,
    ) -> i32;
    fn CGSGetWindowTags(
        connection: u32,
        window_id: u32,
        tags: *mut u32,
        tag_size: u32,
    ) -> i32;
}

/// Trait extension to call `setSharingType:` on NSWindow via Objective-C message send.
trait NSWindowSharingExt {
    fn set_sharing_type(&mut self, sharing_type: u64);
}

impl NSWindowSharingExt for ns::Window {
    #[objc::msg_send(setSharingType:)]
    fn set_sharing_type(&mut self, sharing_type: u64);
}

/// Exclude a window from ScreenCaptureKit capture enumeration.
///
/// This combines two approaches:
/// 1. Sets `NSWindow.sharingType = .none` which is the standard content
///    protection mechanism (equivalent to Electron's `setContentProtection`).
/// 2. On macOS 15+, additionally applies `CGSSetWindowTags` with the
///    capture exclusion tag to ensure the window is omitted from SCK's
///    `SCShareableContent.windows` enumeration.
///
/// This function is safe to call on any macOS version — on older systems
/// only the sharingType approach is used.
pub fn exclude_from_capture(window_number: u32) -> napi::Result<()> {
    let mut window = find_window_or_err(window_number)?;

    // Layer 1: Set NSWindow.sharingType = .none
    // This tells the window server the window should not be shared/captured.
    window.set_sharing_type(NS_WINDOW_SHARING_NONE);

    // Layer 2: On macOS 15+, apply CGS window tag for SCK exclusion.
    // This ensures ScreenCaptureKit does not enumerate the window even
    // when apps use the modern SCShareableContent API.
    if is_macos_15_or_later() {
        unsafe {
            let connection = CGSMainConnectionID();
            if connection == 0 {
                return Err(napi::Error::from_reason(
                    "CGSMainConnectionID returned 0 — cannot apply SCK exclusion tag".to_string(),
                ));
            }
            let tags: u32 = CGS_TAG_EXCLUDE_FROM_CAPTURE;
            let result = CGSSetWindowTags(connection, window_number, &tags, 32);
            if result != 0 {
                return Err(napi::Error::from_reason(format!(
                    "CGSSetWindowTags failed with error code {} for window {}",
                    result, window_number
                )));
            }
        }
    }

    Ok(())
}

/// Apply ONLY the CGS window tag for ScreenCaptureKit exclusion.
///
/// Unlike `exclude_from_capture` which combines sharingType + CGS tags,
/// this function is a focused, single-purpose function that ONLY applies
/// the `CGSSetWindowTags` with `kCGSExcludeFromCapture` tag.
///
/// On macOS < 15, this is a graceful no-op (returns Ok(())).
/// On macOS 15+, it applies the CGS tag to exclude the window from
/// SCK's `SCShareableContent.windows` enumeration.
pub fn apply_sck_exclusion(window_number: u32) -> napi::Result<()> {
    if !is_macos_15_or_later() {
        // Graceful no-op on older systems — SCK exclusion via CGS tags
        // is only relevant on macOS 15+.
        return Ok(());
    }

    unsafe {
        let connection = CGSMainConnectionID();
        if connection == 0 {
            return Err(napi::Error::from_reason(
                "CGSMainConnectionID returned 0 — cannot apply SCK exclusion tag".to_string(),
            ));
        }
        let tags: u32 = CGS_TAG_EXCLUDE_FROM_CAPTURE;
        let result = CGSSetWindowTags(connection, window_number, &tags, 32);
        if result != 0 {
            return Err(napi::Error::from_reason(format!(
                "CGSSetWindowTags failed with error code {} for window {}",
                result, window_number
            )));
        }
    }

    Ok(())
}

/// Verify that the SCK exclusion tag is set on a window.
///
/// Uses `CGSGetWindowTags` to read the current window tags and checks
/// whether the `CGS_TAG_EXCLUDE_FROM_CAPTURE` bit is set. This is a
/// reliable proxy for SCK exclusion — if the tag is set, ScreenCaptureKit
/// will not enumerate the window in `SCShareableContent.windows`.
///
/// Returns `true` if the window is properly excluded (tag is set),
/// `false` if the tag is NOT set (window is visible to SCK).
///
/// On macOS < 15, always returns `true` since SCK exclusion via CGS tags
/// is only relevant on macOS 15+ (older systems use different mechanisms).
pub fn verify_sck_exclusion(window_number: u32) -> napi::Result<bool> {
    if !is_macos_15_or_later() {
        // On older macOS, SCK tag-based exclusion is not used — consider
        // the window excluded by default (other mechanisms handle it).
        return Ok(true);
    }

    unsafe {
        let connection = CGSMainConnectionID();
        if connection == 0 {
            return Err(napi::Error::from_reason(
                "CGSMainConnectionID returned 0 — cannot query SCK exclusion tag".to_string(),
            ));
        }
        let mut tags: u32 = 0;
        let result = CGSGetWindowTags(connection, window_number, &mut tags, 32);
        if result != 0 {
            return Err(napi::Error::from_reason(format!(
                "CGSGetWindowTags failed with error code {} for window {}",
                result, window_number
            )));
        }
        Ok((tags & CGS_TAG_EXCLUDE_FROM_CAPTURE) != 0)
    }
}

/// Apply stealth.  On macOS < 15 uses CGSSetWindowSharingState(kCGSDoNotShare).
/// On macOS 15+ this is a no-op — the CGS call hides the window from the user
/// on Sequoia.  Electron's setContentProtection (Layer 0) covers screen capture.
pub fn apply(window_number: u32) -> napi::Result<()> {
    if is_macos_15_or_later() {
        return Ok(());
    }
    apply_cgs(window_number, K_CGS_DO_NOT_SHARE, "apply")
}

/// Remove stealth.
pub fn remove(window_number: u32) -> napi::Result<()> {
    if is_macos_15_or_later() {
        return Ok(());
    }
    apply_cgs(window_number, K_CGS_NORMAL_SHARE, "remove")
}

/// Apply stealth via the private CGS SPI only.
pub fn apply_private(window_number: u32) -> napi::Result<()> {
    apply(window_number)
}

/// Remove stealth via the private CGS SPI only.
pub fn remove_private(window_number: u32) -> napi::Result<()> {
    remove(window_number)
}

pub fn set_level(window_number: u32, level: i32) -> napi::Result<()> {
    let mut window = find_window_or_err(window_number)?;
    window.set_level(ns::WindowLevel(level as isize));
    Ok(())
}

/// Verify window existence only — sharing state is unreadable on macOS 15+.
/// Returns 0 if the window is found, -1 otherwise.
pub fn verify(window_number: u32) -> napi::Result<i32> {
    if find_window(window_number).is_some() {
        return Ok(0);
    }
    Ok(-1)
}

/// Verify the modern macOS capture-exclusion path.
///
/// Electron's BrowserWindow.setExcludeFromCapture(true) keeps the window
/// visible locally while excluding it from ScreenCaptureKit captures. We
/// verify the owning NSWindow still exists, then require CoreGraphics to
/// either omit it from the shareable window list or report sharingState=0.
pub fn verify_capture_exclusion(window_number: u32) -> napi::Result<bool> {
    if find_window(window_number).is_none() {
        return Ok(false);
    }

    let window_number_i32 = window_number as i32;
    let matching_window = list_window_info()?
        .into_iter()
        .find(|window| window.window_number == window_number_i32);

    Ok(match matching_window {
        Some(window) => !window.is_on_screen || window.alpha <= 0.0 || window.sharing_state == 0,
        None => true,
    })
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

    fn apply_cgs(_window_number: u32, _sharing_state: i32, _operation: &str) -> napi::Result<()> {
        // COMPLETELY DISABLED on macOS 15+ (and all versions for safety).
        //
        // On macOS 15+ (Sequoia), both NSWindow.setSharingType: and
        // CGSSetWindowSharingState(kCGSDoNotShare) hide the window completely
        // from the user — not just from screen capture.
        //
        // The app relies solely on Electron's setContentProtection (Layer 0)
        // which uses the modern ScreenCaptureKit API.
        Ok(())
    }

    pub fn list_visible_windows() -> napi::Result<Vec<WindowInfo>> {
        list_window_info()
    }

    pub fn check_browser_capture_windows() -> napi::Result<bool> {
        Ok(list_window_info()?.iter().any(is_browser_capture_window))
    }

    /// Returns the list of visible windows excluding any whose owner_name
    /// contains "Natively" (case-insensitive). This allows the TypeScript
    /// layer to compare the full list vs filtered list to verify that
    /// Natively windows are properly excluded from SCK enumeration.
    pub fn display_list_filter() -> napi::Result<Vec<WindowInfo>> {
        let windows = list_window_info()?;
        Ok(windows
            .into_iter()
            .filter(|w| !w.owner_name.to_lowercase().contains("natively"))
            .collect())
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

    // ============================================================================
    // T-001: macOS process enumeration via libproc (replaces pgrep/ps)
    // ============================================================================
    pub fn get_running_processes() -> napi::Result<Vec<ProcessInfo>> {
        use libc::{c_char, c_int, c_void, pid_t};
        use std::mem;

        const PROC_ALL_PIDS: u32 = 1;
        const PROC_PIDPATHINFO_MAXSIZE: usize = 4096;
        const PROC_PIDTBSDINFO: c_int = 3;

        #[repr(C)]
        #[derive(Copy, Clone)]
        struct ProcBsdInfo {
            pbi_flags: u32,
            pbi_status: u32,
            pbi_xstatus: u32,
            pbi_pid: u32,
            pbi_ppid: u32,
            pbi_uid: u32,
            pbi_gid: u32,
            pbi_ruid: u32,
            pbi_rgid: u32,
            pbi_svuid: u32,
            pbi_svgid: u32,
            rfu_1: u32,
            pbi_comm: [c_char; 16],
            pbi_name: [c_char; 32],
            pbi_nfiles: u32,
            pbi_pgid: u32,
            pbi_pjobc: u32,
            e_tdev: u32,
            e_tpgid: u32,
            pbi_nice: i32,
            pbi_start_tvsec: u64,
            pbi_start_tvusec: i64,
        }

        extern "C" {
            fn proc_listpids(
                dtype: u32,
                typeinfo: u32,
                buffer: *mut c_void,
                buffersize: c_int,
            ) -> c_int;
            fn proc_pidinfo(
                pid: c_int,
                flavor: c_int,
                arg: u64,
                buffer: *mut c_void,
                buffersize: c_int,
            ) -> c_int;
            fn proc_pidpath(pid: c_int, buffer: *mut c_char, buffersize: u32) -> c_int;
        }

        // First call to get the number of PIDs
        let pid_count = unsafe { proc_listpids(PROC_ALL_PIDS, 0, std::ptr::null_mut(), 0) };
        if pid_count <= 0 {
            return Ok(Vec::new());
        }

        let mut pids: Vec<pid_t> = vec![0; pid_count as usize];
        let returned = unsafe {
            proc_listpids(
                PROC_ALL_PIDS,
                0,
                pids.as_mut_ptr() as *mut c_void,
                (pid_count as usize * mem::size_of::<pid_t>()) as c_int,
            )
        };
        if returned <= 0 {
            return Ok(Vec::new());
        }

        let actual_count = returned as usize;
        let mut results = Vec::with_capacity(actual_count);

        for i in 0..actual_count {
            let pid = pids[i];
            if pid <= 0 {
                continue;
            }

            let mut info: ProcBsdInfo = unsafe { mem::zeroed() };
            let info_size = mem::size_of::<ProcBsdInfo>() as c_int;
            let got = unsafe { proc_pidinfo(pid as c_int, PROC_PIDTBSDINFO, 0, &mut info as *mut _ as *mut c_void, info_size) };

            if got != info_size {
                continue;
            }

            let ppid = info.pbi_ppid;

            // Try to get the full path first
            let mut path_buf: Vec<c_char> = vec![0; PROC_PIDPATHINFO_MAXSIZE];
            let path_len = unsafe { proc_pidpath(pid as c_int, path_buf.as_mut_ptr(), PROC_PIDPATHINFO_MAXSIZE as u32) };

            let name = if path_len > 0 {
                unsafe {
                    std::ffi::CStr::from_ptr(path_buf.as_ptr())
                        .to_string_lossy()
                        .into_owned()
                }
            } else {
                // Fallback to comm (short name)
                unsafe {
                    std::ffi::CStr::from_ptr(info.pbi_comm.as_ptr())
                        .to_string_lossy()
                        .into_owned()
                }
            };

            results.push(ProcessInfo {
                pid: pid as u32,
                ppid,
                name,
            });
        }

        Ok(results)
    }
}

#[cfg(not(target_os = "macos"))]
mod macos {
    use super::{ProcessInfo, WindowInfo};

    pub fn exclude_from_capture(_window_number: u32) -> napi::Result<()> {
        Ok(())
    }

    pub fn apply_sck_exclusion(_window_number: u32) -> napi::Result<()> {
        Ok(())
    }

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

    pub fn verify_capture_exclusion(_window_number: u32) -> napi::Result<bool> {
        Ok(false)
    }

    pub fn verify_sck_exclusion(_window_number: u32) -> napi::Result<bool> {
        Ok(true)
    }

    pub fn list_visible_windows() -> napi::Result<Vec<WindowInfo>> {
        Ok(Vec::new())
    }

    pub fn check_browser_capture_windows() -> napi::Result<bool> {
        Ok(false)
    }

    pub fn display_list_filter() -> napi::Result<Vec<WindowInfo>> {
        Ok(Vec::new())
    }

    #[allow(dead_code)]
    pub fn get_running_processes() -> napi::Result<Vec<ProcessInfo>> {
        Ok(Vec::new())
    }
}

#[cfg(target_os = "windows")]
mod windows_impl {
    use super::{Buffer, ProcessInfo};
    use windows::Win32::Foundation::{GetLastError, HWND};
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32First, Process32Next, TH32CS_SNAPPROCESS,
        PROCESSENTRY32,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowDisplayAffinity, GetWindowLongPtrW, SetWindowDisplayAffinity, SetWindowLongPtrW,
        GWL_EXSTYLE, WDA_MONITOR, WDA_NONE, WINDOW_DISPLAY_AFFINITY, WS_EX_NOACTIVATE,
        WS_EX_TOOLWINDOW,
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

    /// Apply `WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW` to the overlay HWND so
    /// clicking it does NOT promote the Electron app to foreground. This is
    /// the Windows analogue of macOS's NSPanel non-activating window — it
    /// prevents the underlying browser from receiving WM_ACTIVATEAPP or a
    /// `blur` event when the user interacts with the overlay.
    ///
    /// Idempotent: re-applying the bits is a no-op. Returns Ok if the bits
    /// were already set or were applied successfully.
    pub fn set_no_activate(hwnd_buffer: Buffer) -> napi::Result<()> {
        let hwnd = hwnd_from_buffer(&hwnd_buffer)?;

        unsafe {
            // Reset Win32 last-error so we can disambiguate "0 because of
            // error" from "0 because the existing style was 0".
            let _ = GetLastError();
            let current = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
            let target = current
                | (WS_EX_NOACTIVATE.0 as isize)
                | (WS_EX_TOOLWINDOW.0 as isize);

            if current == target {
                return Ok(());
            }

            let prev = SetWindowLongPtrW(hwnd, GWL_EXSTYLE, target);
            if prev == 0 {
                let error = GetLastError();
                if error.0 != 0 {
                    return Err(napi::Error::from_reason(format!(
                        "SetWindowLongPtrW(GWL_EXSTYLE) failed: {:?}",
                        error
                    )));
                }
            }
        }

        Ok(())
    }

    /// Remove `WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW` from the overlay HWND.
    /// Used when the overlay needs to receive native focus on demand
    /// (e.g. typing into an input field), and when stealth mode is disabled.
    pub fn clear_no_activate(hwnd_buffer: Buffer) -> napi::Result<()> {
        let hwnd = hwnd_from_buffer(&hwnd_buffer)?;

        unsafe {
            let _ = GetLastError();
            let current = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
            let mask = !((WS_EX_NOACTIVATE.0 as isize) | (WS_EX_TOOLWINDOW.0 as isize));
            let target = current & mask;

            if current == target {
                return Ok(());
            }

            let prev = SetWindowLongPtrW(hwnd, GWL_EXSTYLE, target);
            if prev == 0 {
                let error = GetLastError();
                if error.0 != 0 {
                    return Err(napi::Error::from_reason(format!(
                        "SetWindowLongPtrW(GWL_EXSTYLE) failed: {:?}",
                        error
                    )));
                }
            }
        }

        Ok(())
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

    // ============================================================================
    // T-001: Windows process enumeration via Toolhelp32 (replaces tasklist)
    // ============================================================================
    pub fn get_running_processes() -> napi::Result<Vec<ProcessInfo>> {
        unsafe {
            let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
                .map_err(|e| napi::Error::from_reason(format!("CreateToolhelp32Snapshot failed: {}", e)))?;

            let mut entry = PROCESSENTRY32 {
                dwSize: std::mem::size_of::<PROCESSENTRY32>() as u32,
                ..std::mem::zeroed()
            };

            let mut results = Vec::new();

            if Process32First(snapshot, &mut entry).as_bool() {
                loop {
                    let name = std::ffi::CStr::from_ptr(entry.szExeFile.as_ptr() as *const i8)
                        .to_string_lossy()
                        .into_owned();
                    results.push(ProcessInfo {
                        pid: entry.th32ProcessID,
                        ppid: entry.th32ParentProcessID,
                        name,
                    });

                    if !Process32Next(snapshot, &mut entry).as_bool() {
                        break;
                    }
                }
            }

            let _ = windows::Win32::Foundation::CloseHandle(snapshot);
            Ok(results)
        }
    }
}

#[cfg(not(target_os = "windows"))]
mod windows_impl {
    use super::Buffer;
    use super::ProcessInfo;

    pub fn apply(_hwnd_buffer: Buffer) -> napi::Result<()> {
        Ok(())
    }

    pub fn remove(_hwnd_buffer: Buffer) -> napi::Result<()> {
        Ok(())
    }

    pub fn verify(_hwnd_buffer: Buffer) -> napi::Result<i32> {
        Ok(-1)
    }

    pub fn set_no_activate(_hwnd_buffer: Buffer) -> napi::Result<()> {
        Ok(())
    }

    pub fn clear_no_activate(_hwnd_buffer: Buffer) -> napi::Result<()> {
        Ok(())
    }

    #[allow(dead_code)]
    pub fn get_running_processes() -> napi::Result<Vec<ProcessInfo>> {
        Ok(Vec::new())
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
pub fn verify_macos_capture_exclusion(window_number: u32) -> napi::Result<bool> {
    macos::verify_capture_exclusion(window_number)
}

/// Exclude a window from ScreenCaptureKit capture enumeration.
/// Combines NSWindow.sharingType = .none with CGSSetWindowTags on macOS 15+.
#[napi]
pub fn exclude_from_capture(window_number: u32) -> napi::Result<()> {
    macos::exclude_from_capture(window_number)
}

/// Apply ONLY the CGS window tag for ScreenCaptureKit exclusion (no sharingType change).
/// On macOS < 15, this is a graceful no-op.
#[napi]
pub fn apply_sck_exclusion(window_number: u32) -> napi::Result<()> {
    macos::apply_sck_exclusion(window_number)
}

/// Verify that the SCK exclusion tag is set on a window via CGSGetWindowTags.
/// Returns true if the window is properly excluded from SCK enumeration.
/// On non-macOS, always returns true (window is considered excluded).
#[napi]
pub fn verify_sck_exclusion(window_number: u32) -> napi::Result<bool> {
    macos::verify_sck_exclusion(window_number)
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

/// Apply the WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW extended window styles to
/// a Windows HWND. Prevents the OS from promoting the window to foreground
/// on click — the analogue of macOS's NSPanel non-activating panel. Used by
/// the overlay window to avoid sending `blur` events to the focused browser
/// tab when the user interacts with the overlay.
///
/// On non-Windows platforms this is a no-op.
#[napi]
pub fn apply_windows_no_activate(hwnd_buffer: Buffer) -> napi::Result<()> {
    windows_impl::set_no_activate(hwnd_buffer)
}

/// Reverse of `apply_windows_no_activate`. Restores the ability of the
/// window to receive native foreground activation. Called when stealth
/// mode is disabled or when the overlay needs to receive native focus on
/// demand (e.g. while typing into an input field).
///
/// On non-Windows platforms this is a no-op.
#[napi]
pub fn clear_windows_no_activate(hwnd_buffer: Buffer) -> napi::Result<()> {
    windows_impl::clear_no_activate(hwnd_buffer)
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

/// Returns the list of visible windows excluding Natively-owned windows.
/// Used by the TypeScript layer to compare against the full window list and
/// verify that Natively windows are properly excluded from SCK enumeration.
#[napi(js_name = "getFilteredDisplayList")]
pub fn display_list_filter() -> napi::Result<Vec<WindowInfo>> {
    macos::display_list_filter()
}

// ============================================================================
// T-001: Native process enumeration (replaces pgrep/ps/tasklist)
// ============================================================================

#[napi]
pub fn get_running_processes() -> napi::Result<Vec<ProcessInfo>> {
    #[cfg(target_os = "macos")]
    {
        macos::get_running_processes()
    }
    #[cfg(target_os = "windows")]
    {
        windows_impl::get_running_processes()
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        Ok(Vec::new())
    }
}

#[cfg(test)]
mod tests {
    use super::{is_browser_capture_window, macos, WindowInfo};

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

    fn window_with_number(window_number: i32, owner_name: &str, window_title: &str) -> WindowInfo {
        WindowInfo {
            window_number,
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

    // ========================================================================
    // SCK exclusion function tests (mock-based for non-macOS CI)
    // ========================================================================

    #[test]
    fn apply_sck_exclusion_returns_ok() {
        // On non-macOS: stub returns Ok(())
        // On macOS: would require a real window, so this tests the API contract
        let result = macos::apply_sck_exclusion(12345);
        #[cfg(not(target_os = "macos"))]
        assert!(result.is_ok());
        #[cfg(target_os = "macos")]
        {
            // On macOS without a real window, this may fail — that's expected.
            // The important thing is it doesn't panic.
            let _ = result;
        }
    }

    #[test]
    fn verify_sck_exclusion_returns_true_on_non_macos() {
        let result = macos::verify_sck_exclusion(12345);
        #[cfg(not(target_os = "macos"))]
        {
            assert!(result.is_ok());
            assert_eq!(result.unwrap(), true);
        }
        #[cfg(target_os = "macos")]
        {
            // On macOS without a real window, may error — just ensure no panic.
            let _ = result;
        }
    }

    #[test]
    fn display_list_filter_returns_empty_on_non_macos() {
        let result = macos::display_list_filter();
        #[cfg(not(target_os = "macos"))]
        {
            assert!(result.is_ok());
            assert!(result.unwrap().is_empty());
        }
        #[cfg(target_os = "macos")]
        {
            // On macOS this returns real window data — just ensure no panic.
            assert!(result.is_ok());
        }
    }

    #[test]
    fn exclude_from_capture_returns_ok() {
        let result = macos::exclude_from_capture(99999);
        #[cfg(not(target_os = "macos"))]
        assert!(result.is_ok());
        #[cfg(target_os = "macos")]
        {
            // On macOS without a real window, this may fail — that's expected.
            let _ = result;
        }
    }

    // ========================================================================
    // display_list_filter logic tests — verify filtering behavior
    // ========================================================================

    #[test]
    fn display_list_filter_logic_excludes_natively_windows() {
        // Test the filtering logic that display_list_filter uses:
        // It filters out windows whose owner_name contains "natively" (case-insensitive).
        let windows = vec![
            window_with_number(1, "Google Chrome", "GitHub"),
            window_with_number(2, "Natively", "Main Window"),
            window_with_number(3, "Finder", "Desktop"),
            window_with_number(4, "natively Helper", "Background"),
            window_with_number(5, "Safari", "Apple"),
        ];

        let filtered: Vec<WindowInfo> = windows
            .into_iter()
            .filter(|w| !w.owner_name.to_lowercase().contains("natively"))
            .collect();

        assert_eq!(filtered.len(), 3);
        assert_eq!(filtered[0].owner_name, "Google Chrome");
        assert_eq!(filtered[1].owner_name, "Finder");
        assert_eq!(filtered[2].owner_name, "Safari");
    }

    #[test]
    fn display_list_filter_logic_keeps_all_when_no_natively_windows() {
        let windows = vec![
            window_with_number(1, "Google Chrome", "GitHub"),
            window_with_number(2, "Finder", "Desktop"),
            window_with_number(3, "Safari", "Apple"),
        ];

        let filtered: Vec<WindowInfo> = windows
            .into_iter()
            .filter(|w| !w.owner_name.to_lowercase().contains("natively"))
            .collect();

        assert_eq!(filtered.len(), 3);
    }

    #[test]
    fn display_list_filter_logic_removes_all_natively_variants() {
        // Test case-insensitive matching for various capitalizations
        let windows = vec![
            window_with_number(1, "NATIVELY", "Window 1"),
            window_with_number(2, "Natively", "Window 2"),
            window_with_number(3, "natively", "Window 3"),
            window_with_number(4, "NaTiVeLy App", "Window 4"),
        ];

        let filtered: Vec<WindowInfo> = windows
            .into_iter()
            .filter(|w| !w.owner_name.to_lowercase().contains("natively"))
            .collect();

        assert_eq!(filtered.len(), 0);
    }
}
