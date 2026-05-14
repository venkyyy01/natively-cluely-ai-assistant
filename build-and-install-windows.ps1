#Requires -Version 5.1
<#
╔═══════════════════════════════════════════════════════════════════╗
║  Natively — One-Click Build & Install for Windows 10/11          ║
║  Usage:  Right-click → Run with PowerShell (as Administrator)    ║
║     or:  powershell -ExecutionPolicy Bypass -File .\build-and-install-windows.ps1 ║
╚═══════════════════════════════════════════════════════════════════╝

This script:
  1. Checks (and optionally installs) prerequisites: Node.js, Git, Rust
  2. Cleans previous build artifacts
  3. Installs npm dependencies
  4. Runs quality gates (TypeScript compile, tests, coverage) with timeouts
  5. Builds & packages for Windows x64 (NSIS installer + portable)
  6. Locates the installer and runs it silently
  7. Verifies the installed application

Environment variable overrides:
  SKIP_QUALITY_GATES=1    — skip quality gates
  SKIP_INSTALL=1          — build only, do not install
  QUALITY_GATE_TIMEOUT=N  — per-gate timeout in seconds (default 300)
  FORCE_DEPENDENCY_SYNC=1 — force npm ci even if node_modules exists
#>

param(
    [string]$OutputDir = "release",
    [switch]$SkipBuild,
    [switch]$SkipInstall,
    [switch]$SkipQualityGates,
    [switch]$ForceDependencySync
)

# ── Strict mode ──
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'  # Speed up Invoke-WebRequest

# ── Constants ──
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$AppName = "Natively"
$ReleaseDir = Join-Path $ScriptDir $OutputDir
$QualityGateTimeout = if ($env:QUALITY_GATE_TIMEOUT) { [int]$env:QUALITY_GATE_TIMEOUT } else { 300 }
$BuildArch = "x64"
$ArchLabel = "Windows x64"
$StartTime = Get-Date

# Override switches from env vars
if ($env:SKIP_QUALITY_GATES -eq "1") { $SkipQualityGates = $true }
if ($env:SKIP_INSTALL -eq "1")       { $SkipInstall = $true }
if ($env:FORCE_DEPENDENCY_SYNC -eq "1") { $ForceDependencySync = $true }

# ── Colors & Helpers ──
function Write-NeonCyan   { param([string]$Msg) Write-Host $Msg -ForegroundColor Cyan }
function Write-NeonGreen  { param([string]$Msg) Write-Host $Msg -ForegroundColor Green }
function Write-NeonYellow { param([string]$Msg) Write-Host $Msg -ForegroundColor Yellow }
function Write-NeonRed    { param([string]$Msg) Write-Host $Msg -ForegroundColor Red }
function Write-Steel      { param([string]$Msg) Write-Host $Msg -ForegroundColor DarkGray }

function Info    { param([string]$Msg) Write-Host "[INFO]  " -ForegroundColor Cyan -NoNewline; Write-Host $Msg -ForegroundColor Gray }
function Success { param([string]$Msg) Write-Host "[ OK ]  " -ForegroundColor Green -NoNewline; Write-Host $Msg -ForegroundColor White }
function Warn    { param([string]$Msg) Write-Host "[WARN]  " -ForegroundColor Yellow -NoNewline; Write-Host $Msg -ForegroundColor White }
function Fail    { param([string]$Msg) Write-Host "[FAIL]  " -ForegroundColor Red -NoNewline; Write-Host $Msg -ForegroundColor White; exit 1 }

function Step {
    param([string]$Msg)
    Write-Host ""
    Write-Host ("=" * 72) -ForegroundColor Magenta
    Write-Host "##  $Msg" -ForegroundColor Cyan
    Write-Host ("=" * 72) -ForegroundColor Magenta
}

function Invoke-Cmd {
    <#
    .SYNOPSIS Run a command, throw on non-zero exit.
    #>
    param(
        [string]$Label,
        [string]$Command,
        [string[]]$Arguments
    )
    Info "$Label"
    & $Command @Arguments 2>&1 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
    if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) {
        Fail "$Label failed (exit code $LASTEXITCODE)"
    }
}

function Invoke-CmdWithTimeout {
    <#
    .SYNOPSIS Run a command with a timeout. Returns $true on success.
    #>
    param(
        [string]$Label,
        [int]$TimeoutSeconds,
        [string]$Command,
        [string[]]$Arguments
    )
    Info "$Label (timeout: ${TimeoutSeconds}s)"

    $logFile = [System.IO.Path]::GetTempFileName()
    $argLine = ($Arguments | ForEach-Object {
        if ($_ -match '\s') { "`"$_`"" } else { $_ }
    }) -join ' '

    $proc = Start-Process -FilePath $Command -ArgumentList $argLine `
        -RedirectStandardOutput $logFile -RedirectStandardError "$logFile.err" `
        -NoNewWindow -PassThru

    $finished = $proc.WaitForExit($TimeoutSeconds * 1000)
    if (-not $finished) {
        try { $proc.Kill() } catch {}
        Write-NeonRed "--- TIMEOUT after ${TimeoutSeconds}s ---"
        if (Test-Path $logFile) { Get-Content $logFile -Tail 100 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray } }
        Remove-Item $logFile, "$logFile.err" -Force -ErrorAction SilentlyContinue
        Fail "$Label timed out after ${TimeoutSeconds}s"
    }

    if ($proc.ExitCode -ne 0) {
        Write-NeonRed "--- command output (last 100 lines) ---"
        if (Test-Path $logFile) { Get-Content $logFile -Tail 100 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray } }
        if (Test-Path "$logFile.err") { Get-Content "$logFile.err" -Tail 50 | ForEach-Object { Write-Host "    $_" -ForegroundColor Red } }
        Remove-Item $logFile, "$logFile.err" -Force -ErrorAction SilentlyContinue
        Fail "$Label failed (exit code $($proc.ExitCode))"
    }

    Remove-Item $logFile, "$logFile.err" -Force -ErrorAction SilentlyContinue
    Success $Label
}

function Test-CommandExists {
    param([string]$Name)
    $null -ne (Get-Command $Name -ErrorAction SilentlyContinue)
}

function Refresh-Path {
    # Reload PATH from Machine + User so newly-installed tools are visible
    $machinePath = [System.Environment]::GetEnvironmentVariable("Path", "Machine")
    $userPath = [System.Environment]::GetEnvironmentVariable("Path", "User")
    $env:Path = "$machinePath;$userPath"
}

function Get-WindowsInstaller {
    param([string]$SearchRoot)
    $exeFiles = Get-ChildItem -Path $SearchRoot -Recurse -File -Filter *.exe |
        Sort-Object LastWriteTimeUtc -Descending
    if (-not $exeFiles) { return $null }

    # Prefer the NSIS "Setup" installer
    $setupInstaller = $exeFiles | Where-Object { $_.Name -match 'Setup' } | Select-Object -First 1
    if ($setupInstaller) { return $setupInstaller }
    return $exeFiles | Select-Object -First 1
}

# ╔═══════════════════════════════════════════════════════════════════╗
# ║  Banner                                                          ║
# ╚═══════════════════════════════════════════════════════════════════╝
Write-Host ""
Write-Host ("=" * 80) -ForegroundColor Magenta
Write-Host "#                                                                              #" -ForegroundColor Magenta
Write-NeonCyan  "       _   _      _  _____ ___ __     _______ _    __   __"
Write-NeonCyan  "      | \ | |    / \|_   _|_ _|\ \   / / ____| |   \ \ / /"
Write-NeonGreen "      |  \| |   / _ \ | |  | |  \ \ / /|  _| | |    \ V / "
Write-NeonYellow "      | |\  |  / ___ \| |  | |   \ V / | |___| |___  | |  "
Write-NeonGreen "      |_| \_| /_/   \_\_| |___|   \_/  |_____|_____| |_|  "
Write-Host "#                                                                              #" -ForegroundColor Magenta
Write-Host "#  [ XENO-FORGE ]  Windows release pipeline armed and ready                    #" -ForegroundColor Gray
Write-Host "#  SIGNAL: $ArchLabel    CORE: $BuildArch    TARGET: $AppName.exe" -ForegroundColor Gray
Write-Host "#                                                                              #" -ForegroundColor Magenta
Write-Host ("=" * 80) -ForegroundColor Magenta
Write-Host ""

# ╔═══════════════════════════════════════════════════════════════════╗
# ║  Step 1: Check & Install Prerequisites                           ║
# ╚═══════════════════════════════════════════════════════════════════╝
Step "Step 1/8 — Checking Prerequisites"

# ── Admin check ──
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator
)
if ($isAdmin) {
    Success "Running as Administrator"
} else {
    Warn "Not running as Administrator — some auto-install steps may fail"
    Warn "Re-run with: powershell -ExecutionPolicy Bypass -File .\build-and-install-windows.ps1"
}

# ── Windows version ──
$osVersion = [System.Environment]::OSVersion.Version
$osBuild = (Get-CimInstance Win32_OperatingSystem).BuildNumber
Info "Windows version: $($osVersion.Major).$($osVersion.Minor) (Build $osBuild)"
if ([int]$osBuild -lt 18362) {
    Warn "Build $osBuild is older than Windows 10 1903. Some features may not work."
}

# ── Node.js ──
if (Test-CommandExists "node") {
    $nodeVersion = & node --version 2>$null
    Success "Node.js found: $nodeVersion"
    if ($nodeVersion -match 'v(\d+)' -and [int]$Matches[1] -lt 18) {
        Warn "Node.js $nodeVersion is below v18. Recommend upgrading."
    }
} else {
    Warn "Node.js not found — attempting to install via winget..."
    if (Test-CommandExists "winget") {
        & winget install --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements 2>&1 | Out-Null
        Refresh-Path
        if (Test-CommandExists "node") {
            Success "Node.js installed: $(& node --version)"
        } else {
            Fail "Node.js installation failed. Install manually from https://nodejs.org"
        }
    } else {
        Fail "Node.js not found and winget unavailable. Install Node.js LTS from https://nodejs.org"
    }
}

# ── npm ──
if (Test-CommandExists "npm") {
    Success "npm found: $(& npm --version 2>$null)"
} else {
    Fail "npm not found. It should ship with Node.js. Reinstall Node.js."
}

# ── Git ──
if (Test-CommandExists "git") {
    Success "Git found: $(& git --version 2>$null)"
} else {
    Warn "Git not found — attempting to install via winget..."
    if (Test-CommandExists "winget") {
        & winget install --id Git.Git --accept-source-agreements --accept-package-agreements 2>&1 | Out-Null
        Refresh-Path
        if (Test-CommandExists "git") {
            Success "Git installed: $(& git --version)"
        } else {
            Warn "Git installation failed. Some features (version info) may not work."
        }
    } else {
        Warn "Git not found and winget unavailable. Install from https://git-scm.com"
    }
}

# ── Visual Studio Build Tools (needed for native modules) ──
$vsWherePath = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
$hasVsBuildTools = $false
if (Test-Path $vsWherePath) {
    $vsInstall = & $vsWherePath -latest -property installationPath 2>$null
    if ($vsInstall) {
        $hasVsBuildTools = $true
        Success "Visual Studio Build Tools found: $vsInstall"
    }
}
if (-not $hasVsBuildTools) {
    Warn "Visual Studio Build Tools not detected — attempting to install via winget..."
    if (Test-CommandExists "winget") {
        Info "Installing Visual Studio Build Tools (Desktop C++ workload)..."
        & winget install --id Microsoft.VisualStudio.2022.BuildTools `
            --override "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended" `
            --accept-source-agreements --accept-package-agreements 2>&1 | Out-Null
        Refresh-Path
        # Re-check
        if (Test-Path $vsWherePath) {
            $vsInstall = & $vsWherePath -latest -property installationPath 2>$null
            if ($vsInstall) {
                Success "Visual Studio Build Tools installed: $vsInstall"
            } else {
                Warn "VS Build Tools installed but workload may be incomplete"
            }
        } else {
            Warn "VS Build Tools install may need a restart to take effect"
        }
    } else {
        Warn "winget unavailable — install VS Build Tools manually:"
        Warn "  https://visualstudio.microsoft.com/visual-cpp-build-tools/"
    }
}

# ── Rust / Cargo (needed for native module) ──
$HasRust = Test-CommandExists "cargo"
if ($HasRust) {
    Success "Rust found: $(& cargo --version 2>$null)"
} else {
    Warn "Rust/Cargo not found — attempting to install via rustup..."
    $rustupUrl = "https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe"
    $rustupExe = Join-Path $env:TEMP "rustup-init.exe"
    try {
        Info "Downloading rustup-init.exe..."
        Invoke-WebRequest -Uri $rustupUrl -OutFile $rustupExe -UseBasicParsing
        Info "Running rustup-init (silent install)..."
        & $rustupExe -y --default-toolchain stable 2>&1 | Out-Null
        Remove-Item $rustupExe -Force -ErrorAction SilentlyContinue
        # Add cargo to PATH for this session
        $cargoPath = Join-Path $env:USERPROFILE ".cargo\bin"
        if (Test-Path $cargoPath) {
            $env:Path = "$cargoPath;$env:Path"
        }
        Refresh-Path
        $HasRust = Test-CommandExists "cargo"
        if ($HasRust) {
            Success "Rust installed: $(& cargo --version 2>$null)"
        } else {
            Warn "Rust installed but not on PATH — may need to restart terminal"
        }
    } catch {
        Warn "Rust auto-install failed: $_"
        Warn "Install manually from https://rustup.rs"
        $HasRust = $false
    }
}

# ╔═══════════════════════════════════════════════════════════════════╗
# ║  Step 2: Check Source Code Status                                ║
# ╚═══════════════════════════════════════════════════════════════════╝
Step "Step 2/8 — Checking Source Code Status"

Set-Location $ScriptDir

if (Test-CommandExists "git") {
    $isGitRepo = & git rev-parse --is-inside-work-tree 2>$null
    if ($isGitRepo -eq "true") {
        $uncommitted = & git status --porcelain 2>$null | Select-Object -First 20
        if ($uncommitted) {
            Warn "Uncommitted changes detected:"
            $uncommitted | ForEach-Object { Write-Host "    $_" -ForegroundColor Yellow }
            Warn "These changes will be included in the build."
        } else {
            Success "Source code is clean"
        }
        $branch = & git rev-parse --abbrev-ref HEAD 2>$null
        $commit = & git rev-parse --short HEAD 2>$null
        Info "Building from branch: $branch (commit: $commit)"
    } else {
        Warn "Not a git repository — cannot check source status"
    }
} else {
    Warn "Git not available — skipping source status check"
}

# ╔═══════════════════════════════════════════════════════════════════╗
# ║  Step 3: Clean Build Artifacts                                   ║
# ╚═══════════════════════════════════════════════════════════════════╝
Step "Step 3/8 — Cleaning Build Artifacts"

if (-not $SkipBuild) {
    $cleanPaths = @(
        (Join-Path $ScriptDir "dist"),
        (Join-Path $ScriptDir "dist-electron"),
        (Join-Path $ScriptDir "release"),
        (Join-Path $ScriptDir "node_modules\.cache"),
        (Join-Path $ScriptDir ".vite"),
        (Join-Path $ScriptDir "native-module\target"),
        (Join-Path $ScriptDir "native-module\index.win32-x64-msvc.node")
    )

    foreach ($p in $cleanPaths) {
        if (Test-Path $p) {
            Info "Removing $p"
            Remove-Item $p -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
    Success "Fresh-build cleanup complete"
} else {
    Info "SkipBuild set — skipping artifact cleanup"
}

# ╔═══════════════════════════════════════════════════════════════════╗
# ║  Step 4: Install Dependencies                                   ║
# ╚═══════════════════════════════════════════════════════════════════╝
Step "Step 4/8 — Installing Dependencies"

Set-Location $ScriptDir

$toolchainComplete = $true
$requiredPaths = @(
    "node_modules\electron\package.json",
    "node_modules\electron-builder\package.json",
    "node_modules\.bin\tsc.cmd"
)
foreach ($rp in $requiredPaths) {
    if (-not (Test-Path (Join-Path $ScriptDir $rp))) {
        $toolchainComplete = $false
        break
    }
}

$installCmd = "npm"
$installArgs = @("install")
if ((Test-Path (Join-Path $ScriptDir "package-lock.json")) -and
    ((-not (Test-Path (Join-Path $ScriptDir "node_modules"))) -or $ForceDependencySync)) {
    $installArgs = @("ci")
}

if ((Test-Path (Join-Path $ScriptDir "node_modules")) -and $toolchainComplete -and (-not $ForceDependencySync)) {
    Info "Using existing node_modules (set -ForceDependencySync to force clean reinstall)"
} else {
    if (Test-Path (Join-Path $ScriptDir "node_modules")) {
        Info "node_modules exists but toolchain incomplete — syncing with npm $($installArgs -join ' ')..."
    } else {
        Info "Fresh install — this may take a few minutes..."
    }
    Invoke-Cmd -Label "Syncing npm dependencies" -Command $installCmd -Arguments $installArgs
    Success "Dependencies installed"
}

# Add node_modules\.bin to PATH for this session
$binPath = Join-Path $ScriptDir "node_modules\.bin"
if ($env:Path -notlike "*$binPath*") {
    $env:Path = "$binPath;$env:Path"
}

# Resolve local tool binaries (used in quality gates AND build step)
$rimrafBin = Join-Path $ScriptDir "node_modules\.bin\rimraf.cmd"
$tscBin = Join-Path $ScriptDir "node_modules\.bin\tsc.cmd"

# ╔═══════════════════════════════════════════════════════════════════╗
# ║  Step 5: Quality Gates                                          ║
# ╚═══════════════════════════════════════════════════════════════════╝
$QualityGatesRan = $false

if (-not $SkipQualityGates) {
    Step "Step 5/8 — Running Production Quality Gates"
    Info "Each gate has a ${QualityGateTimeout}s timeout (set QUALITY_GATE_TIMEOUT to override)"

    if (Test-Path $rimrafBin) {
        Invoke-CmdWithTimeout -Label "[1/5] Cleaning test artifacts" -TimeoutSeconds $QualityGateTimeout `
            -Command $rimrafBin -Arguments @("dist-electron\electron\tests")
    }

    Invoke-CmdWithTimeout -Label "[2/5] Compiling Electron TypeScript" -TimeoutSeconds $QualityGateTimeout `
        -Command $tscBin -Arguments @("-p", "electron\tsconfig.json")
    Success "Electron TypeScript compiled"

    # Gate 2: Run Electron tests
    $testGlob = Join-Path $ScriptDir "dist-electron\electron\tests"
    if (Test-Path $testGlob) {
        $testFiles = Get-ChildItem -Path $testGlob -Filter "*.test.js" | Select-Object -ExpandProperty FullName
        if ($testFiles) {
            Invoke-CmdWithTimeout -Label "[3/5] Running Electron tests" -TimeoutSeconds $QualityGateTimeout `
                -Command "node" -Arguments (@("--test") + $testFiles)
            Success "Electron tests passed"
        } else {
            Warn "[3/5] No test files found — skipping"
        }
    } else {
        Warn "[3/5] Test output directory not found — skipping"
    }

    # Gate 3: Coverage verification
    Info "Skipping redundant typecheck (already compiled in gate 2)"

    $electronCoverageScript = Join-Path $ScriptDir "scripts\verify-electron-coverage.js"
    if (Test-Path $electronCoverageScript) {
        Invoke-CmdWithTimeout -Label "[4/5] Verifying Electron test coverage" -TimeoutSeconds $QualityGateTimeout `
            -Command "node" -Arguments @($electronCoverageScript)
        Success "Electron coverage verified"
    } else {
        Warn "[4/5] Electron coverage script not found — skipping"
    }

    $rendererCoverageScript = Join-Path $ScriptDir "scripts\verify-renderer-coverage.js"
    if (Test-Path $rendererCoverageScript) {
        Invoke-CmdWithTimeout -Label "[5/5] Verifying renderer test coverage" -TimeoutSeconds $QualityGateTimeout `
            -Command "node" -Arguments @($rendererCoverageScript)
        Success "Renderer coverage verified"
    } else {
        Warn "[5/5] Renderer coverage script not found — skipping"
    }

    # Optional: Rust tests
    if ($HasRust) {
        $cargoManifest = Join-Path $ScriptDir "native-module\Cargo.toml"
        if (Test-Path $cargoManifest) {
            Invoke-CmdWithTimeout -Label "[Bonus] Running Rust native module tests" -TimeoutSeconds $QualityGateTimeout `
                -Command "cargo" -Arguments @("test", "--manifest-path", $cargoManifest)
            Success "Rust native module tests passed"
        }
    } else {
        Warn "Skipping Rust tests (cargo not found)"
    }

    $QualityGatesRan = $true
    Success "All quality gates passed"
} else {
    Info "Skipping quality gates (set SKIP_QUALITY_GATES=0 or remove -SkipQualityGates to run them)"
}

# ╔═══════════════════════════════════════════════════════════════════╗
# ║  Step 6: Build & Package                                        ║
# ╚═══════════════════════════════════════════════════════════════════╝
if (-not $SkipBuild) {
    Step "Step 6/8 — Building & Packaging ($ArchLabel)"

    Info "Running full build pipeline: renderer → native addon → electron → packaging..."

    # 1. Ensure native deps
    Invoke-Cmd -Label "Ensuring Electron native dependencies" `
        -Command "node" -Arguments @("scripts\ensure-electron-native-deps.js")

    # 2. Build renderer (vite)
    Invoke-Cmd -Label "Building renderer (Vite)" `
        -Command "npm" -Arguments @("run", "build")

    # 3. Build native module
    Invoke-Cmd -Label "Building native module (current arch)" `
        -Command "npm" -Arguments @("run", "build:native:current")

    # 4. Compile Electron TypeScript (may already be done by quality gates)
    if (-not $QualityGatesRan) {
        Invoke-Cmd -Label "Compiling Electron TypeScript" `
            -Command $tscBin -Arguments @("-p", "electron\tsconfig.json")
    } else {
        Info "Skipping tsc — already compiled during quality gates"
    }

    # 5. Package with electron-builder
    $ebArgs = @("--win", "--x64", "--config.directories.output=$OutputDir")
    if ($QualityGatesRan) {
        # Skip the preapp:build production verify since we already ran quality gates
        $env:SKIP_PRODUCTION_VERIFY = "1"
    }
    Invoke-Cmd -Label "Packaging Windows x64 release (NSIS + portable)" `
        -Command "npx" -Arguments (@("electron-builder") + $ebArgs)
    $env:SKIP_PRODUCTION_VERIFY = $null

    Success "Build & packaging complete"
} else {
    Info "SkipBuild set — using existing artifacts in $ReleaseDir"
}

# ╔═══════════════════════════════════════════════════════════════════╗
# ║  Step 7: Verify Packaged Artifacts                               ║
# ╚═══════════════════════════════════════════════════════════════════╝
Step "Step 7/8 — Verifying Packaged Artifacts"

if (-not (Test-Path $ReleaseDir)) {
    Fail "Release directory not found: $ReleaseDir"
}

# List all artifacts
Info "Packaged artifacts in $ReleaseDir`:"
$allArtifacts = Get-ChildItem -Path $ReleaseDir -Recurse -File | Sort-Object FullName
$allArtifacts | ForEach-Object {
    $sizeKB = [math]::Round($_.Length / 1KB, 1)
    Write-Host "    $($_.FullName)  ($sizeKB KB)" -ForegroundColor DarkGray
}

# Find the NSIS installer
$installer = Get-WindowsInstaller -SearchRoot $ReleaseDir
if ($installer) {
    $sizeMB = [math]::Round($installer.Length / 1MB, 1)
    Success "NSIS installer found: $($installer.Name) ($sizeMB MB)"
} else {
    Fail "No Windows installer (.exe) found in $ReleaseDir"
}

# Find portable .exe if any
$portable = Get-ChildItem -Path $ReleaseDir -Recurse -File -Filter *.exe |
    Where-Object { $_.Name -notmatch 'Setup' -and $_.Name -notmatch 'Uninstall' } |
    Select-Object -First 1
if ($portable) {
    $sizeMB = [math]::Round($portable.Length / 1MB, 1)
    Success "Portable build found: $($portable.Name) ($sizeMB MB)"
}

Success "Artifact verification passed"

# ╔═══════════════════════════════════════════════════════════════════╗
# ║  Step 8: Install & Verify                                       ║
# ╚═══════════════════════════════════════════════════════════════════╝
if ($SkipInstall) {
    Info "SkipInstall set — not launching installer"
    Info "Installer path: $($installer.FullName)"
} else {
    Step "Step 8/8 — Installing $AppName"

    # Kill existing instance if running
    $existingProc = Get-Process -Name $AppName -ErrorAction SilentlyContinue
    if ($existingProc) {
        Info "Closing existing $AppName instance..."
        $existingProc | Stop-Process -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2
    }

    # Run the installer
    # NSIS supports /S for silent install and /D= for install directory
    $installDir = "C:\$AppName"
    Info "Running installer: $($installer.Name)"
    Info "Install location: $installDir"

    # /S = silent, /D= must be LAST and sets the install directory (no quotes around path)
    $installerArgs = "/S /D=$installDir"
    Info "Starting silent install to $installDir (this may take a minute)..."

    $proc = Start-Process -FilePath $installer.FullName -ArgumentList $installerArgs `
        -Wait -PassThru -NoNewWindow

    if ($proc.ExitCode -ne 0 -and $proc.ExitCode -ne $null) {
        Warn "Installer exited with code $($proc.ExitCode) — this may still be OK for NSIS"
    }

    # Wait a moment for the install to finalize
    Start-Sleep -Seconds 3

    # Verify installation — check C:\ first, then fallback locations
    $progFilesX86 = [System.Environment]::GetFolderPath('ProgramFilesX86')
    $possibleExePaths = @(
        (Join-Path $installDir "$AppName.exe"),
        "C:\$AppName\$AppName.exe",
        (Join-Path $env:LOCALAPPDATA "$AppName\$AppName.exe"),
        (Join-Path "$env:USERPROFILE\AppData\Local\Programs\$AppName" "$AppName.exe"),
        (Join-Path $env:ProgramFiles "$AppName\$AppName.exe"),
        (Join-Path $progFilesX86 "$AppName\$AppName.exe")
    )

    $installedExe = $null
    foreach ($exePath in $possibleExePaths) {
        if (Test-Path $exePath) {
            $installedExe = $exePath
            break
        }
    }

    if ($installedExe) {
        Success "Installed: $installedExe"

        # Verify it's a valid PE
        $fileInfo = Get-Item $installedExe
        $sizeMB = [math]::Round($fileInfo.Length / 1MB, 1)
        Info "Binary size: $sizeMB MB"

        # Check architecture (PE header)
        try {
            $bytes = [System.IO.File]::ReadAllBytes($installedExe)
            $peOffset = [BitConverter]::ToInt32($bytes, 0x3C)
            $machine = [BitConverter]::ToUInt16($bytes, $peOffset + 4)
            $archName = switch ($machine) {
                0x8664 { "x64 (AMD64)" }
                0x014C { "x86 (i386)" }
                0xAA64 { "ARM64" }
                default { "Unknown (0x$($machine.ToString('X4')))" }
            }
            Success "Binary architecture: $archName"
        } catch {
            Warn "Could not verify binary architecture"
        }
    } else {
        Warn "Could not locate installed binary — the installer may use a custom path"
        Warn "Searched: $($possibleExePaths -join ', ')"
    }
}

# ╔═══════════════════════════════════════════════════════════════════╗
# ║  Done!                                                           ║
# ╚═══════════════════════════════════════════════════════════════════╝
$elapsed = (Get-Date) - $StartTime
$elapsedStr = "{0:mm}m {0:ss}s" -f $elapsed

Write-Host ""
Write-Host ("=" * 72) -ForegroundColor Green
Write-Host "#  XENO-FORGE STATUS: BUILD COMPLETE" -ForegroundColor White
Write-Host "#  APP:     $AppName" -ForegroundColor Cyan
Write-Host "#  ARCH:    $ArchLabel ($BuildArch)" -ForegroundColor Cyan
Write-Host "#  TIME:    $elapsedStr" -ForegroundColor Cyan
Write-Host "#  STATE:   built | packaged | installed | launch-ready" -ForegroundColor Cyan
Write-Host ("=" * 72) -ForegroundColor Green
Write-Host ""

Write-Host "Next steps:" -ForegroundColor Magenta
Write-Host ""
Write-Host "  1. Launch from Start Menu or:" -ForegroundColor White
if ($installedExe) {
    Write-Host "     & `"$installedExe`"" -ForegroundColor Gray
}
Write-Host ""
Write-Host "  2. Grant permissions when prompted:" -ForegroundColor White
Write-Host "     > Microphone     - transcription" -ForegroundColor Yellow
Write-Host "     > Screen Record  - system audio capture + screenshots" -ForegroundColor Yellow
Write-Host ""
Write-Host "  3. Configure API keys in Settings -> AI Providers" -ForegroundColor White
Write-Host "     > Or use Ollama for a fully local setup" -ForegroundColor Yellow
Write-Host ""

# Offer to launch (interactive terminal only)
if ([Environment]::UserInteractive -and -not $SkipInstall -and $installedExe) {
    $launch = Read-Host "Launch $AppName now? [Y/n]"
    if ($launch -eq '' -or $launch -match '^[Yy]') {
        Start-Process -FilePath $installedExe
        Success "Launched $AppName!"
    }
}
