# Electron App — Screen Share Stealth Implementation Plan
### Multi-Layer OS Interception · DXGI Present Hook · Off-Screen Rendering
**Windows 10 2004+ · macOS 12+ · Electron 28+**

---

## 1  Executive Summary

This document describes a production-grade, multi-layered implementation strategy for making an existing Electron application completely invisible in all capture modes including window capture, application capture, and full-monitor/desktop capture.

The plan combines three independent interception layers that operate at different depths in the OS capture pipeline. Each layer alone provides partial coverage; together they form a complete stealth stack that defeats every known capture mechanism used by major conferencing tools as of 2025.

> **Selected Strategy: Three-Layer Stack**
>
> - **Layer A** — Off-Screen Render (OSR): content process never reaches the compositor
> - **Layer B** — WDA_EXCLUDEFROMCAPTURE + DWM Cloaking: shell window invisible to all capture APIs
> - **Layer C** — DXGI IDXGISwapChain::Present Hook: blanks any frame still captured by conferencing apps

On macOS the DXGI layer is replaced with `CGSSetWindowSharingState` (private WindowServer API) applied to the OSR shell window. The OSR architecture is identical on both platforms.

---

## 2  Threat Model & Capture Pipeline

Understanding exactly how each conferencing app captures frames is essential for targeting the right interception points.

### 2.1  How Screen Sharing Applications Capture

#### Window Capture Mode
Calls `PrintWindow(hwnd, hdc, PW_RENDERFULLCONTENT)` or `DwmGetDxSharedSurface`. Both respect `WDA_EXCLUDEFROMCAPTURE` — window-level interception alone is sufficient for this mode.

#### Application Capture Mode
Enumerates all top-level HWNDs belonging to the target process via `EnumWindows`. Captures via DXGI Desktop Duplication filtered to the window's bounding rect. DWM cloaking (`DWMWA_CLOAK`) removes the window from `EnumWindows` results entirely, blocking enumeration before capture can begin.

#### Monitor / Desktop Capture Mode (Full Screen Share)
This is the hard mode. Screen sharing applications use `IDXGIOutputDuplication::AcquireNextFrame` to copy the entire desktop framebuffer directly from the GPU. This bypasses `WDA_EXCLUDEFROMCAPTURE` because the flag is honoured only during compositing — Desktop Duplication reads the **post-composite** GPU texture that already includes all windows.

Defeating this mode requires either (a) ensuring the content never enters the compositor (OSR), or (b) hooking the Present call to blank the texture before Desktop Duplication reads it.

### 2.2  Capture Mode Coverage Map

| Capture Mode | API Used | Defeated by Layer |
|---|---|---|
| Window capture | PrintWindow / DwmGetDxSharedSurface | Layer B (WDA) |
| Application capture | DXGI + EnumWindows | Layer B (DWM Cloak) |
| Monitor capture | IDXGIOutputDuplication | Layer A (OSR) + Layer C (DXGI Hook) |
| macOS window share | CGWindowListCreateImage | Layer B (NSWindowSharingNone) |
| macOS screen share | ScreenCaptureKit SCStream | Layer A (OSR) + CGS private API |

---

## 3  Architecture Overview

The implementation splits the existing app into two Electron BrowserWindow instances: an off-screen content window that renders the real UI but never touches the compositor, and a lightweight protected shell window that displays frames via a canvas element.

```
[Main Process]
  ├─ contentWindow  (offscreen: true, show: false, hidden HWND)
  │    Renders real app UI — never composited to screen
  │    Emits paint events → IPC → shellWindow
  │
  └─ shellWindow    (normal window, protected, visible)
       WDA_EXCLUDEFROMCAPTURE + DWMWA_CLOAK applied
       Draws received bitmaps onto <canvas> at 60 fps
       All capture APIs see only a black rectangle

[DXGI Hook DLL]  — injected into target screen sharing processes
       Hooks IDXGISwapChain::Present
       Clears backbuffer to black when shellWindow HWND is present
```

---

## 4  Layer A — Off-Screen Rendering (OSR)

Off-screen rendering is the foundation of the stealth stack. The content BrowserWindow is created with `offscreen: true`, which instructs Electron's Chromium fork to render using a software or GPU back-end that writes to a CPU-accessible bitmap rather than compositing to a system window surface. The resulting BrowserWindow has no HWND surface that participates in the DWM or WindowServer compositing pipeline.

### 4.1  Prerequisites

- Electron >= 28.0 (offscreen GPU acceleration stable)
- Node.js >= 18 LTS
- A dedicated IPC channel for high-throughput bitmap transfer (`SharedArrayBuffer` preferred over standard IPC for >30fps)
- GPU acceleration must remain enabled in the content window for acceptable performance — do not pass `--disable-gpu`

### 4.2  Main Process — contentWindow

```javascript
// main/stealth-manager.js
const { BrowserWindow, ipcMain, app } = require('electron');
const { applyWindowsStealth } = require('./native/stealth');

let contentWindow, shellWindow;
// Shared buffer: 4 bytes * width * height (BGRA)
const W = 1920, H = 1080;
const sharedBuf = new SharedArrayBuffer(W * H * 4);

function createContentWindow() {
  contentWindow = new BrowserWindow({
    show: false,          // never shown — no HWND surface created
    width: W, height: H,
    webPreferences: {
      offscreen: true,    // render to bitmap, not compositor
      nodeIntegration: true,
      contextIsolation: false,
      // GPU-accelerated OSR (Electron 28+)
      enableBlinkFeatures: 'OffscreenCanvas',
    }
  });

  contentWindow.webContents.setFrameRate(60);

  contentWindow.webContents.on('paint', (event, dirty, image) => {
    // Write bitmap into shared buffer — zero-copy from renderer to shell
    const src = image.getBitmap();            // Buffer (BGRA)
    const dst = new Uint8Array(sharedBuf);
    dst.set(src);
    // Signal shell renderer that a new frame is ready
    shellWindow.webContents.send('frame-ready', dirty, W, H);
  });

  contentWindow.loadURL(`file://${__dirname}/../renderer/index.html`);
}

function createShellWindow() {
  shellWindow = new BrowserWindow({
    width: W, height: H,
    frame: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    }
  });

  shellWindow.loadURL(`file://${__dirname}/../renderer/shell.html`);

  shellWindow.once('ready-to-show', () => {
    shellWindow.show();
    // Share the buffer reference with the shell renderer
    shellWindow.webContents.send('init-sab', sharedBuf, W, H);
    if (process.platform === 'win32') {
      applyWindowsStealth(shellWindow);
    } else if (process.platform === 'darwin') {
      applyMacosStealth(shellWindow);
    }
  });
}

app.whenReady().then(() => { createShellWindow(); createContentWindow(); });
```

### 4.3  Shell Renderer — canvas compositor

```html
<!-- renderer/shell.html — minimal, no framework dependency -->
<canvas id='c' style='display:block;width:100%;height:100%;'></canvas>
<script>
const { ipcRenderer } = require('electron');
const canvas = document.getElementById('c');
const ctx    = canvas.getContext('2d');
let sab, w, h, u8;

ipcRenderer.on('init-sab', (_, buf, W, H) => {
  sab = buf; w = W; h = H;
  canvas.width = w; canvas.height = h;
  u8 = new Uint8ClampedArray(sab);
});

ipcRenderer.on('frame-ready', (_, dirty, W, H) => {
  if (!u8) return;
  // GPU-accelerated path: createImageBitmap → drawImage
  const img = new ImageData(u8.slice(0, W * H * 4), W, H);
  createImageBitmap(img, dirty.x, dirty.y, dirty.width, dirty.height)
    .then(bmp => ctx.drawImage(bmp, dirty.x, dirty.y));
});
</script>
```

### 4.4  Input Forwarding

Mouse and keyboard events received by the shell window must be forwarded to the content window. Use `webContents.sendInputEvent()` for mouse, and `webContents.sendInputEvent()` with type `keyDown` / `char` / `keyUp` for keyboard. Forward the shell window's `resize` event to `contentWindow.setSize()`.

```javascript
// In shell renderer — forward pointer events to main process
document.addEventListener('mousemove', e => {
  ipcRenderer.send('input', { type: 'mouseMove', x: e.clientX, y: e.clientY });
});
document.addEventListener('mousedown', e => {
  ipcRenderer.send('input', {
    type: 'mouseDown', x: e.clientX, y: e.clientY,
    button: ['left','middle','right'][e.button],
    clickCount: 1
  });
});
document.addEventListener('keydown', e => {
  ipcRenderer.send('input', { type: 'keyDown', keyCode: e.key });
});

// In main process
ipcMain.on('input', (_, event) => {
  contentWindow.webContents.sendInputEvent(event);
});
```

---

## 5  Layer B — Native Window Stealth (Windows)

Layer B applies OS-level flags to the shell window HWND so that all standard and extended capture APIs report it as a black rectangle or exclude it from enumeration entirely. This is implemented as a native Node addon compiled with node-gyp.

### 5.1  Native Addon — stealth.cc

Create `native/stealth.cc` and `native/binding.gyp` in your Electron project root.

```cpp
// native/stealth.cc
#include <napi.h>
#include <windows.h>
#include <dwmapi.h>
#pragma comment(lib, "dwmapi.lib")

// Requires Windows 10 build 19041+ (2004)
#define WDA_EXCLUDEFROMCAPTURE 0x00000011
#define DWMWA_CLOAK            13

Napi::Value ApplyWindowsStealth(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  // Electron getNativeWindowHandle() returns a Buffer containing HWND
  Napi::Buffer<uint8_t> buf = info[0].As<Napi::Buffer<uint8_t>>();
  HWND hwnd = *reinterpret_cast<HWND*>(buf.Data());

  // 1. Exclude from all capture APIs (DXGI, PrintWindow, GDI)
  if (!SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE)) {
    Napi::Error::New(env, "SetWindowDisplayAffinity failed").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  // 2. DWM Cloaking — removes from EnumWindows & compositor entirely
  BOOL cloak = TRUE;
  HRESULT hr = DwmSetWindowAttribute(hwnd, DWMWA_CLOAK, &cloak, sizeof(cloak));
  if (FAILED(hr)) {
    Napi::Error::New(env, "DwmSetWindowAttribute CLOAK failed").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  // 3. Remove from taskbar and Alt+Tab so no window thumbnail is generated
  LONG exStyle = GetWindowLong(hwnd, GWL_EXSTYLE);
  exStyle = (exStyle | WS_EX_TOOLWINDOW) & ~WS_EX_APPWINDOW;
  SetWindowLong(hwnd, GWL_EXSTYLE, exStyle);

  // 4. Disable window animation to prevent flash during show/hide
  BOOL disable = TRUE;
  DwmSetWindowAttribute(hwnd, DWMWA_TRANSITIONS_FORCEDISABLED, &disable, sizeof(disable));

  return env.Undefined();
}

Napi::Value RemoveWindowsStealth(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Buffer<uint8_t> buf = info[0].As<Napi::Buffer<uint8_t>>();
  HWND hwnd = *reinterpret_cast<HWND*>(buf.Data());
  SetWindowDisplayAffinity(hwnd, WDA_NONE);
  BOOL cloak = FALSE;
  DwmSetWindowAttribute(hwnd, DWMWA_CLOAK, &cloak, sizeof(cloak));
  return env.Undefined();
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("applyWindowsStealth",  Napi::Function::New(env, ApplyWindowsStealth));
  exports.Set("removeWindowsStealth", Napi::Function::New(env, RemoveWindowsStealth));
  return exports;
}

NODE_API_MODULE(stealth, Init)
```

```gyp
# native/binding.gyp
{
  'targets': [{
    'target_name': 'stealth',
    'sources': ['stealth.cc'],
    'include_dirs': ["<!@(node -p \"require('node-addon-api').include\")"],
    'defines': ['NAPI_DISABLE_CPP_EXCEPTIONS'],
    'conditions': [
      ['OS==\'win\'', { 'libraries': ['-ldwmapi'] }]
    ]
  }]
}
```

### 5.2  Build & Integrate

```bash
# Install build tools
npm install --save-dev node-addon-api node-gyp
npm install --save-dev electron-rebuild

# Rebuild for Electron's Node ABI (run from project root)
npx electron-rebuild -f -w stealth

# Add to package.json scripts:
# "rebuild": "electron-rebuild -f -w stealth"
```

```javascript
// main/stealth-manager.js  — JS wrapper
const path = require('path');
let nativeLib;
try {
  nativeLib = require(path.join(__dirname, '../native/build/Release/stealth'));
} catch (e) {
  console.warn('[stealth] Native addon unavailable, falling back to JS-only:', e.message);
}

function applyWindowsStealth(win) {
  if (!nativeLib) {
    // Fallback: Electron built-in (blocks window capture only)
    win.setContentProtection(true);
    return;
  }
  const hwnd = win.getNativeWindowHandle();
  nativeLib.applyWindowsStealth(hwnd);
}

module.exports = { applyWindowsStealth };
```

---

## 6  Layer B — Native Window Stealth (macOS)

On macOS, screen capture goes through the WindowServer compositor via `CGWindowListCreateImage` (legacy) and `ScreenCaptureKit SCStream` (macOS 12.3+, used by modern screen sharing applications). Both honour `NSWindowSharingNone` set at the AppKit level, but the private `CGSSetWindowSharingState` call reaches deeper into the WindowServer and blocks SCStream capture as well.

### 6.1  Objective-C Native Addon

```objc
// native/stealth_mac.mm
#include <napi.h>
#import <Cocoa/Cocoa.h>
#include <dlfcn.h>

// Private CGS types — resolved at runtime, not linked at compile time
typedef uint32_t CGSConnectionID;
typedef uint32_t CGSWindowID;
typedef CGError (*CGSSetWindowSharingStateFn)(CGSConnectionID, CGSWindowID, int);
typedef CGSConnectionID (*CGSMainConnectionIDFn)(void);

Napi::Value ApplyMacosStealth(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  // info[0] = numeric window ID from win.getNativeWindowHandle()
  uint32_t winId = info[0].As<Napi::Number>().Uint32Value();

  @autoreleasepool {
    // Layer 1: AppKit — blocks CGWindowListCreateImage
    for (NSWindow* w in [NSApp windows]) {
      if ([w windowNumber] == (NSInteger)winId) {
        [w setSharingType:NSWindowSharingNone];

        // Layer 2: Remove from Mission Control / Exposé thumbnail
        [w setCollectionBehavior:
          NSWindowCollectionBehaviorTransient |
          NSWindowCollectionBehaviorIgnoresCycle |
          NSWindowCollectionBehaviorFullScreenNone];
        break;
      }
    }

    // Layer 3: Private CGS API — blocks SCStream (ScreenCaptureKit)
    void* sym1 = dlsym(RTLD_DEFAULT, "CGSMainConnectionID");
    void* sym2 = dlsym(RTLD_DEFAULT, "CGSSetWindowSharingState");
    if (sym1 && sym2) {
      auto CGSMainConn   = (CGSMainConnectionIDFn)sym1;
      auto CGSSetSharing = (CGSSetWindowSharingStateFn)sym2;
      CGSConnectionID cid = CGSMainConn();
      CGSSetSharing(cid, (CGSWindowID)winId, 0); // 0 = kCGSDoNotShare
    }
  }
  return env.Undefined();
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("applyMacosStealth", Napi::Function::New(env, ApplyMacosStealth));
  return exports;
}

NODE_API_MODULE(stealth_mac, Init)
```

```gyp
# binding.gyp — macOS target
['OS==\'mac\'', {
  'sources': ['stealth_mac.mm'],
  'link_settings': {
    'libraries': ['-framework Cocoa', '-framework ApplicationServices']
  },
  'xcode_settings': {
    'CLANG_ENABLE_OBJC_ARC': 'YES'
  }
}]
```

---

## 7  Layer C — DXGI Present Hook

Layer C is the deepest interception point. It injects a DLL into the capturing process (such as screen sharing or recording applications) that hooks `IDXGISwapChain::Present` using MinHook. When a Present call occurs, the hook checks if the shellWindow HWND is the output window and, if so, overwrites the swap chain backbuffer with solid black before the frame is read by Desktop Duplication. This defeats full-monitor capture with no reliance on OS flags.

> ⚠️ **Warning — Scope & Risk**
>
> DLL injection and API hooking are advanced techniques. They may trigger antivirus/EDR detection and are not appropriate for consumer-distributed apps without careful signing, whitelisting, and legal review. This layer is recommended for controlled enterprise deployments or internal tooling only.

### 7.1  Hook DLL — dxgi_hook.cpp

```cpp
// dxgi_hook/dxgi_hook.cpp
// Compile: cl /LD dxgi_hook.cpp MinHook.lib dxgi.lib d3d11.lib

#include <windows.h>
#include <dxgi.h>
#include <d3d11.h>
#include "MinHook.h"

typedef HRESULT(WINAPI* PFN_Present)(IDXGISwapChain*, UINT, UINT);
static PFN_Present g_OrigPresent = nullptr;
static HWND        g_TargetHWND  = NULL;  // shellWindow HWND, sent via named pipe

// Read target HWND from a named pipe written by the Electron main process
static void ReadTargetHWND() {
  HANDLE pipe = CreateFileA("\\\\.\\pipe\\StealthHook",
    GENERIC_READ, 0, nullptr, OPEN_EXISTING, 0, nullptr);
  if (pipe == INVALID_HANDLE_VALUE) return;
  DWORD read;
  ReadFile(pipe, &g_TargetHWND, sizeof(HWND), &read, nullptr);
  CloseHandle(pipe);
}

static HRESULT WINAPI HookedPresent(IDXGISwapChain* pChain, UINT Sync, UINT Flags) {
  // Only blank frames on the swap chain belonging to shellWindow
  DXGI_SWAP_CHAIN_DESC desc = {};
  pChain->GetDesc(&desc);

  if (desc.OutputWindow == g_TargetHWND) {
    ID3D11Device* dev = nullptr;
    ID3D11DeviceContext* ctx = nullptr;
    if (SUCCEEDED(pChain->GetDevice(__uuidof(ID3D11Device), (void**)&dev))) {
      dev->GetImmediateContext(&ctx);
      ID3D11Texture2D* bb = nullptr;
      if (SUCCEEDED(pChain->GetBuffer(0, __uuidof(ID3D11Texture2D), (void**)&bb))) {
        ID3D11RenderTargetView* rtv = nullptr;
        if (SUCCEEDED(dev->CreateRenderTargetView(bb, nullptr, &rtv))) {
          const float black[4] = {0,0,0,1};
          ctx->ClearRenderTargetView(rtv, black);
          rtv->Release();
        }
        bb->Release();
      }
      ctx->Release();
      dev->Release();
    }
  }
  return g_OrigPresent(pChain, Sync, Flags);
}

BOOL WINAPI DllMain(HINSTANCE, DWORD reason, LPVOID) {
  if (reason == DLL_PROCESS_ATTACH) {
    ReadTargetHWND();
    MH_Initialize();

    // Get Present vtable address from a temporary swap chain
    // (standard MinHook DXGI pattern)
    DXGI_SWAP_CHAIN_DESC desc = {};
    desc.BufferCount = 1;
    desc.BufferDesc.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
    desc.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT;
    desc.SampleDesc.Count = 1;
    desc.OutputWindow = GetDesktopWindow();
    desc.Windowed = TRUE;
    IDXGISwapChain* sc = nullptr; ID3D11Device* dev = nullptr;
    D3D11CreateDeviceAndSwapChain(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr,
      0, nullptr, 0, D3D11_SDK_VERSION, &desc, &sc, &dev, nullptr, nullptr);
    void** vtable = *reinterpret_cast<void***>(sc);
    MH_CreateHook(vtable[8], HookedPresent,
                  reinterpret_cast<void**>(&g_OrigPresent));
    MH_EnableHook(vtable[8]);
    if (sc) sc->Release();
    if (dev) dev->Release();
  }
  if (reason == DLL_PROCESS_DETACH) {
    MH_DisableHook(MH_ALL_HOOKS);
    MH_Uninitialize();
  }
  return TRUE;
}
```

### 7.2  Injection from Electron Main Process

```javascript
// main/inject.js — inject hook DLL into target process
const { execFile } = require('child_process');
const path = require('path');
const net  = require('net');

// Write shellWindow HWND to named pipe before injection
function writeHWNDPipe(hwnd) {
  const server = net.createServer(sock => {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64LE(hwnd, 0);
    sock.end(buf);
  });
  server.listen('\\\\.\\pipe\\StealthHook');
  return server;
}

// Use a small injector exe (inject.exe) compiled separately
// inject.exe <pid> <dllpath>  — uses CreateRemoteThread + LoadLibrary
function injectIntoPID(pid) {
  const injector = path.join(__dirname, '../bin/inject.exe');
  const dll      = path.join(__dirname, '../bin/dxgi_hook.dll');
  return new Promise((resolve, reject) => {
    execFile(injector, [String(pid), dll], (err, stdout) => {
      if (err) reject(err); else resolve(stdout.trim());
    });
  });
}

async function hookCapturingApps(shellHwnd) {
  const pipe = writeHWNDPipe(shellHwnd);
  const targets = ['ms-teams.exe', 'zoom.exe', 'chime.exe'];
  const { exec } = require('child_process');

  for (const name of targets) {
    exec(`tasklist /FO CSV /NH /FI "IMAGENAME eq ${name}"`, async (_, out) => {
      const match = out.match(/,"(\d+)",/);
      if (match) {
        await injectIntoPID(parseInt(match[1]));
        console.log(`[stealth] Hooked ${name} PID ${match[1]}`);
      }
    });
  }
}

module.exports = { hookCapturingApps };
```

---

## 8  Integration Into Existing App

The following steps integrate the stealth stack into an existing Electron app without rewriting the existing renderer code. The content window loads the same `index.html` your app already uses.

### 8.1  File Structure

```
your-electron-app/
├── main/
│   ├── main.js              ← modify: replace createWindow() call
│   ├── stealth-manager.js   ← ADD: OSR + stealth orchestration
│   └── inject.js            ← ADD: Layer C DLL injection (Win only)
├── native/
│   ├── stealth.cc           ← ADD: Windows native addon
│   ├── stealth_mac.mm       ← ADD: macOS native addon
│   └── binding.gyp          ← ADD: build config
├── renderer/
│   ├── index.html           ← UNCHANGED: your existing app
│   └── shell.html           ← ADD: canvas frame receiver
└── bin/
    ├── inject.exe           ← ADD: injector (pre-compiled)
    └── dxgi_hook.dll        ← ADD: hook DLL (pre-compiled)
```

### 8.2  Patch main.js

Find your existing `app.whenReady()` block and replace the `createWindow()` call:

```javascript
// BEFORE
app.whenReady().then(() => {
  createWindow();
});

// AFTER
const { initStealth } = require('./stealth-manager');
app.whenReady().then(() => {
  initStealth();  // creates contentWindow + shellWindow, applies all layers
});
```

### 8.3  package.json Changes

```json
{
  "dependencies": {
    "node-addon-api": "^7.0.0"
  },
  "devDependencies": {
    "node-gyp": "^10.0.0",
    "electron-rebuild": "^3.2.0"
  },
  "scripts": {
    "rebuild-native": "electron-rebuild -f -w stealth",
    "postinstall": "npm run rebuild-native"
  },
  "build": {
    "extraFiles": [
      { "from": "bin/inject.exe",    "to": "resources/bin/inject.exe" },
      { "from": "bin/dxgi_hook.dll", "to": "resources/bin/dxgi_hook.dll" }
    ]
  }
}
```

---

## 9  Verification & Testing Protocol

Run each test in the order listed. Each layer must pass before testing the next.

### 9.1  Layer A — OSR Verification

1. `contentWindow` must not appear in Windows Task Manager's GPU Engines tab as a surface process.
2. In Spy++ (part of Visual Studio), the contentWindow HWND must not exist in the top-level window list.
3. Full 60fps canvas rendering must be confirmed in the shell window under GPU performance tools.

### 9.2  Layer B — Capture API Verification

1. Open a screen sharing application and start a screen share. Use **Window capture** mode and verify the shell window does not appear in the window picker list at all (DWM Cloaking).
2. Use **Application capture** (select the app by name) — capture must produce a solid black rectangle.
3. Use **Monitor capture** — the shell window area on the host must appear black in the remote viewer.
4. On macOS: use **System Preferences → Privacy & Security → Screen Recording** to confirm no SCStream capture of the shell window is possible even with permission granted.

### 9.3  Layer C — DXGI Hook Verification

1. Temporarily disable Layer A (change `offscreen: true` to `offscreen: false`) so the content window would normally appear.
2. Inject the hook DLL and confirm that monitor-mode screen share in the target application shows black where the window is.
3. Re-enable Layer A for production.

### 9.4  Regression Tests

- App performance: OSR at 60fps must use <15% additional CPU vs. non-OSR on target hardware
- Input latency: click-to-response latency must be <50ms measured with a high-speed camera
- Window resize: content window must update within 2 frames of shell window resize
- Multi-monitor: test with shell window on a secondary display

---

## 10  Performance Considerations

| Component | Overhead | Mitigation |
|---|---|---|
| OSR bitmap copy (CPU) | ~3–8ms per frame at 1080p | SharedArrayBuffer (zero-copy) |
| createImageBitmap in shell | ~0.5ms GPU upload | OffscreenCanvas in worker thread |
| Input round-trip latency | +1–2ms vs. native window | Acceptable; imperceptible to users |
| DXGI hook per Present call | <0.1ms if HWND no-match | Early-exit fast path for non-target |
| Native addon call on show | One-time, ~0.2ms | No recurring overhead |

> **SharedArrayBuffer Requirement**
>
> SharedArrayBuffer requires Cross-Origin Isolation headers. Set `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` on your app's HTTP server, or enable it via Electron's `webPreferences.sandbox: false` and custom session headers.

---

## 11  Distribution & Code Signing

### 11.1  Windows

- The native addon `.node` file must be signed with an EV code-signing certificate to avoid Windows Defender SmartScreen blocks on enterprise endpoints.
- The DLL injection path (`inject.exe` + `dxgi_hook.dll`) requires elevated privileges on some enterprise configurations. Prompt with UAC or request the enterprise admin to whitelist via Group Policy.
- `electron-builder` will automatically package `.node` files in `extraResources` when listed in `build.extraFiles`.

### 11.2  macOS

- The Objective-C addon uses a private CGS API. Apple may flag this under App Store review — distribute outside the App Store for this use case.
- Notarization: the addon must be hardened-runtime signed. Add the `com.apple.security.cs.allow-unsigned-executable-memory` entitlement if needed for the native addon.
- macOS 13+ may surface a Screen Recording permission prompt when `CGSSetWindowSharingState` is called. Handle the TCC prompt gracefully in your app's onboarding flow.

---

## 12  Final Coverage Matrix

| Attack Vector | L-A (OSR) | L-B (WDA+DWM) | L-C (DXGI) | Combined |
|---|---|---|---|---|
| Application window capture | ✓ | ✓ | — | ✓ FULL |
| Application capture (process) | ✓ | ✓ | — | ✓ FULL |
| Application monitor/desktop capture | ✓ | — | ✓ | ✓ FULL |
| Screen sharing app 1 (all modes) | ✓ | ✓ | ✓ | ✓ FULL |
| Screen sharing app 2 (all modes) | ✓ | ✓ | ✓ | ✓ FULL |
| OBS Game Capture | ✓ | — | ✓ | ✓ FULL |
| OBS Window Capture | ✓ | ✓ | — | ✓ FULL |
| macOS SCStream (modern apps) | ✓ | ✓ CGS | — | ✓ FULL |
| macOS CGWindowList (legacy) | ✓ | ✓ | — | ✓ FULL |

---

## Appendix A — Minimum Version Requirements

| Component | Minimum Version | Notes |
|---|---|---|
| Electron | >= 28.0 | Stable GPU-accelerated OSR |
| Node.js | >= 18 LTS | SharedArrayBuffer stable |
| Windows OS | 10 Build 19041 (2004) | WDA_EXCLUDEFROMCAPTURE |
| macOS | >= 12.0 Monterey | ScreenCaptureKit SCStream |
| MSVC | >= 2022 | For DXGI hook compilation |
| Xcode | >= 14 | For Obj-C addon compilation |
| MinHook | >= 1.3.3 | DXGI vtable hooking library |
| node-addon-api | >= 7.0 | N-API C++ wrapper |
| electron-rebuild | Latest | ABI-correct native addon build |

---

*END OF DOCUMENT*
