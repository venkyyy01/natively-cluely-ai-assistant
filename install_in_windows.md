# Natively — Complete Build & Install Guide for Windows

A step-by-step guide to build and install **Natively AI Assistant** from source on **Windows 10/11**.

---

## Table of Contents

- [System Requirements](#system-requirements)
- [Step 1: Install Prerequisites](#step-1-install-prerequisites)
  - [1.1 Node.js v20+](#11-nodejs-v20)
  - [1.2 Git](#12-git)
  - [1.3 Visual Studio Build Tools](#13-visual-studio-build-tools)
  - [1.4 Python 3.x](#14-python-3x)
  - [1.5 Rust (Optional)](#15-rust-optional)
  - [1.6 Verify All Installations](#16-verify-all-installations)
- [Step 2: Clone the Repository](#step-2-clone-the-repository)
- [Step 3: Install Dependencies](#step-3-install-dependencies)
- [Step 4: Configure Environment Variables](#step-4-configure-environment-variables)
- [Step 5: Run in Development Mode](#step-5-run-in-development-mode)
- [Step 6: Build for Production](#step-6-build-for-production)
- [Step 7: Install the Built Application](#step-7-install-the-built-application)
- [Step 8: Building the Rust Native Audio Module (Optional)](#step-8-building-the-rust-native-audio-module-optional)
- [Running Tests](#running-tests)
- [Troubleshooting](#troubleshooting)
- [Build Outputs Reference](#build-outputs-reference)
- [Available npm Scripts](#available-npm-scripts)

---

## System Requirements

| Requirement | Minimum | Recommended |
| :--- | :--- | :--- |
| **OS** | Windows 10 (64-bit) | Windows 11 (64-bit) |
| **RAM** | 4 GB | 8 GB+ (16 GB+ for local AI with Ollama) |
| **Disk Space** | 2 GB free | 5 GB+ (with local models) |
| **Architecture** | x64 or ia32 | x64 |

---

## Step 1: Install Prerequisites

### 1.1 Node.js v20+

1. Download the **LTS installer** (v20.x or later) from [https://nodejs.org](https://nodejs.org)
2. Run the `.msi` installer
3. **Important:** On the "Tools for Native Modules" screen, check **"Automatically install the necessary tools"** (this installs Chocolatey, Python, and Visual Studio Build Tools automatically via `windows-build-tools`)
4. Complete the installation

Verify:

```powershell
node -v    # Should print v20.x.x or higher
npm -v     # Should print 9.x.x or higher
```

> **Note:** If you already have Node.js installed but it's older than v20, update it by downloading the latest LTS from nodejs.org.

### 1.2 Git

1. Download Git from [https://git-scm.com/download/win](https://git-scm.com/download/win)
2. Run the installer with default settings
3. During setup, choose **"Git from the command line and also from 3rd-party software"**

Verify:

```powershell
git --version    # Should print git version 2.x.x
```

### 1.3 Visual Studio Build Tools

Required for compiling native Node.js modules (`better-sqlite3`, `sharp`, `sqlite3`, `keytar`).

**Option A — Standalone Build Tools (recommended if you don't need full Visual Studio):**

1. Download **Visual Studio Build Tools** from [https://visualstudio.microsoft.com/visual-cpp-build-tools/](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
2. Run the installer
3. Select the **"Desktop development with C++"** workload
4. Make sure these components are checked:
   - MSVC v143 - VS 2022 C++ x64/x86 build tools
   - Windows 10/11 SDK
   - C++ CMake tools for Windows
5. Click **Install** and wait for completion (~2-5 GB download)

**Option B — Full Visual Studio (if you already have it):**

1. Open Visual Studio Installer
2. Modify your installation
3. Enable **"Desktop development with C++"** workload

**Option C — Automatic via npm (if you checked "Automatically install the necessary tools" during Node.js install):**

```powershell
npm install --global windows-build-tools
```

> **Note:** This command may take 10-20 minutes as it downloads Visual Studio Build Tools and Python.

Verify:

```powershell
# After installation, verify cl.exe is accessible
where cl
# Should show: C:\Program Files (x86)\Microsoft Visual Studio\...\cl.exe
```

### 1.4 Python 3.x

Required for `node-gyp` (compiles native C++ addons).

1. Download Python 3.x from [https://python.org](https://python.org)
2. Run the installer
3. **Critical:** Check **"Add Python to PATH"** at the bottom of the first screen
4. Click "Install Now"

> **Note:** If you used Option A or C for Visual Studio Build Tools, Python may already be installed. Verify with `python --version`.

Verify:

```powershell
python --version    # Should print Python 3.x.x
pip --version       # Should print pip 23.x.x or higher
```

### 1.5 Rust (Optional)

**Only needed if you want to rebuild the native audio capture module.** Pre-built binaries are included for Windows x64.

1. Download `rustup-init.exe` from [https://rustup.rs](https://rustup.rs)
2. Run `rustup-init.exe`
3. Press **Enter** to accept the default installation (MSVC toolchain)
4. Wait for installation to complete
5. **Close and reopen** your terminal/PowerShell

Verify:

```powershell
rustc --version    # Should print rustc 1.x.x
cargo --version    # Should print cargo 1.x.x
```

### 1.6 Verify All Installations

Run this in a **new PowerShell or Command Prompt** window:

```powershell
node -v              # v20.x.x+
npm -v               # 9.x.x+
git --version        # 2.x.x+
python --version     # 3.x.x+
where cl             # Should show cl.exe path

# Optional (only if Rust installed):
rustc --version      # 1.x.x
cargo --version      # 1.x.x
```

> **Important:** If any command is not found, **close and reopen** your terminal. If it still fails, check that the tool was added to your system PATH.

---

## Step 2: Clone the Repository

```powershell
git clone https://github.com/evinjohnn/natively-cluely-ai-assistant.git
cd natively-cluely-ai-assistant
```

---

## Step 3: Install Dependencies

```powershell
npm install
```

This command does several things automatically (via `postinstall`):
- Rebuilds native Electron dependencies (`better-sqlite3`, `sharp`, `sqlite3`, `keytar`)
- Downloads required ML models (Whisper, Tesseract language data)
- Ensures `sqlite-vec` binary is available

**This may take 3-10 minutes** depending on your internet speed and machine.

> **If `npm install` fails on native modules**, see [Troubleshooting](#troubleshooting) below.

---

## Step 4: Configure Environment Variables

Create a `.env` file in the project root with your API keys. You need **at least one AI provider** to use the app.

```powershell
# PowerShell — create .env file
@"
# === AI Providers (at least one required) ===

# Google Gemini (recommended for best speed/cost balance)
GEMINI_API_KEY=your_gemini_key_here

# OpenAI
# OPENAI_API_KEY=your_openai_key_here

# Anthropic Claude
# CLAUDE_API_KEY=your_anthropic_key_here

# Groq (fastest inference)
# GROQ_API_KEY=your_groq_key_here

# === Speech-to-Text Provider (at least one recommended) ===

# Deepgram (recommended)
DEEPGRAM_API_KEY=your_deepgram_key_here

# Google Cloud Speech-to-Text
# GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json

# === Default Model ===
DEFAULT_MODEL=gemini-3.1-flash-lite-preview

# === Ollama (100% offline — no API keys needed) ===
# USE_OLLAMA=true
# OLLAMA_MODEL=llama3.2
# OLLAMA_URL=http://localhost:11434
"@ | Out-File -FilePath .env -Encoding utf8
```

Edit the `.env` file to add your actual API keys:

```powershell
notepad .env
```

> **Free option:** Install [Ollama](https://ollama.ai), uncomment the Ollama lines in `.env`, and set `USE_OLLAMA=true`. No API keys needed — everything runs 100% locally.

---

## Step 5: Run in Development Mode

```powershell
npm start
```

This starts:
1. **Vite dev server** on `http://localhost:5180` (React frontend with hot reload)
2. **Electron app** (automatically launched once Vite is ready)

The app window should appear. Changes to the React frontend hot-reload automatically. Changes to the Electron main process (`electron/`) require restarting.

> **Tip:** Use `Ctrl+C` in the terminal to stop both the dev server and Electron.

---

## Step 6: Build for Production

### Full Production Build

```powershell
npm run dist
```

This executes the following pipeline:
```
npm run clean                       → Removes dist/ and dist-electron/
tsc                                 → Compiles TypeScript (React frontend)
vite build                          → Bundles frontend into dist/
npm run build:native                → Builds Rust native audio module (all platforms)
tsc -p electron/tsconfig.json       → Compiles Electron main process into dist-electron/
electron-builder                    → Packages everything into Windows installer
```

### Build for Specific Architecture

```powershell
# x64 only (most common — 64-bit Windows)
npx electron-builder --win --x64

# ia32 only (32-bit Windows)
npx electron-builder --win --ia32
```

### Build Without Rust Native Module

If you don't have Rust installed and the build fails on the native module step:

```powershell
# Build everything except the native module
npm run clean && tsc && vite build && tsc -p electron/tsconfig.json && npx electron-builder --win --x64
```

The app will fall back to JavaScript-based audio processing if the native module is unavailable.

Build output appears in the `release/` directory:

```
release/
├── Natively Setup 2.0.9.exe          # NSIS installer
├── Natively 2.0.9.exe                # Portable executable (single file)
└── win-unpacked/                     # Unpacked application directory
    ├── Natively.exe
    ├── resources/
    └── ...
```

---

## Step 7: Install the Built Application

### Option A — NSIS Installer (Recommended)

```powershell
.\release\"Natively Setup 2.0.9.exe"
```

- Follows the setup wizard
- Choose your install directory
- Creates Start Menu and Desktop shortcuts
- Registered in Windows "Add or Remove Programs"

### Option B — Portable Executable

```powershell
# Copy to Desktop
copy release\"Natively 2.0.9.exe" "%USERPROFILE%\Desktop\"
```

Double-click to run — no installation needed.

### Option C — Run From Unpacked Directory

```powershell
.\release\win-unpacked\Natively.exe
```

### Windows SmartScreen Warning

Since the app is not signed with a paid code signing certificate, Windows SmartScreen may block it on first run:

1. Click **"More info"**
2. Click **"Run anyway"**

This only appears the first time you run the app.

### Grant Microphone Permission

Windows will prompt for microphone access on first use. Click **"Allow"** for live transcription to work.

---

## Step 8: Building the Rust Native Audio Module (Optional)

The native Rust module provides low-latency system audio and microphone capture. Pre-built binaries are included, so this step is only needed if you want to modify or rebuild the audio module.

### Prerequisites

- Rust installed ([Step 1.5](#15-rust-optional))
- Visual Studio Build Tools installed ([Step 1.3](#13-visual-studio-build-tools))

### Build for Current Platform (Windows x64)

```powershell
npm run build:native:current
```

### Build for All Platforms

```powershell
npm run build:native
```

> **Note:** Cross-compilation to macOS targets requires additional toolchain setup and is typically done on the target platform.

### Windows-Specific Dependencies

The Rust module uses these Windows-specific crates (defined in `native-module/Cargo.toml`):

| Crate | Purpose |
| :--- | :--- |
| `wasapi` 0.13.0 | Windows Audio Session API for system audio capture |
| `windows` 0.52.0 | Win32 API bindings (Foundation, Media Audio, COM, Threading, UI) |
| `tracing` 0.1.44 | Structured logging |

---

## Running Tests

```powershell
# Run all tests (Electron tests + Rust tests)
npm test

# Run only Electron tests
npm run test:electron

# Run Electron tests with coverage
npm run test:electron:coverage

# Run only React renderer tests
npm run test:renderer

# Run React renderer tests with coverage
npm run test:renderer:coverage

# Run all production verification gates (typecheck + coverage + cargo test)
npm run verify:production
```

---

## Troubleshooting

### `npm install` Fails on Native Module Compilation

**`better-sqlite3` build error:**

```powershell
npm rebuild better-sqlite3 --build-from-source
```

**`sharp` build error:**

```powershell
npm rebuild sharp
```

**`keytar` build error:**

```powershell
npm rebuild keytar
```

### `node-gyp` Errors / `MSBuild` Not Found

This means Visual Studio Build Tools aren't properly installed or detected.

```powershell
# Option 1: Tell npm where VS Build Tools are
npm config set msvs_version 2022

# Option 2: Install via npm (requires admin PowerShell)
npm install --global windows-build-tools

# Option 3: Verify your VS installation
# Open "Visual Studio Installer" and ensure "Desktop development with C++" is installed
```

### `python` Not Found

```powershell
# Check if Python is in PATH
where python

# If not found, set it manually:
npm config set python "C:\Python312\python.exe"
# (adjust path to your Python installation)
```

### Rust Build Fails / `cargo` Not Found

If you don't need the native module, the app will work without it. To skip:

```powershell
# Install dependencies without running postinstall scripts
npm install --ignore-scripts

# Then manually download ML models
node scripts/download-models.js

# Build without native module
npm run clean && tsc && vite build && tsc -p electron/tsconfig.json && npx electron-builder --win --x64
```

### `sqlite-vec` Issues

```powershell
# Re-run the sqlite-vec setup script
node scripts/ensure-sqlite-vec.js
```

### Model Download Fails

```powershell
# Re-run the model download script
node scripts/download-models.js
```

### App Crashes on Launch

1. Ensure all native modules are rebuilt for Electron:
   ```powershell
   npx @electron/rebuild
   ```
2. Delete `node_modules` and reinstall:
   ```powershell
   rm -Recurse -Force node_modules
   npm install
   ```

### SmartScreen Blocks the App

Click **"More info"** → **"Run anyway"**. This happens because the app isn't signed with a paid Windows code signing certificate. It's safe to run.

### PowerShell Execution Policy Errors

If you get "running scripts is disabled on this system":

```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
```

### Long Path Issues (Windows)

If you encounter path length errors during build:

```powershell
# Enable long paths (requires admin)
New-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem" -Name "LongPathsEnabled" -Value 1 -PropertyType DWORD -Force
```

Or use Git with long paths enabled:

```powershell
git config --system core.longpaths true
```

### Port 5180 Already in Use

If `npm start` fails because port 5180 is occupied:

```powershell
# Find and kill the process using port 5180
netstat -ano | findstr :5180
taskkill /PID <PID_NUMBER> /F
```

---

## Build Outputs Reference

After running `npm run dist`, you'll find these files in `release/`:

| File | Description | Size |
| :--- | :--- | :--- |
| `Natively Setup 2.0.9.exe` | NSIS installer (x64 + ia32) | ~100-150 MB |
| `Natively 2.0.9.exe` | Portable executable (x64 only) | ~100-150 MB |
| `win-unpacked/` | Unpacked application directory | ~250-350 MB |

### NSIS Installer Features

- User-selectable install directory
- Start Menu shortcut creation
- Desktop shortcut (optional)
- Registered in "Add or Remove Programs"
- Uninstaller included
- Does not require admin rights (`requestedExecutionLevel: asInvoker`)

---

## Available npm Scripts

| Script | Description |
| :--- | :--- |
| `npm start` | Start dev server + Electron (development mode) |
| `npm run dev` | Start Vite dev server only (port 5180) |
| `npm run build` | Clean + compile TypeScript + bundle frontend |
| `npm run dist` | Full production build + package installer |
| `npm run typecheck` | TypeScript type checking (renderer + electron) |
| `npm test` | Run Electron + Rust tests |
| `npm run test:electron` | Run Electron tests only |
| `npm run test:renderer` | Run React renderer tests only |
| `npm run verify:production` | All quality gates (typecheck + coverage + cargo test) |
| `npm run build:native` | Build Rust native module (all platforms) |
| `npm run build:native:current` | Build Rust native module (current platform only) |
| `npm run clean` | Remove `dist/` and `dist-electron/` directories |

---

## Quick Start (TL;DR)

For experienced developers who want to get running fast:

```powershell
# 1. Install prerequisites (Node.js, Git, VS Build Tools, Python)
# 2. Clone and enter project
git clone https://github.com/evinjohnn/natively-cluely-ai-assistant.git
cd natively-cluely-ai-assistant

# 3. Install
npm install

# 4. Configure
echo GEMINI_API_KEY=your_key > .env
echo DEEPGRAM_API_KEY=your_key >> .env
echo DEFAULT_MODEL=gemini-3.1-flash-lite-preview >> .env

# 5. Run
npm start

# 6. Or build installer
npm run dist
```
