#!/bin/bash
# scripts/build-macos.sh
# Full build orchestration for macOS native app
#
# Usage:
#   ./scripts/build-macos.sh
#
# Steps:
#   1. Build Swift host (release mode)
#   2. Build Node.js backend
#   3. Build React UI (if dist doesn't exist)
#   4. Create app bundle structure
#   5. Ad-hoc code sign (no Apple Developer account)
#   6. Bypass Gatekeeper with xattr

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
BUILD_DIR="$PROJECT_ROOT/build"
APP_NAME="AssistantServices"
APP_PATH="$BUILD_DIR/$APP_NAME.app"

echo "=== Building Natively (Native Architecture) ==="
echo "Project root: $PROJECT_ROOT"
echo ""

# Track timing
START_TIME=$(date +%s)

# 1. Build Swift host
echo "=== Step 1: Building Swift host (release mode) ==="
cd "$PROJECT_ROOT/swift-host"

# Check if Xcode toolchain is available
if ! command -v swift &> /dev/null; then
    echo "ERROR: Swift toolchain not found."
    echo "Please install Xcode or Swift toolchain."
    exit 1
fi

swift build -c release
SWIFT_BINARY=".build/release/assistantservicesd"

if [ ! -f "$SWIFT_BINARY" ]; then
    echo "ERROR: Swift build failed - binary not found at $SWIFT_BINARY"
    exit 1
fi
echo "Swift host built successfully"

# 2. Build Node.js backend
echo ""
echo "=== Step 2: Building Node.js backend ==="
cd "$PROJECT_ROOT/node-backend"

if [ ! -d "node_modules" ]; then
    echo "Installing dependencies..."
    pnpm install
fi

pnpm build
NODE_DIST="dist/main.js"

if [ ! -f "$NODE_DIST" ]; then
    echo "ERROR: Node.js build failed - dist/main.js not found"
    exit 1
fi
echo "Node.js backend built successfully"

# 3. Build React UI (if dist doesn't exist)
echo ""
echo "=== Step 3: Building React UI ==="
cd "$PROJECT_ROOT"

if [ ! -d "dist" ]; then
    echo "Building React UI..."
    pnpm build
else
    echo "React UI dist already exists, skipping build"
    echo "To rebuild, remove the dist/ directory first"
fi

# 4. Create app bundle structure
echo ""
echo "=== Step 4: Creating app bundle structure ==="
"$SCRIPT_DIR/assemble-bundle.sh"

# 5. Ad-hoc code sign
echo ""
echo "=== Step 5: Ad-hoc code signing ==="

if [ ! -d "$APP_PATH" ]; then
    echo "ERROR: App bundle not found at $APP_PATH"
    exit 1
fi

# Sign embedded executables first (inside out)
if [ -f "$APP_PATH/Contents/Resources/assistantd" ]; then
    echo "Signing assistantd..."
    codesign --force --sign - "$APP_PATH/Contents/Resources/assistantd" 2>/dev/null || true
fi

if [ -f "$APP_PATH/Contents/Frameworks/native.node" ]; then
    echo "Signing native.node..."
    codesign --force --sign - "$APP_PATH/Contents/Frameworks/native.node" 2>/dev/null || true
fi

# Sign the main bundle
echo "Signing main bundle..."
codesign --force --deep --sign - "$APP_PATH"
echo "App signed with ad-hoc signature"

# 6. Bypass Gatekeeper with xattr
echo ""
echo "=== Step 6: Removing quarantine attributes ==="
xattr -c "$APP_PATH"
echo "Quarantine attributes removed"

# Calculate total time
END_TIME=$(date +%s)
DURATION=$((END_TIME - START_TIME))

echo ""
echo "=== Build Complete ==="
echo "Duration: ${DURATION}s"
echo "App location: $APP_PATH"
echo ""
echo "To run:"
echo "  open \"$APP_PATH\""
echo ""
echo "To verify stealth properties:"
echo "  ./scripts/verify-stealth.sh"
