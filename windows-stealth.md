# Windows 11 Bulletproof Stealth Implementation Plan

## The Problem
On macOS, `NSPanel` allows a window to receive clicks and keyboard input *without* becoming the active OS application, preventing `blur` events in the browser. 
Windows does not have a direct equivalent. By default, clicking or typing into an Electron `BrowserWindow` on Windows forces the OS to activate it, causing the browser (Chrome/HackerRank) to lose focus and fire a detectable `blur` event.

## The Solution: OS-Level Hooks & `WS_EX_NOACTIVATE`
To achieve 100% "blur-proof" stealth on Windows, we must strip the overlay's ability to receive OS focus completely, and manually route interactions into the app using native OS hooks. 

### Phase 1: Prevent OS Activation (`WS_EX_NOACTIVATE`)
We must apply the `WS_EX_NOACTIVATE` extended window style to the overlay. This tells Windows: "Do not make this window the active foreground window, even if it is clicked."
1. **Electron Level:** Set `focusable: false` on the `BrowserWindow`.
2. **Native Level (Rust/C++):** Use the `SetWindowLongPtr` API to inject `WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW` into the window's `GWL_EXSTYLE`.
*Result: The window will visually appear over the browser, and the user can click it, but Chrome will remain the active window. No `blur` event will fire.*

### Phase 2: Input Interception (Low-Level Hooks)
Because a `WS_EX_NOACTIVATE` window cannot natively receive keyboard focus, normal HTML `<input>` fields will not work. We must capture input *before* it reaches the OS focus system.
1. Implement a **Low-Level Keyboard Hook (`WH_KEYBOARD_LL`)** in our native module (Rust or C++).
2. Implement a **Low-Level Mouse Hook (`WH_MOUSE_LL`)**.
3. When the Natively overlay is open, these hooks intercept all keyboard and mouse events.
4. If an event occurs within the overlay's bounds, the native hook **swallows** the event (preventing the browser from seeing it) and forwards it directly to the Electron Main Process via IPC.

### Phase 3: Simulated Interaction (Frontend)
Since the Electron renderer won't receive native focus events, we must manually simulate typing and clicking inside the React app.
1. The Electron Main Process receives intercepted keystrokes from the Rust hook.
2. The Main Process forwards these keys to the React renderer via `webContents.send('injected-keystroke', key)`.
3. A React hook listens for these IPC messages and manually appends the characters to our chat/input state, completely bypassing DOM focus mechanics.

### Phase 4: Invisible Cursor (Optional but Recommended)
When interacting with the overlay, the user's cursor technically still belongs to the browser.
1. When the mouse enters the overlay bounds, the native hook can temporarily hide the OS cursor and render a fake "software cursor" inside the React app. This prevents the browser from detecting hovering over non-browser elements.

---

## Architectural Breakdown

### 1. `electron/stealth/windowsNativeBindings.rs` (Native Addon)
- Expand the existing Windows stealth module.
- Add `install_keyboard_hook()` and `install_mouse_hook()`.
- Send intercepted inputs to Node via Thread-safe N-API callbacks.

### 2. `electron/WindowHelper.ts`
- Ensure Windows overlay is initialized with `focusable: false`.
- Call `nativeModule.applyNoActivate(windowHandle)`.
- Add IPC listeners to forward native inputs to the React renderer.

### 3. `src/components/NativelyInterface.tsx`
- Build a synthetic input system. Instead of `<input onChange={...} />`, use a visual text block that updates its string based on the `window.electron.onInjectedKeystroke` listener.

## Risk Assessment & Caveats
- **Antivirus Flags:** Low-Level hooks (`WH_KEYBOARD_LL`) are common techniques used by keyloggers. Code signing (which we already do) is mandatory to prevent Windows Defender from flagging the app.
- **Hook Latency:** Hooks run synchronously in the OS message loop. If our hook handler blocks for too long, Windows will forcibly remove the hook. All IPC routing must be asynchronous and extremely lightweight.

## Execution
This implementation requires touching the Native Rust layers, the Electron Main process, and the React Frontend. Once implemented, the application will be 100% invisible on Windows 11, both visually (via `WDA_EXCLUDEFROMCAPTURE`) and behaviorally (via hooks).
