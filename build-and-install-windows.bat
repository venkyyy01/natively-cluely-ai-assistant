@echo off
REM ╔═══════════════════════════════════════════════════════════════════╗
REM ║ Natively — One-Click Build & Install for Windows (Batch Version) ║
REM ║ Usage: build-and-install-windows.bat                              ║
REM ║ Requirements: Node.js v20+, Git, VS Build Tools, Python 3.x       ║
REM ╚═══════════════════════════════════════════════════════════════════╝

setlocal enabledelayedexpansion
set "SCRIPT_DIR=%~dp0"
set "APP_NAME=Natively"
set "INSTALL_DIR=%ProgramFiles%\%APP_NAME%"
set "NODE_MIN_VERSION=20.0.0"

REM ── Colors ──
set "NEON_PINK=0m"
set "NEON_CYAN=36m"
set "NEON_GREEN=92m"
set "NEON_VIOLET=35m"
set "NEON_ORANGE=93m"
set "NEON_RED=91m"
set "WHITE=97m"
set "STEEL=90m"

REM ── Helper Functions ──
goto :main

:colorize
echo.%~1%~2%~3%~4%~5%~6%~7%~8%~9
exit /b 0

:info
echo %STEEL%[INFO]%~1
exit /b 0

:success
echo %NEON_GREEN%[ OK ]%~1
exit /b 0

:warn
echo %NEON_ORANGE%[WARN]%~1
exit /b 0

:fail
echo %NEON_RED%[FAIL]%~1
exit /b 1

:step
echo.
echo %NEON_VIOLET%################################################################################
echo %NEON_VIOLET%## %NEON_CYAN%%~1
echo %NEON_VIOLET%################################################################################
exit /b 0

REM ── Main Execution ──
:main
cd /d "%SCRIPT_DIR%"

REM Check Node.js
call :check_node
if %errorlevel% neq 0 (
    call :install_prereq "Node.js" "https://nodejs.org" "Download and install Node.js LTS (v20+)"
)

REM Check Git
where git >nul 2>&1
if %errorlevel% neq 0 (
    call :install_prereq "Git" "https://git-scm.com/download/win" "Download and install Git for Windows"
)

REM Check Python
where python >nul 2>&1
if %errorlevel% neq 0 (
    call :install_prereq "Python" "https://python.org" "Download and install Python 3.x"
)

REM Check Visual Studio Build Tools
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if exist "%VSWHERE%" (
    "%VSWHERE%" -latest -requires "Microsoft.VisualStudio.Component.VC.Tools.x86.x64" >nul 2>&1
    if %errorlevel% neq 0 (
        call :install_prereq "Visual Studio Build Tools" "https://visualstudio.microsoft.com/visual-cpp-build-tools/" "Install 'Desktop development with C++' workload"
    )
)

REM Clean build artifacts
call :step "Step 1/8 - Cleaning Build Artifacts"
if exist "%SCRIPT_DIR%dist" rmdir /s /q "%SCRIPT_DIR%dist"
if exist "%SCRIPT_DIR%dist-electron" rmdir /s /q "%SCRIPT_DIR%dist-electron"
if exist "%SCRIPT_DIR%release" rmdir /s /q "%SCRIPT_DIR%release"
call :success "Fresh-build cleanup complete"

REM Install dependencies
call :step "Step 2/8 - Installing Dependencies"
call :info "Installing npm dependencies..."
call npm install
if %errorlevel% neq 0 (
    call :fail "npm install failed"
)
call :success "Dependencies installed"

REM Quality gates
if "%SKIP_QUALITY_GATES%" neq "1" (
    call :step "Step 3/8 - Running Quality Gates"
    call :info "Running Electron tests..."
    call npm run test:electron
    if %errorlevel% neq 0 (
        call :warn "Electron tests failed, continuing anyway..."
    )
    call :success "Quality gates completed"
)

REM Build
call :step "Step 4/8 - Building & Packaging"
call :info "Running production build..."
call npm run dist
if %errorlevel% neq 0 (
    call :fail "Build failed"
)
call :success "Build complete"

REM Install
if "%SKIP_INSTALL%" neq "1" (
    call :step "Step 5/8 - Installing Application"
    
    REM Kill existing instance
    taskkill /f /im "%APP_NAME%.exe" >nul 2>&1
    
    REM Remove old installation
    if exist "%INSTALL_DIR%" (
        call :info "Removing previous installation..."
        rmdir /s /q "%INSTALL_DIR%"
    )
    
    REM Copy from unpacked
    if exist "%SCRIPT_DIR%release\win-unpacked" (
        call :info "Copying to %INSTALL_DIR%..."
        xcopy /E /I /Y "%SCRIPT_DIR%release\win-unpacked" "%INSTALL_DIR%"
        call :success "Installed to %INSTALL_DIR%"
        
        REM Create shortcuts
        call :info "Creating shortcuts..."
        echo Set oWS = WScript.CreateObject("WScript.Shell") > "%temp%\shortcut.vbs"
        echo sLinkFile = "%ProgramData%\Microsoft\Windows\Start Menu\Programs\%APP_NAME%.lnk" >> "%temp%\shortcut.vbs"
        echo Set oLink = oWS.CreateShortcut(sLinkFile) >> "%temp%\shortcut.vbs"
        echo oLink.TargetPath = "%INSTALL_DIR%\%APP_NAME%.exe" >> "%temp%\shortcut.vbs"
        echo oLink.WorkingDirectory = "%INSTALL_DIR%" >> "%temp%\shortcut.vbs"
        echo oLink.Save >> "%temp%\shortcut.vbs"
        cscript /nologo "%temp%\shortcut.vbs"
        del "%temp%\shortcut.vbs"
        call :success "Shortcuts created"
    )
)

REM Verify
call :step "Step 6/8 - Verifying Installation"
if exist "%INSTALL_DIR%\%APP_NAME%.exe" (
    call :success "Installation verified"
) else (
    call :fail "Installation verification failed"
)

REM Done
call :step "Step 7/8 - Installation Complete"
echo %NEON_GREEN%################################################################################
echo %NEON_GREEN%# ALIEN SHIPYARD STATUS: INSTALL COMPLETE
echo %NEON_GREEN%# APP  %WHITE%%INSTALL_DIR%\%APP_NAME%.exe
echo %NEON_GREEN%# STATE %WHITE%rebuilt | launch-ready
echo %NEON_GREEN%################################################################################

REM Launch prompt
set /p launch="Launch %APP_NAME% now? [Y/n]: "
if /i "%launch%"=="" set launch=Y
if /i "%launch%"=="Y" (
    call :success "Launching %APP_NAME%!"
    start "" "%INSTALL_DIR%\%APP_NAME%.exe"
)

exit /b 0

:check_node
node -v >nul 2>&1
exit /b %errorlevel%

:install_prereq
echo %NEON_RED%[FAIL] %~1 is required but not installed.
echo Download from: %~2
echo %~3
echo.
set /p open="Open download page? [Y/n]: "
if /i "%open%"=="" set open=Y
if /i "%open%"=="Y" (
    start %~2
    echo Opened %~2 in your browser. Install and re-run this script.
)
exit /b 1
