use napi::bindgen_prelude::Buffer;

#[cfg(target_os = "macos")]
mod macos {
    use cidre::{arc, ns, objc};
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
            let sharing_fn: CGSSetWindowSharingStateFn =
                std::mem::transmute::<*mut c_void, CGSSetWindowSharingStateFn>(sharing_ptr.as_ptr());

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
}

#[cfg(not(target_os = "macos"))]
mod macos {
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

    pub fn verify(_window_number: u32) -> napi::Result<i32> {
        Ok(-1)
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
