@echo off
REM ╔═══════════════════════════════════════════════════════════════════╗
REM ║ Natively — Fix Hidden Window (Stealth Mode Reset)                ║
REM ║ Usage: fix-hidden-window.bat                                      ║
REM ║                                                                   ║
REM ║ Problem: App runs but no window appears (stealth mode enabled)   ║
REM ║ Solution: Disables isUndetectable setting and relaunches app     ║
REM ╚═══════════════════════════════════════════════════════════════════╝

setlocal enabledelayedexpansion

REM ── Colors ──
set "NEON_GREEN=92m"
set "NEON_CYAN=36m"
set "NEON_RED=91m"
set "WHITE=97m"
set "STEEL=90m"

echo.
echo %NEON_CYAN%################################################################################
echo %NEON_CYAN%## Natively - Fix Hidden Window (Stealth Mode Reset)
echo %NEON_CYAN%################################################################################
echo.

REM ── Step 1: Kill any running Natively processes ──
echo %STEEL%[INFO] Killing any running Natively processes...
taskkill /f /im "Natively.exe" >nul 2>&1
timeout /t 2 /nobreak >nul
echo %NEON_GREEN%[ OK ] Processes terminated

REM ── Step 2: Fix settings.json ──
set "APPDATA_DIR=%APPDATA%\Natively"
set "SETTINGS_FILE=%APPDATA_DIR%\settings.json"

if not exist "%APPDATA_DIR%" (
    echo %NEON_RED%[FAIL] Natively app data directory not found at:
    echo         %APPDATA_DIR%
    echo.
    echo %STEEL%The app may not be installed or has never been launched.
    pause
    exit /b 1
)

echo %STEEL%[INFO] Current settings:
if exist "%SETTINGS_FILE%" (
    type "%SETTINGS_FILE%"
    echo.
) else (
    echo %STEEL%        No settings.json found (will create new one)
)

echo.
echo %STEEL%[INFO] Disabling stealth mode (isUndetectable = false)...
echo {> "%SETTINGS_FILE%"
echo   "isUndetectable": false>> "%SETTINGS_FILE%"
echo }>> "%SETTINGS_FILE%"

echo %NEON_GREEN%[ OK ] Settings updated

REM ── Step 3: Verify the fix ──
echo.
echo %STEEL%[INFO] Verifying settings...
type "%SETTINGS_FILE%"
echo.

REM ── Step 4: Launch the app ──
echo %NEON_CYAN%################################################################################
echo %NEON_CYAN%## Launching Natively with visible window...
echo %NEON_CYAN%################################################################################
echo.

REM Try installed location first
if exist "C:\Program Files\Natively\Natively.exe" (
    echo %NEON_GREEN%[ OK ] Launching from: C:\Program Files\Natively\Natively.exe
    start "" "C:\Program Files\Natively\Natively.exe"
) else (
    REM Try current directory
    if exist ".\release\win-unpacked\Natively.exe" (
        echo %NEON_GREEN%[ OK ] Launching from: .\release\win-unpacked\Natively.exe
        start "" ".\release\win-unpacked\Natively.exe"
    ) else (
        echo %NEON_RED%[FAIL] Natively.exe not found in expected locations.
        echo        Please launch the app manually.
        pause
        exit /b 1
    )
)

echo.
echo %NEON_GREEN%################################################################################
echo %NEON_GREEN%# WINDOW FIX COMPLETE
echo %NEON_GREEN%# Stealth mode disabled - window should now be visible
echo %NEON_GREEN%################################################################################
echo.
echo %STEEL%If the window still doesn't appear:
echo %STEAL%  1. Check Task Manager for Natively processes
echo %STEEL%  2. Run this script again to kill and relaunch
echo %STEEL%  3. Check %%APPDATA%%\Natively\settings.json manually
echo.
pause
