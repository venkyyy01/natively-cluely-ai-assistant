# Windows Build & Install Scripts

Complete automated build and installation scripts for Natively on Windows.

## Available Scripts

### 1. `build-and-install-windows.ps1` (Recommended)

**PowerShell script** with full fail-safes, interactive prompts, and comprehensive error handling.

**Requirements:**
- PowerShell 7.0+ (comes with Windows 11, or install from [PowerShell GitHub](https://github.com/PowerShell/PowerShell))
- Node.js v20+
- Git for Windows
- Visual Studio Build Tools with "Desktop development with C++" workload
- Python 3.x

**Usage:**

```powershell
# Open PowerShell as Administrator (optional, but recommended)
# Right-click → Run as Administrator

# Run the script
.\build-and-install-windows.ps1
```

**Features:**
- ✅ Automatic prerequisite detection
- ✅ Interactive download prompts for missing dependencies
- ✅ Color-coded output with boot sequence animation
- ✅ Pre-flight system checks
- ✅ Clean build artifact removal
- ✅ Dependency installation with fallback options
- ✅ Quality gate execution (tests, type checking)
- ✅ Production build with `npm run dist`
- ✅ Automatic installation to `Program Files`
- ✅ Desktop and Start Menu shortcut creation
- ✅ Installation verification
- ✅ Launch prompt with graceful exit

**Environment Variables:**

| Variable | Default | Description |
| :--- | :--- | :--- |
| `SKIP_QUALITY_GATES` | `0` | Skip tests and verification |
| `SKIP_INSTALL` | `0` | Skip installation step |
| `FORCE_DEPENDENCY_SYNC` | `0` | Force clean npm reinstall |
| `SKIP_PRODUCTION_VERIFY` | `0` | Skip production verification |

**Examples:**

```powershell
# Normal build with all checks
.\build-and-install-windows.ps1

# Skip quality gates (faster, less safe)
$env:SKIP_QUALITY_GATES = 1
.\build-and-install-windows.ps1

# Build only, don't install
$env:SKIP_INSTALL = 1
.\build-and-install-windows.ps1

# Force clean dependency reinstall
$env:FORCE_DEPENDENCY_SYNC = 1
.\build-and-install-windows.ps1
```

---

### 2. `build-and-install-windows.bat` (Maximum Compatibility)

**Batch script** for systems without PowerShell 7.0+ or for maximum compatibility.

**Usage:**

```cmd
REM Open Command Prompt as Administrator
REM Right-click → Run as Administrator

build-and-install-windows.bat
```

**Features:**
- ✅ Works on all Windows versions (Windows 7+)
- ✅ No PowerShell version requirements
- ✅ Basic prerequisite checks
- ✅ Standard npm build process
- ✅ Shortcut creation
- ✅ Launch prompt

**Limitations:**
- Less detailed error messages
- No color output (batch limitations)
- Fewer interactive prompts
- Basic prerequisite detection only

---

## Prerequisites Installation Guide

If the scripts detect missing prerequisites, you'll need to install them manually. Here's how:

### 1. Install Node.js v20+

1. Download from [https://nodejs.org](https://nodejs.org)
2. Choose **LTS** version (v20.x or higher)
3. Run installer, accept defaults
4. **Important:** Check "Automatically install necessary tools" if prompted
5. Verify: `node -v` should print `v20.x.x`

### 2. Install Git for Windows

1. Download from [https://git-scm.com/download/win](https://git-scm.com/download/win)
2. Run installer with default settings
3. Choose "Git from the command line" option
4. Verify: `git --version`

### 3. Install Visual Studio Build Tools

**Option A - Standalone (Recommended):**

1. Download from [https://visualstudio.microsoft.com/visual-cpp-build-tools/](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
2. Run installer
3. Select **"Desktop development with C++"** workload
4. Ensure these are checked:
   - MSVC v143 - VS 2022 C++ x64/x86 build tools
   - Windows 10/11 SDK
   - C++ CMake tools for Windows
5. Install (~2-5 GB)

**Option B - Via npm (Automatic):**

```powershell
npm install --global windows-build-tools
```

This takes 10-20 minutes and requires admin rights.

### 4. Install Python 3.x

1. Download from [https://python.org](https://python.org)
2. Run installer
3. **Critical:** Check **"Add Python to PATH"**
4. Click "Install Now"
5. Verify: `python --version`

### 5. Install Rust (Optional)

Only needed if rebuilding the native audio module.

1. Download from [https://rustup.rs](https://rustup.rs)
2. Run `rustup-init.exe`
3. Accept defaults
4. Restart terminal
5. Verify: `rustc --version`

---

## Step-by-Step Installation Process

### Quick Start (All Prerequisites Installed)

```powershell
# 1. Clone repository
git clone https://github.com/evinjohnn/natively-cluely-ai-assistant.git
cd natively-cluely-ai-assistant

# 2. Run build script
.\build-and-install-windows.ps1

# 3. Configure API keys in .env file when prompted
# 4. Launch from Start Menu or Desktop
```

### Detailed Flow

1. **Pre-flight Checks**
   - Detects Node.js version
   - Checks for Git
   - Verifies Visual Studio Build Tools
   - Confirms Python installation
   - Optional: Rust detection

2. **Source Code Status**
   - Checks for uncommitted changes
   - Displays current branch and commit

3. **Clean Build Artifacts**
   - Removes `dist/`, `dist-electron/`, `release/`
   - Clears npm and Vite caches

4. **Install Dependencies**
   - Runs `npm install` or `npm ci`
   - Downloads ML models
   - Rebuilds native modules

5. **Quality Gates** (optional)
   - Electron tests
   - TypeScript type checking
   - Rust tests (if applicable)

6. **Build & Package**
   - Compiles TypeScript
   - Bundles React frontend
   - Packages with electron-builder
   - Creates NSIS installer and portable EXE

7. **Install Application**
   - Removes old installation
   - Copies to `Program Files`
   - Creates shortcuts
   - Registers in Start Menu

8. **Verify Installation**
   - Checks executable exists
   - Verifies key files
   - Confirms architecture match

9. **Launch Prompt**
   - Ask to launch immediately
   - Opens app if confirmed

---

## Troubleshooting

### Script Won't Run

**Issue:** PowerShell execution policy blocks scripts

**Solution:**
```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
```

### npm install Fails

**Issue:** Native module compilation errors

**Solution:**
```powershell
# Rebuild specific modules
npm rebuild better-sqlite3 --build-from-source
npm rebuild sharp

# Or full reinstall
rm -Recurse -Force node_modules
npm install
```

### Build Fails on `node-gyp`

**Issue:** Missing Visual Studio Build Tools

**Solution:**
```powershell
# Install via npm (requires admin)
npm install --global windows-build-tools

# Or manually install from:
# https://visualstudio.microsoft.com/visual-cpp-build-tools/
```

### Permission Denied on Install

**Issue:** Cannot write to Program Files

**Solution:**
- Run script as Administrator
- Or set custom install directory:
  ```powershell
  $env:INSTALL_DIR = "$env:UserProfile\Natively"
  .\build-and-install-windows.ps1
  ```

### Port Already in Use

**Issue:** Port 5180 is occupied

**Solution:**
```powershell
# Find process using port 5180
netstat -ano | findstr :5180

# Kill the process
taskkill /PID <PID_NUMBER> /F
```

### Build Succeeds but App Won't Launch

**Issue:** Missing runtime dependencies or SmartScreen block

**Solution:**
1. Check Windows Defender SmartScreen - click "More info" → "Run anyway"
2. Verify all dependencies installed:
   ```powershell
   npm install
   ```
3. Try running from unpacked directory:
   ```powershell
   .\release\win-unpacked\Natively.exe
   ```

---

## Build Outputs

After successful build, `release/` directory contains:

| File | Description | Size |
| :--- | :--- | :--- |
| `Natively Setup 2.0.9.exe` | NSIS installer (x64 + ia32) | ~100-150 MB |
| `Natively 2.0.9.exe` | Portable executable (x64) | ~100-150 MB |
| `win-unpacked/` | Unpacked application | ~250-350 MB |

---

## Advanced Configuration

### Custom Build Architecture

```powershell
# x64 only
npx electron-builder --win --x64

# ia32 only
npx electron-builder --win --ia32
```

### Skip Installation (Build Only)

```powershell
$env:SKIP_INSTALL = 1
.\build-and-install-windows.ps1
```

### Force Clean Dependency Install

```powershell
$env:FORCE_DEPENDENCY_SYNC = 1
.\build-and-install-windows.ps1
```

### Build Without Quality Gates

```powershell
$env:SKIP_QUALITY_GATES = 1
.\build-and-install-windows.ps1
```

---

## Uninstall

To completely remove Natively:

```powershell
# 1. Close the app
taskkill /f /im Natively.exe

# 2. Uninstall via Settings
# Settings → Apps → Natively → Uninstall

# 3. Remove residual files
Remove-Item -Recurse -Force "$env:ProgramFiles\Natively"
Remove-Item -Recurse -Force "$env:AppData\Natively"
Remove-Item -Recurse -Force "$env:LocalAppData\Natively"

# 4. Remove shortcuts (if not auto-removed)
Remove-Item "$env:ProgramData\Microsoft\Windows\Start Menu\Programs\Natively.lnk"
Remove-Item "$env:UserProfile\Desktop\Natively.lnk"
```

---

## Support

For issues:
1. Check [install_in_windows.md](install_in_windows.md) for detailed guide
2. Review [README.md](README.md) Windows section
3. Check GitHub Issues: [evinjohnn/natively-cluely-ai-assistant/issues](https://github.com/evinjohnn/natively-cluely-ai-assistant/issues)

---

## Script Comparison

| Feature | PowerShell Script | Batch Script |
| :--- | :--- | :--- |
| **OS Support** | Windows 10/11 (PowerShell 7+) | Windows 7+ (all versions) |
| **Color Output** | ✅ Yes | ❌ No |
| **Interactive Prompts** | ✅ Yes | ⚠️ Limited |
| **Prerequisite Detection** | ✅ Comprehensive | ⚠️ Basic |
| **Error Handling** | ✅ Detailed | ⚠️ Basic |
| **Shortcuts** | ✅ Desktop + Start Menu | ✅ Start Menu |
| **Animation** | ✅ Boot sequence | ❌ No |
| **Environment Variables** | ✅ Full support | ⚠️ Limited |
| **Recommended For** | Most users | Legacy systems |

---

**Last Updated:** 2026-04-02  
**Version:** 2.0.9  
**Maintainer:** @razllivan (Windows Build)
