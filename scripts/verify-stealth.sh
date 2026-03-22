#!/bin/bash
# scripts/verify-stealth.sh
# Verification script for stealth properties
#
# Checks:
#   1. Process name appears as assistantservicesd
#   2. No Electron/Chromium signatures in bundle
#   3. Windows not in CGWindowList (when running)
#   4. Bundle ID looks system-like
#   5. LSUIElement is set (no dock icon)
#
# Usage:
#   ./scripts/verify-stealth.sh [path-to-app]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
APP="${1:-$PROJECT_ROOT/build/AssistantServices.app}"

echo "=== Stealth Verification ==="
echo "Target: $APP"
echo ""

PASS_COUNT=0
FAIL_COUNT=0
WARN_COUNT=0

pass() {
    echo "  ✓ PASS: $1"
    ((PASS_COUNT++))
}

fail() {
    echo "  ✗ FAIL: $1"
    ((FAIL_COUNT++))
}

warn() {
    echo "  ⚠ WARN: $1"
    ((WARN_COUNT++))
}

skip() {
    echo "  - SKIP: $1"
}

# Check if bundle exists
if [ ! -d "$APP" ]; then
    echo "ERROR: App bundle not found at $APP"
    echo ""
    echo "Build the app first with: ./scripts/build-macos.sh"
    exit 1
fi

# 1. Process name check
echo "1. Process name check..."
PROC_NAME=$(basename "$APP/Contents/MacOS/"* 2>/dev/null || echo "unknown")
if [ "$PROC_NAME" = "assistantservicesd" ]; then
    pass "Process name is 'assistantservicesd'"
elif [[ "$PROC_NAME" == *"assistant"* ]] || [[ "$PROC_NAME" == *"service"* ]]; then
    warn "Process name '$PROC_NAME' (consider using 'assistantservicesd')"
else
    fail "Process name '$PROC_NAME' is identifiable"
fi

# 2. Bundle ID check
echo ""
echo "2. Bundle ID check..."
BUNDLE_ID=$(defaults read "$APP/Contents/Info.plist" CFBundleIdentifier 2>/dev/null || echo "unknown")
if [[ "$BUNDLE_ID" == com.apple.* ]] || [[ "$BUNDLE_ID" == com.local.* ]] || [[ "$BUNDLE_ID" == *"Assistant"* ]]; then
    pass "Bundle ID '$BUNDLE_ID' looks system-like"
elif [[ "$BUNDLE_ID" == *"natively"* ]] || [[ "$BUNDLE_ID" == *"Natively"* ]]; then
    fail "Bundle ID '$BUNDLE_ID' is identifiable"
else
    warn "Bundle ID '$BUNDLE_ID' (consider using system-like ID)"
fi

# 3. LSUIElement check (no dock icon)
echo ""
echo "3. Dock visibility check..."
LS_UI_ELEMENT=$(defaults read "$APP/Contents/Info.plist" LSUIElement 2>/dev/null || echo "0")
if [ "$LS_UI_ELEMENT" = "1" ]; then
    pass "LSUIElement=1 (hidden from dock)"
else
    fail "LSUIElement is not set (visible in dock)"
fi

# 4. Electron/Chromium signature check
echo ""
echo "4. Electron/Chromium signature check..."
if grep -rq "Electron" "$APP" 2>/dev/null; then
    fail "Electron strings found in bundle"
elif grep -rq "Chromium" "$APP" 2>/dev/null; then
    fail "Chromium strings found in bundle"
elif grep -rq "node_modules" "$APP" 2>/dev/null; then
    warn "node_modules references found (may be acceptable)"
else
    pass "No Electron/Chromium strings found"
fi

# 5. Framework check
echo ""
echo "5. Framework check..."
if [ -d "$APP/Contents/Frameworks/Electron Framework.framework" ]; then
    fail "Electron Framework found"
elif [ -d "$APP/Contents/Frameworks/Chromium Embedded Framework.framework" ]; then
    fail "Chromium Embedded Framework found"
else
    pass "No Electron/Chromium frameworks"
fi

# 6. Binary analysis
echo ""
echo "6. Binary signature analysis..."
MAIN_BINARY="$APP/Contents/MacOS/assistantservicesd"
if [ -f "$MAIN_BINARY" ]; then
    # Check for Electron-related symbols
    if nm "$MAIN_BINARY" 2>/dev/null | grep -qi "electron"; then
        fail "Electron symbols found in binary"
    elif strings "$MAIN_BINARY" 2>/dev/null | grep -qi "electron"; then
        warn "Electron strings found in binary"
    else
        pass "No Electron references in main binary"
    fi
else
    skip "Main binary not found"
fi

# 7. Code signature check
echo ""
echo "7. Code signature check..."
if codesign -dv "$APP" 2>&1 | grep -q "Signature=adhoc"; then
    pass "Ad-hoc signature (no developer identity exposed)"
elif codesign -dv "$APP" 2>&1 | grep -q "valid on disk"; then
    warn "Has signature (may expose developer identity)"
else
    warn "No signature or invalid signature"
fi

echo ""
echo "=== Runtime Verification (requires app to be running) ==="

# Check if app is running
if pgrep -f "assistantservicesd" > /dev/null 2>&1; then
    echo ""
    echo "8. Runtime process check..."
    
    # Check process list
    if ps aux | grep "assistantservicesd" | grep -v grep > /dev/null 2>&1; then
        pass "Process appears as 'assistantservicesd' in process list"
    else
        skip "Process not found"
    fi
    
    # Check Activity Monitor visibility (via ps)
    echo ""
    echo "9. Process tree check..."
    PROC_INFO=$(ps aux | grep "assistantservicesd" | grep -v grep | head -1)
    if [ -n "$PROC_INFO" ]; then
        MEM=$(echo "$PROC_INFO" | awk '{print $6}')
        MEM_MB=$((MEM / 1024))
        if [ "$MEM_MB" -lt 200 ]; then
            pass "Memory footprint ${MEM_MB}MB (target: <200MB)"
        else
            warn "Memory footprint ${MEM_MB}MB (target: <200MB)"
        fi
    fi
    
    # Check CGWindowList
    echo ""
    echo "10. Window capture check..."
    WINDOW_CHECK=$(python3 -c "
import Quartz
windows = Quartz.CGWindowListCopyWindowInfo(Quartz.kCGWindowListOptionOnScreenOnly, Quartz.kCGNullWindowID)
found = []
for w in windows:
    owner = w.get('kCGWindowOwnerName', '')
    if 'assistant' in owner.lower() or 'natively' in owner.lower():
        found.append(owner)
if found:
    print('FOUND:' + ','.join(set(found)))
else:
    print('PASS')
" 2>/dev/null || echo "SKIP")
    
    if [[ "$WINDOW_CHECK" == "PASS" ]]; then
        pass "Windows not visible in CGWindowList"
    elif [[ "$WINDOW_CHECK" == "SKIP" ]]; then
        skip "Could not check CGWindowList (Python/Quartz not available)"
    else
        warn "Windows may be visible: ${WINDOW_CHECK#FOUND:}"
    fi
else
    echo ""
    echo "App not running. To test runtime properties:"
    echo "  1. Start the app: open \"$APP\""
    echo "  2. Run this script again"
    echo ""
    echo "Manual runtime checks:"
    echo "  ps aux | grep -i assistant  # Should show assistantservicesd"
    echo "  Activity Monitor should show 'assistantservicesd'"
fi

# Summary
echo ""
echo "=== Summary ==="
echo "Passed: $PASS_COUNT"
echo "Warnings: $WARN_COUNT"
echo "Failed: $FAIL_COUNT"
echo ""

if [ $FAIL_COUNT -gt 0 ]; then
    echo "Result: FAIL - stealth properties not met"
    exit 1
elif [ $WARN_COUNT -gt 0 ]; then
    echo "Result: PASS with warnings"
    exit 0
else
    echo "Result: PASS - all stealth properties verified"
    exit 0
fi
