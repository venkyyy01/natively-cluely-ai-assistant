use napi::bindgen_prelude::Buffer;

#[cfg(target_os = "macos")]
mod macos {
    use libc::{c_char, c_void, dlsym, RTLD_DEFAULT};
    use cocoa::base::{id, nil};
    use objc::{class, msg_send, sel, sel_impl};

    type CGSMainConnectionIDFn = unsafe extern "C" fn() -> i32;
    type CGSSetWindowSharingStateFn = unsafe extern "C" fn(i32, i32, i32) -> i32;

    const K_CGS_DO_NOT_SHARE: i32 = 0;
    const K_CGS_NORMAL_SHARE: i32 = 1;

    pub fn apply(window_number: u32) -> napi::Result<()> {
        unsafe {
            if let Some(window) = find_window(window_number) {
                let _: () = msg_send![window, setSharingType: 0usize];
            } else {
                eprintln!(
                    "[stealth] macOS window not found for window number {}",
                    window_number
                );
            }
        }

        Ok(())
    }

    pub fn remove(window_number: u32) -> napi::Result<()> {
        unsafe {
            if let Some(window) = find_window(window_number) {
                let _: () = msg_send![window, setSharingType: 1usize];
            }
        }

        Ok(())
    }

    pub fn apply_private(window_number: u32) -> napi::Result<()> {
        apply_cgs(window_number, K_CGS_DO_NOT_SHARE)
    }

    pub fn remove_private(window_number: u32) -> napi::Result<()> {
        apply_cgs(window_number, K_CGS_NORMAL_SHARE)
    }

    unsafe fn find_window(window_number: u32) -> Option<id> {
        let app: id = msg_send![class!(NSApplication), sharedApplication];
        if app == nil {
            return None;
        }

        let windows: id = msg_send![app, windows];
        if windows == nil {
            return None;
        }

        let count: usize = msg_send![windows, count];
        for index in 0..count {
            let window: id = msg_send![windows, objectAtIndex: index];
            if window == nil {
                continue;
            }

            let current_window_number: isize = msg_send![window, windowNumber];
            if current_window_number == window_number as isize {
                return Some(window);
            }
        }

        None
    }

    fn apply_cgs(window_number: u32, sharing_state: i32) -> napi::Result<()> {
        unsafe {
            let connection_symbol = c"CGSMainConnectionID";
            let sharing_symbol = c"CGSSetWindowSharingState";

            let connection_ptr = dlsym(RTLD_DEFAULT, connection_symbol.as_ptr() as *const c_char);
            let sharing_ptr = dlsym(RTLD_DEFAULT, sharing_symbol.as_ptr() as *const c_char);

            if connection_ptr.is_null() || sharing_ptr.is_null() {
                eprintln!("[stealth] CGS private symbols unavailable; skipping private macOS stealth path");
                return Ok(());
            }

            let connection_fn: CGSMainConnectionIDFn = std::mem::transmute::<*mut c_void, CGSMainConnectionIDFn>(connection_ptr);
            let sharing_fn: CGSSetWindowSharingStateFn = std::mem::transmute::<*mut c_void, CGSSetWindowSharingStateFn>(sharing_ptr);

            let connection_id = connection_fn();
            let result = sharing_fn(connection_id, window_number as i32, sharing_state);
            if result != 0 {
                eprintln!("[stealth] CGSSetWindowSharingState failed with {}", result);
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
}

#[cfg(target_os = "windows")]
mod windows_impl {
    use super::Buffer;
    use windows::Win32::Foundation::{GetLastError, HWND};
    use windows::Win32::UI::WindowsAndMessaging::{
        SetWindowDisplayAffinity, WDA_MONITOR, WDA_NONE, WINDOW_DISPLAY_AFFINITY,
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
pub fn apply_windows_window_stealth(hwnd_buffer: Buffer) -> napi::Result<()> {
    windows_impl::apply(hwnd_buffer)
}

#[napi]
pub fn remove_windows_window_stealth(hwnd_buffer: Buffer) -> napi::Result<()> {
    windows_impl::remove(hwnd_buffer)
}
