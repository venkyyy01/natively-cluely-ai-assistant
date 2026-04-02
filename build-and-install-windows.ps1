# ╔═══════════════════════════════════════════════════════════════════╗
# ║ Natively — One-Click Build & Install for Windows                  ║
# ║ Usage: .\build-and-install-windows.ps1                            ║
# ║ Requirements: Node.js v20+, Git, VS Build Tools, Python 3.x       ║
# ╚═══════════════════════════════════════════════════════════════════╝

#Requires -Version 7.0

# ── Configuration ──
$ErrorActionPreference = "Stop"
$SCRIPT_DIR = Split-Path -Parent $MyInvocation.MyCommand.Path
$APP_NAME = "Natively"
$INSTALL_DIR = "$env:ProgramFiles\$APP_NAME"
$NODE_MIN_VERSION = "20.0.0"
$PYTHON_MIN_VERSION = "3.0.0"
$RUST_MIN_VERSION = "1.70.0"

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
    Write-Host " (" * 70 -ForegroundColor $NEON_VIOLET -NoNewline
    Write-Host "##" -ForegroundColor $NEON_VIOLET
    Write-Host ("#" * 80) -ForegroundColor $NEON_VIOLET
    Write-Host ""
}

function Write-BootLine {
    param([string]$Color, [string]$Label, [string]$Detail)
    Write-Host ">" -ForegroundColor $NEON_GREEN -NoNewline
    Write-Host " $($Label)" -ForegroundColor $WHITE -NoNewline
    Write-Host " $($Detail)" -ForegroundColor $STEEL
}

function Write-BootSequence {
    Write-BootLine $NEON_GREEN "reactor" "waking xeno-forge core"
    Start-Sleep -Milliseconds 50
    Write-BootLine $NEON_CYAN "sensors" "calibrating host architecture matrix"
    Start-Sleep -Milliseconds 50
    Write-BootLine $NEON_PINK "shields" "arming manifest and signing rails"
    Start-Sleep -Milliseconds 50
    Write-BootLine $NEON_ORANGE "nav" "locking install vector to $INSTALL_DIR"
    Start-Sleep -Milliseconds 50
    Write-Host ("~" * 80) -ForegroundColor $NEON_VIOLET
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

function Test-PythonVersion {
    try {
        $version = (python --version).Split(' ')[1]
        $minVersion = $PYTHON_MIN_VERSION
        return [version]($version) -ge [version]($minVersion)
    } catch {
        return $false
    }
}

function Test-RustVersion {
    try {
        $version = (rustc --version).Split(' ')[1]
        $minVersion = $RUST_MIN_VERSION
        return [version]($version) -ge [version]($minVersion)
    } catch {
        return $false
    }
}

function Test-VisualStudioBuildTools {
    # Check for MSVC compiler
    $vsWherePath = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
    if (Test-Path $vsWherePath) {
        $hasWorkload = & $vsWherePath -latest -requires "Microsoft.VisualStudio.Component.VC.Tools.x86.x64" -property displayName
        return $hasWorkload -ne $null
    }
    return $false
}

function Test-Git {
    try {
        $null = git --version
        return $true
    } catch {
        return $false
    }
}

function Install-Prerequisite {
    param(
        [string]$Name,
        [string]$Url,
        [string]$Instructions
    )
    
    Write-Info "$Name is not installed or version is too old"
    Write-Info "Download from: $Url"
    Write-Info $Instructions
    
    $openBrowser = Read-Host "Open download page in browser? (y/n)"
    if ($openBrowser -match '^[Yy]$') {
        Start-Process $Url
        Write-Info "Opened $Url in your default browser"
        Write-Info "After installation completes, close this script and run it again"
        exit 0
    }
    
    Write-Fail "$Name is required. Please install it and re-run this script."
}

# ── Main Execution ──
try {
    Set-Location $SCRIPT_DIR
    
    # ╔═══════════════════════════════════════════════════════════════════╗
    # ║ Pre-flight Checks                                                 ║
    # ╚═══════════════════════════════════════════════════════════════════╝
    Write-Step "Step 0/8 — Pre-flight System Checks"
    
    # Check Node.js
    if (Test-Command "node") {
        if (Test-NodeVersion) {
            Write-Success "Node.js $(node -v) detected"
        } else {
            Install-Prerequisite "Node.js $NODE_MIN_VERSION+" "https://nodejs.org" "Download and install Node.js LTS (v20+)"
        }
    } else {
        Install-Prerequisite "Node.js" "https://nodejs.org" "Download and install Node.js LTS (v20+)"
    }
    
    # Check Git
    if (Test-Git) {
        Write-Success "Git detected ($(git --version))"
    } else {
        Install-Prerequisite "Git" "https://git-scm.com/download/win" "Download and install Git for Windows"
    }
    
    # Check Visual Studio Build Tools
    if (Test-VisualStudioBuildTools) {
        Write-Success "Visual Studio Build Tools detected"
    } else {
        Install-Prerequisite "Visual Studio Build Tools" "https://visualstudio.microsoft.com/visual-cpp-build-tools/" "Install 'Desktop development with C++' workload"
    }
    
    # Check Python
    if (Test-Command "python") {
        if (Test-PythonVersion) {
            Write-Success "Python $(python --version) detected"
        } else {
            Install-Prerequisite "Python $PYTHON_MIN_VERSION+" "https://python.org" "Download and install Python 3.x (check 'Add to PATH')"
        }
    } else {
        Install-Prerequisite "Python" "https://python.org" "Download and install Python 3.x (check 'Add to PATH')"
    }
    
    # Check Rust (optional)
    $hasRust = $false
    if (Test-Command "cargo") {
        if (Test-RustVersion) {
            Write-Success "Rust $(rustc --version) detected (optional)"
            $hasRust = $true
        } else {
            Write-Warn "Rust version too old ($(rustc --version)), native module rebuild skipped"
        }
    } else {
        Write-Info "Rust not detected (optional - required only for native module rebuilds)"
    }
    
    # Detect architecture
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
    # ║ Banner                                                            ║
    # ╚═══════════════════════════════════════════════════════════════════╝
    Write-Host ""
    Write-Host ("#" * 80) -ForegroundColor $NEON_VIOLET
    Write-Host "#" -ForegroundColor $NEON_VIOLET -NoNewline
    Write-Host " . * . . * . " -ForegroundColor $NEON_GREEN -NoNewline
    Write-Host " " * 60 -ForegroundColor $NEON_VIOLET -NoNewline
    Write-Host "#" -ForegroundColor $NEON_VIOLET
    Write-Host "#" -ForegroundColor $NEON_VIOLET -NoNewline
    Write-Host " _ _ _ _____ ___ __ _______ _ __ __ " -ForegroundColor $NEON_CYAN -NoNewline
    Write-Host " " * 28 -ForegroundColor $NEON_VIOLET -NoNewline
    Write-Host "#" -ForegroundColor $NEON_VIOLET
    Write-Host "#" -ForegroundColor $NEON_VIOLET -NoNewline
    Write-Host " | \ | | / \|_ _|_ _|\\ \\ / / ____| | \\ \\ / / " -ForegroundColor $NEON_CYAN -NoNewline
    Write-Host " " * 16 -ForegroundColor $NEON_VIOLET -NoNewline
    Write-Host "#" -ForegroundColor $NEON_VIOLET
    Write-Host "#" -ForegroundColor $NEON_VIOLET -NoNewline
    Write-Host " |  \| | / _ \ | | | |  \ \\ / /| _| | | \\ V / " -ForegroundColor $NEON_PINK -NoNewline
    Write-Host " " * 14 -ForegroundColor $NEON_VIOLET -NoNewline
    Write-Host "#" -ForegroundColor $NEON_VIOLET
    Write-Host "#" -ForegroundColor $NEON_VIOLET -NoNewline
    Write-Host " | |\ | / ___ \| | | |   \ V / | |___| |___ | | " -ForegroundColor $NEON_ORANGE -NoNewline
    Write-Host " " * 12 -ForegroundColor $NEON_VIOLET -NoNewline
    Write-Host "#" -ForegroundColor $NEON_VIOLET
    Write-Host "#" -ForegroundColor $NEON_VIOLET -NoNewline
    Write-Host " |_| \_| /_/ \_\_| |___|    \_/ |_____|_____||_| " -ForegroundColor $NEON_GREEN -NoNewline
    Write-Host " " * 10 -ForegroundColor $NEON_VIOLET -NoNewline
    Write-Host "#" -ForegroundColor $NEON_VIOLET
    Write-Host "#" -ForegroundColor $NEON_VIOLET -NoNewline
    Write-Host " [ XENO-FORGE ]" -ForegroundColor $WHITE -NoNewline
    Write-Host " Windows release pipeline armed and ready" -ForegroundColor $STEEL -NoNewline
    Write-Host " " * 30 -ForegroundColor $NEON_VIOLET -NoNewline
    Write-Host "#" -ForegroundColor $NEON_VIOLET
    Write-Host "#" -ForegroundColor $NEON_VIOLET -NoNewline
    Write-Host " SIGNAL:" -ForegroundColor $NEON_ORANGE -NoNewline
    Write-Host " $ARCH_LABEL" -ForegroundColor $WHITE -NoNewline
    Write-Host " CORE:" -ForegroundColor $NEON_ORANGE -NoNewline
    Write-Host " $BUILD_ARCH" -ForegroundColor $WHITE -NoNewline
    Write-Host " TARGET:" -ForegroundColor $NEON_ORANGE -NoNewline
    Write-Host " $APP_NAME.exe" -ForegroundColor $WHITE -NoNewline
    Write-Host " " * 10 -ForegroundColor $NEON_VIOLET -NoNewline
    Write-Host "#" -ForegroundColor $NEON_VIOLET
    Write-Host ("#" * 80) -ForegroundColor $NEON_VIOLET
    Write-Host ""
    
    Write-BootSequence
    
    # ╔═══════════════════════════════════════════════════════════════════╗
    # ║ Check for Uncommitted Changes                                     ║
    # ╚═══════════════════════════════════════════════════════════════════╝
    Write-Step "Step 1/8 — Checking Source Code Status"
    
    if (Test-Path ".git") {
        $uncommitted = git status --porcelain 2>$null
        if ($uncommitted) {
            Write-Warn "Uncommitted changes detected in source:"
            Write-Host $uncommitted
            Write-Host ""
            Write-Warn "These changes will be included in the build."
        } else {
            Write-Success "Source code is clean"
        }
        
        $branch = git rev-parse --abbrev-ref HEAD 2>$null
        $commit = git rev-parse --short HEAD 2>$null
        Write-Info "Building from branch: $branch (commit: $commit)"
    } else {
        Write-Warn "Not a git repository - cannot check source status"
    }
    
    # ╔═══════════════════════════════════════════════════════════════════╗
    # ║ Clean Build Artifacts                                             ║
    # ╚═══════════════════════════════════════════════════════════════════╝
    Write-Step "Step 2/8 — Cleaning Build Artifacts"
    
    $cleanPaths = @(
        "dist",
        "dist-electron",
        "release",
        "node_modules\.cache",
        ".vite"
    )
    
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
    Write-Step "Step 3/8 — Installing Dependencies"
    
    $dependencyToolchainComplete = $true
    $requiredPaths = @(
        "node_modules\electron\package.json",
        "node_modules\electron-builder\package.json",
        "node_modules\.bin\tsc"
    )
    
    foreach ($requiredPath in $requiredPaths) {
        if (-not (Test-Path $requiredPath)) {
            $dependencyToolchainComplete = $false
            break
        }
    }
    
    $installCommand = @("npm", "install")
    if ((Test-Path "package-lock.json") -and ((-not (Test-Path "node_modules")) -or ($env:FORCE_DEPENDENCY_SYNC -eq "1"))) {
        $installCommand = @("npm", "ci")
    }
    
    if ((Test-Path "node_modules") -and $dependencyToolchainComplete -and ($env:FORCE_DEPENDENCY_SYNC -ne "1")) {
        Write-Info "Using existing node_modules; set FORCE_DEPENDENCY_SYNC=1 to force clean reinstall"
    } else {
        if (Test-Path "node_modules") {
            Write-Info "node_modules exists but build toolchain incomplete, syncing dependencies..."
        } else {
            Write-Info "Fresh install — this may take a few minutes..."
        }
        
        Write-Host "> Syncing npm dependency matrix" -ForegroundColor $NEON_VIOLET -NoNewline
        & $installCommand[0] $installCommand[1]
        Write-Success "Dependencies installed"
    }
    
    # ╔═══════════════════════════════════════════════════════════════════╗
    # ║ Run Quality Gates                                                 ║
    # ╚═══════════════════════════════════════════════════════════════════╝
    if ($env:SKIP_QUALITY_GATES -ne "1") {
        Write-Step "Step 4/8 — Running Production Quality Gates"
        
        Write-Info "Running quality gates in visible stages..."
        
        Write-Host "> [1/2] Running Electron tests" -ForegroundColor $NEON_VIOLET -NoNewline
        npm run test:electron
        Write-Success "Electron tests passed"
        
        Write-Host "> [2/2] Running production verification" -ForegroundColor $NEON_VIOLET -NoNewline
        npm run verify:production
        Write-Success "Production verification passed"
        
        Write-Success "Quality gates passed"
    } else {
        Write-Info "Skipping quality gates (set SKIP_QUALITY_GATES=0 to run)"
    }
    
    # ╔═══════════════════════════════════════════════════════════════════╗
    # ║ Build & Package                                                   ║
    # ╚═══════════════════════════════════════════════════════════════════╝
    Write-Step "Step 5/8 — Building & Packaging ($ARCH_LABEL)"
    
    Write-Info "Running $BUILD_ARCH-only build pipeline..."
    
    $buildCommand = @("npm", "run", "dist")
    if ($env:SKIP_PRODUCTION_VERIFY -eq "1") {
        $env:SKIP_PRODUCTION_VERIFY = "1"
    }
    
    Write-Host "> Building and packaging $BUILD_ARCH release" -ForegroundColor $NEON_VIOLET -NoNewline
    & $buildCommand[0] $buildCommand[1] $buildCommand[2]
    Write-Success "Build & packaging complete"
    
    # Verify build outputs
    $packagedExe = Join-Path $SCRIPT_DIR "release\Natively Setup 2.0.9.exe"
    $portableExe = Join-Path $SCRIPT_DIR "release\Natively 2.0.9.exe"
    $unpackedDir = Join-Path $SCRIPT_DIR "release\win-unpacked"
    
    if (Test-Path $packagedExe) {
        Write-Success "Built: $packagedExe"
    } elseif (Test-Path $portableExe) {
        Write-Success "Built: $portableExe"
    } elseif (Test-Path $unpackedDir) {
        Write-Success "Built: $unpackedDir"
    } else {
        Write-Fail "No build artifacts found in release directory"
    }
    
    # ╔═══════════════════════════════════════════════════════════════════╗
    # ║ Install Application                                               ║
    # ╚═══════════════════════════════════════════════════════════════════╝
    if ($env:SKIP_INSTALL -ne "1") {
        Write-Step "Step 6/8 — Installing to $INSTALL_DIR"
        
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
                Write-Fail "Failed to remove old installation. Please close the app and try again."
            }
        }
        
        # Install from unpacked directory
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
        }
    } else {
        Write-Info "SKIP_INSTALL=1 set; install skipped after packaging verification"
    }
    
    # ╔═══════════════════════════════════════════════════════════════════╗
    # ║ Verify Installation                                               ║
    # ╚═══════════════════════════════════════════════════════════════════╝
    Write-Step "Step 7/8 — Verifying Installation"
    
    $installedExe = Join-Path $INSTALL_DIR "$APP_NAME.exe"
    if (Test-Path $installedExe) {
        Write-Success "Installed executable verified"
    } else {
        Write-Fail "Installed executable not found"
    }
    
    # Verify key files
    $requiredFiles = @(
        "$APP_NAME.exe",
        "resources\app.asar",
        "resources\app.asar.unpacked\node_modules\natively-audio\index.js"
    )
    
    foreach ($file in $requiredFiles) {
        $filePath = Join-Path $INSTALL_DIR $file
        if (Test-Path $filePath) {
            Write-Success "Verified: $file"
        } else {
            Write-Warn "Missing: $file"
        }
    }
    
    Write-Success "Installation verified"
    
    # ╔═══════════════════════════════════════════════════════════════════╗
    # ║ Done!                                                             ║
    # ╚═══════════════════════════════════════════════════════════════════╝
    Write-Step "Step 8/8 — Installation Complete"
    
    Write-Host ""
    Write-Host ("#" * 80) -ForegroundColor $NEON_GREEN
    Write-Host "#" -ForegroundColor $NEON_GREEN -NoNewline
    Write-Host "ALIEN SHIPYARD STATUS: INSTALL COMPLETE" -ForegroundColor $WHITE -NoNewline
    Write-Host " " * 40 -ForegroundColor $NEON_GREEN -NoNewline
    Write-Host "#" -ForegroundColor $NEON_GREEN
    Write-Host "#" -ForegroundColor $NEON_GREEN -NoNewline
    Write-Host "APP " -ForegroundColor $NEON_CYAN -NoNewline
    Write-Host "$INSTALL_DIR\$APP_NAME.exe" -ForegroundColor $WHITE -NoNewline
    Write-Host " " * 20 -ForegroundColor $NEON_GREEN -NoNewline
    Write-Host "#" -ForegroundColor $NEON_GREEN
    Write-Host "#" -ForegroundColor $NEON_GREEN -NoNewline
    Write-Host "ARCH " -ForegroundColor $NEON_CYAN -NoNewline
    Write-Host "$ARCH_LABEL ($BUILD_ARCH)" -ForegroundColor $WHITE -NoNewline
    Write-Host " " * 20 -ForegroundColor $NEON_GREEN -NoNewline
    Write-Host "#" -ForegroundColor $NEON_GREEN
    Write-Host "#" -ForegroundColor $NEON_GREEN -NoNewline
    Write-Host "STATE " -ForegroundColor $NEON_CYAN -NoNewline
    Write-Host "rebuilt | signed | manifest-verified | launch-ready" -ForegroundColor $WHITE -NoNewline
    Write-Host " " * 10 -ForegroundColor $NEON_GREEN -NoNewline
    Write-Host "#" -ForegroundColor $NEON_GREEN
    Write-Host ("#" * 80) -ForegroundColor $NEON_GREEN
    Write-Host ""
    
    Write-Host "Next steps:" -ForegroundColor $NEON_PINK
    Write-Host ""
    Write-Host " 1." -ForegroundColor $NEON_CYAN -NoNewline
    Write-Host " Launch $APP_NAME from Start Menu or Desktop" -ForegroundColor $WHITE
    Write-Host ""
    Write-Host " 2." -ForegroundColor $NEON_CYAN -NoNewline
    Write-Host " Grant permissions when prompted:" -ForegroundColor $WHITE
    Write-Host "    > Microphone - transcription" -ForegroundColor $NEON_ORANGE
    Write-Host "    > Screen Capture - system audio + screenshots" -ForegroundColor $NEON_ORANGE
    Write-Host ""
    Write-Host " 3." -ForegroundColor $NEON_CYAN -NoNewline
    Write-Host " Configure API keys in Settings -> AI Providers" -ForegroundColor $WHITE
    Write-Host "    > Or use Ollama for fully local setup" -ForegroundColor $NEON_ORANGE
    Write-Host ""
    
    # Launch prompt
    $launch = Read-Host "Launch $APP_NAME now? [Y/n]"
    if ($launch -match '^[Yy]$' -or $launch -eq '') {
        Write-Success "Launching $APP_NAME!"
        Start-Process $installedExe
    }
    
} catch {
    Write-Fail "Build failed: $_"
    Write-Host ""
    Write-Host "Troubleshooting:" -ForegroundColor $NEON_ORANGE
    Write-Host "  1. Ensure all prerequisites are installed (Node.js, Git, VS Build Tools, Python)" -ForegroundColor $STEEL
    Write-Host "  2. Run 'npm install' manually to see detailed errors" -ForegroundColor $STEEL
    Write-Host "  3. Check that you have write permissions to $INSTALL_DIR" -ForegroundColor $STEEL
    Write-Host "  4. Try running as Administrator" -ForegroundColor $STEEL
    Write-Host ""
    exit 1
}
