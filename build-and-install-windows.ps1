# ╔═══════════════════════════════════════════════════════════════════╗
# ║ Natively — One-Click Build & Install for Windows                  ║
# ║ Usage: .\build-and-install-windows.ps1 (Run as Administrator)     ║
# ║ Requirements: Node.js v20+, Git, Rust (optional)                  ║
# ╚═══════════════════════════════════════════════════════════════════╝

#Requires -Version 7.0

# ── Configuration ──
$ErrorActionPreference = "Stop"
$SCRIPT_DIR = Split-Path -Parent $MyInvocation.MyCommand.Path
$APP_NAME = "Natively"
$INSTALL_DIR = "$env:ProgramFiles\$APP_NAME"
$NODE_MIN_VERSION = "20.0.0"

# ── Colors ──
$NEON_PINK = [ConsoleColor]::Magenta
$NEON_CYAN = [ConsoleColor]::Cyan
$NEON_GREEN = [ConsoleColor]::Green
$NEON_VIOLET = [ConsoleColor]::DarkMagenta
$NEON_ORANGE = [ConsoleColor]::Yellow
$NEON_RED = [ConsoleColor]::Red
$WHITE = [ConsoleColor]::White
$STEEL = [ConsoleColor]::Gray

# ── Helpers ──
function Write-Info {
    param([string]$Message)
    Write-Host "[INFO]" $Message -ForegroundColor $STEEL
}

function Write-Success {
    param([string]$Message)
    Write-Host "[ OK ]" $Message -ForegroundColor $NEON_GREEN
}

function Write-Warn {
    param([string]$Message)
    Write-Host "[WARN]" $Message -ForegroundColor $NEON_ORANGE
}

function Write-Fail {
    param([string]$Message)
    Write-Host "[FAIL]" $Message -ForegroundColor $NEON_RED
    throw $Message
}

function Write-Step {
    param([string]$Message)
    Write-Host ""
    Write-Host ("#" * 80) -ForegroundColor $NEON_VIOLET
    Write-Host "##" -ForegroundColor $NEON_VIOLET -NoNewline
    Write-Host " $($Message)" -ForegroundColor $NEON_CYAN -NoNewline
    Write-Host " " * 60 -ForegroundColor $NEON_VIOLET -NoNewline
    Write-Host "##" -ForegroundColor $NEON_VIOLET
    Write-Host ("#" * 80) -ForegroundColor $NEON_VIOLET
    Write-Host ""
}

function Test-Command {
    param([string]$Command)
    try {
        $null = Get-Command $Command -ErrorAction Stop
        return $true
    } catch {
        return $false
    }
}

function Test-NodeVersion {
    try {
        $version = (node -v).TrimStart('v')
        $minVersion = $NODE_MIN_VERSION.TrimStart('v')
        return [version]($version) -ge [version]($minVersion)
    } catch {
        return $false
    }
}

function Test-Git {
    try {
        $null = git --version
        return $true
    } catch {
        return $false
    }
}

# ── Main Execution ──
try {
    Set-Location $SCRIPT_DIR

    # ╔═══════════════════════════════════════════════════════════════════╗
    # ║ Pre-flight Checks                                                 ║
    # ╚═══════════════════════════════════════════════════════════════════╝
    Write-Step "Step 1/6 — Pre-flight System Checks"

    if (Test-Command "node") {
        if (Test-NodeVersion) {
            Write-Success "Node.js $(node -v) detected"
        } else {
            Write-Fail "Node.js $NODE_MIN_VERSION+ required, found $(node -v)"
        }
    } else {
        Write-Fail "Node.js not found. Install from https://nodejs.org"
    }

    if (Test-Git) {
        Write-Success "Git detected ($(git --version))"
    } else {
        Write-Warn "Git not found (optional, needed for version checks)"
    }

    $arch = (Get-CimInstance Win32_Processor).AddressWidth | Select-Object -First 1
    if ($arch -eq 64) {
        $BUILD_ARCH = "x64"
        $ARCH_LABEL = "x64 (64-bit)"
    } else {
        $BUILD_ARCH = "ia32"
        $ARCH_LABEL = "ia32 (32-bit)"
    }
    Write-Info "Architecture: $ARCH_LABEL"

    # ╔═══════════════════════════════════════════════════════════════════╗
    # ║ Clean Build Artifacts                                             ║
    # ╚═══════════════════════════════════════════════════════════════════╝
    Write-Step "Step 2/6 — Cleaning Build Artifacts"

    $cleanPaths = @("dist", "dist-electron", "release")
    foreach ($path in $cleanPaths) {
        $fullPath = Join-Path $SCRIPT_DIR $path
        if (Test-Path $fullPath) {
            Write-Info "Removing: $path"
            Remove-Item -Recurse -Force $fullPath
        }
    }
    Write-Success "Fresh-build cleanup complete"

    # ╔═══════════════════════════════════════════════════════════════════╗
    # ║ Install Dependencies                                              ║
    # ╚═══════════════════════════════════════════════════════════════════╝
    Write-Step "Step 3/6 — Installing Dependencies"

    if ((Test-Path "node_modules") -and ($env:FORCE_DEPENDENCY_SYNC -ne "1")) {
        Write-Info "Using existing node_modules; set FORCE_DEPENDENCY_SYNC=1 to force reinstall"
    } else {
        if (Test-Path "node_modules") {
            Write-Info "Forcing clean dependency sync..."
        } else {
            Write-Info "Fresh install — this may take a few minutes..."
        }
        Write-Host "> Syncing npm dependencies" -ForegroundColor $NEON_VIOLET -NoNewline
        npm install
        Write-Success "Dependencies installed"
    }

    # ╔═══════════════════════════════════════════════════════════════════╗
    # ║ Build TypeScript + Vite                                           ║
    # ╚═══════════════════════════════════════════════════════════════════╝
    Write-Step "Step 4/6 — Building Frontend"

    Write-Host "> Compiling TypeScript" -ForegroundColor $NEON_VIOLET -NoNewline
    npx tsc
    Write-Success "TypeScript compiled"

    Write-Host "> Running Vite build" -ForegroundColor $NEON_VIOLET -NoNewline
    npx vite build
    Write-Success "Vite build complete"

    # ╔═══════════════════════════════════════════════════════════════════╗
    # ║ Build Native Module + Electron                                    ║
    # ╔═══════════════════════════════════════════════════════════════════╝
    Write-Step "Step 5/6 — Building Native Module & Electron App"

    Write-Host "> Building native module" -ForegroundColor $NEON_VIOLET -NoNewline
    npm run build:native:current
    Write-Success "Native module built"

    Write-Host "> Compiling Electron TypeScript" -ForegroundColor $NEON_VIOLET -NoNewline
    npx tsc -p electron/tsconfig.json
    Write-Success "Electron TypeScript compiled"

    Write-Host "> Packaging with electron-builder (unsigned, x64)" -ForegroundColor $NEON_VIOLET -NoNewline

    # Disable all code signing to avoid winCodeSign symlink issues on Windows
    $env:CSC_LINK = ""
    $env:CSC_KEY_PASSWORD = ""
    $env:WIN_CSC_LINK = ""
    $env:WIN_CSC_KEY_PASSWORD = ""

    npx electron-builder --win --x64 --dir --publish never
    Write-Success "Electron app packaged"

    # ╔═══════════════════════════════════════════════════════════════════╗
    # ║ Install Application                                               ║
    # ╚═══════════════════════════════════════════════════════════════════╝
    if ($env:SKIP_INSTALL -ne "1") {
        Write-Step "Step 6/6 — Installing to $INSTALL_DIR"

        # Kill existing instance
        if (Get-Process $APP_NAME -ErrorAction SilentlyContinue) {
            Write-Info "Closing existing $APP_NAME instance..."
            Stop-Process -Name $APP_NAME -Force
            Start-Sleep -Seconds 1
        }

        # Remove old installation
        if (Test-Path $INSTALL_DIR) {
            Write-Info "Removing previous installation..."
            try {
                Remove-Item -Recurse -Force $INSTALL_DIR -ErrorAction Stop
            } catch {
                Write-Fail "Failed to remove old installation. Close the app and try again."
            }
        }

        # Install from unpacked directory
        $unpackedDir = Join-Path $SCRIPT_DIR "release\win-unpacked"
        if (Test-Path $unpackedDir) {
            Write-Info "Copying to $INSTALL_DIR..."
            try {
                Copy-Item -Recurse -Force "$unpackedDir\" $INSTALL_DIR -ErrorAction Stop
            } catch {
                Write-Fail "Failed to copy files. Run as Administrator."
            }

            Write-Success "Installed to $INSTALL_DIR"

            # Create Start Menu shortcut
            $startMenuDir = "$env:ProgramData\Microsoft\Windows\Start Menu\Programs"
            $shortcutPath = Join-Path $startMenuDir "$APP_NAME.lnk"
            $targetPath = Join-Path $INSTALL_DIR "$APP_NAME.exe"

            $shell = New-Object -ComObject WScript.Shell
            $shortcut = $shell.CreateShortcut($shortcutPath)
            $shortcut.TargetPath = $targetPath
            $shortcut.WorkingDirectory = $INSTALL_DIR
            $shortcut.Save()
            Write-Success "Start Menu shortcut created"

            # Create Desktop shortcut
            $desktopPath = [System.IO.Path]::Combine([Environment]::GetFolderPath("Desktop"), "$APP_NAME.lnk")
            $desktopShortcut = $shell.CreateShortcut($desktopPath)
            $desktopShortcut.TargetPath = $targetPath
            $desktopShortcut.WorkingDirectory = $INSTALL_DIR
            $desktopShortcut.Save()
            Write-Success "Desktop shortcut created"
        } else {
            Write-Fail "Build output not found at $unpackedDir"
        }
    } else {
        Write-Info "SKIP_INSTALL=1 set; install skipped"
    }

    # ╔═══════════════════════════════════════════════════════════════════╗
    # ║ Done!                                                             ║
    # ╚═══════════════════════════════════════════════════════════════════╝
    Write-Step "Installation Complete"

    Write-Host ""
    Write-Host ("#" * 80) -ForegroundColor $NEON_GREEN
    Write-Host "#" -ForegroundColor $NEON_GREEN -NoNewline
    Write-Host " ALIEN SHIPYARD STATUS: INSTALL COMPLETE" -ForegroundColor $WHITE -NoNewline
    Write-Host " " * 40 -ForegroundColor $NEON_GREEN -NoNewline
    Write-Host "#" -ForegroundColor $NEON_GREEN
    Write-Host "#" -ForegroundColor $NEON_GREEN -NoNewline
    Write-Host " APP " -ForegroundColor $NEON_CYAN -NoNewline
    Write-Host "$INSTALL_DIR\$APP_NAME.exe" -ForegroundColor $WHITE -NoNewline
    Write-Host " " * 30 -ForegroundColor $NEON_GREEN -NoNewline
    Write-Host "#" -ForegroundColor $NEON_GREEN
    Write-Host "#" -ForegroundColor $NEON_GREEN -NoNewline
    Write-Host " ARCH " -ForegroundColor $NEON_CYAN -NoNewline
    Write-Host "$ARCH_LABEL" -ForegroundColor $WHITE -NoNewline
    Write-Host " " * 30 -ForegroundColor $NEON_GREEN -NoNewline
    Write-Host "#" -ForegroundColor $NEON_GREEN
    Write-Host "#" -ForegroundColor $NEON_GREEN -NoNewline
    Write-Host " STATE " -ForegroundColor $NEON_CYAN -NoNewline
    Write-Host "rebuilt | launch-ready" -ForegroundColor $WHITE -NoNewline
    Write-Host " " * 30 -ForegroundColor $NEON_GREEN -NoNewline
    Write-Host "#" -ForegroundColor $NEON_GREEN
    Write-Host ("#" * 80) -ForegroundColor $NEON_GREEN
    Write-Host ""

    Write-Host "Next steps:" -ForegroundColor $NEON_PINK
    Write-Host ""
    Write-Host " 1." -ForegroundColor $NEON_CYAN -NoNewline
    Write-Host " Launch $APP_NAME from Start Menu or Desktop" -ForegroundColor $WHITE
    Write-Host ""
    Write-Host " 2." -ForegroundColor $NEON_CYAN -NoNewline
    Write-Host " Configure API keys in Settings -> AI Providers" -ForegroundColor $WHITE
    Write-Host "    > Or use Ollama for fully local setup" -ForegroundColor $NEON_ORANGE
    Write-Host ""

    # Launch prompt
    $launch = Read-Host "Launch $APP_NAME now? [Y/n]"
    if ($launch -match '^[Yy]$' -or $launch -eq '') {
        Write-Success "Launching $APP_NAME!"
        Start-Process "$INSTALL_DIR\$APP_NAME.exe"
    }

} catch {
    Write-Fail "Build failed: $_"
    Write-Host ""
    Write-Host "Troubleshooting:" -ForegroundColor $NEON_ORANGE
    Write-Host "  1. Ensure Node.js v20+ and Git are installed" -ForegroundColor $STEEL
    Write-Host "  2. Run 'npm install' manually to see detailed errors" -ForegroundColor $STEEL
    Write-Host "  3. Run this script as Administrator" -ForegroundColor $STEEL
    Write-Host ""
    exit 1
}
